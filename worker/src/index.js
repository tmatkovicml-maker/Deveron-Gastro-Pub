// Deveron orders: table orders, takeaway orders and the loyalty programme.
//
// Guests (from deveronpub.com):
//   POST /api/order                    order from a table QR code
//   POST /api/takeaway                 takeaway order (name, phone, pickup time)
//   GET  /api/takeaway/:id?token=…     {state: new|accepted|rejected|done, ready_at}
//   GET  /api/loyalty?phone=…          loyalty discount for a phone number
// Waiter tablet (X-Waiter-Pin = WAITER_PIN):
//   GET  /api/orders                   open table and takeaway orders
//   POST /api/orders/:id/done          table order entered in the till
//   POST /api/takeaway/:id/accept      {minutes}  accept with ready time
//   POST /api/takeaway/:id/reject
//   POST /api/takeaway/:id/done        collected and paid (adds to loyalty spend)
// Owner (X-Admin-Pin = ADMIN_PIN):
//   GET  /api/admin/customers          customers, spend, consents
//   DELETE /api/admin/customers/:phone erase a customer (GDPR)
// Pages: /  waiter tablet · /admin  customers and loyalty
//
// Loyalty tiers come from LOYALTY_TIERS, e.g. "100:10,300:15" = from 100 € spent 10 % off,
// from 300 € 15 % off. Everything is stored in one Durable Object (SQLite).
import { DurableObject } from 'cloudflare:workers';
import WAITER_PAGE from './waiter.html';
import ADMIN_PAGE from './admin.html';

const SITE_ORIGINS = ['https://deveronpub.com', 'https://www.deveronpub.com'];
const TABLES = 40;
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const TAKEAWAY_FROM = 8 * 60, TAKEAWAY_UNTIL = 21 * 60 + 30;   // minutes of the day, Croatian time
const CLOSED_DAYS = [[12, 25]];                                // [month, day]
const DEFAULT_TIERS = '100:10,300:15';

// Current Croatian time as {md: month*100+day, min: minutes since midnight}
function zagrebNow() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Zagreb' }));
  return { month: d.getMonth() + 1, day: d.getDate(), min: d.getHours() * 60 + d.getMinutes() };
}
function takeawayOpen() {
  const z = zagrebNow();
  if (CLOSED_DAYS.some(([m, d]) => m === z.month && d === z.day)) return false;
  return z.min >= TAKEAWAY_FROM && z.min < TAKEAWAY_UNTIL;
}

function tiers(env) {
  return String(env.LOYALTY_TIERS || DEFAULT_TIERS).split(',')
    .map(t => t.split(':').map(Number)).filter(([a, p]) => a >= 0 && p > 0 && p < 100)
    .sort((a, b) => a[0] - b[0]);
}
function discountFor(spent, env) {
  let d = 0;
  for (const [at, pct] of tiers(env)) if (spent >= at) d = pct;
  return d;
}
function nextTier(spent, env) {
  const t = tiers(env).find(([at]) => spent < at);
  return t ? { at: t[0], discount: t[1] } : null;
}

// "091 234 5678" / "+385 91…" / "0038591…" -> "+38591…"
function normPhone(v) {
  let p = String(v || '').replace(/[^\d+]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  else if (p.startsWith('0')) p = '+385' + p.slice(1);
  else if (!p.startsWith('+')) p = '+' + p;
  return /^\+\d{8,15}$/.test(p) ? p : '';
}
const euros = v => { const m = String(v || '').match(/\d+(?:[.,]\d+)?/); return m ? parseFloat(m[0].replace(',', '.')) : 0; };
const fmtEur = x => x.toFixed(2).replace('.', ',') + ' €';

export class Orders extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL, tbl INTEGER NOT NULL,
      lang TEXT, note TEXT, lines TEXT NOT NULL, total TEXT, done INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS limits (k TEXT NOT NULL, at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS takeaway (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL, token TEXT NOT NULL,
      name TEXT, phone TEXT, email TEXT, pickup TEXT, lang TEXT, note TEXT, lines TEXT NOT NULL,
      total TEXT, discount INTEGER NOT NULL DEFAULT 0, loyalty INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'new', ready_at INTEGER, closed INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS customers (
      phone TEXT PRIMARY KEY, name TEXT, email TEXT, loyalty INTEGER NOT NULL DEFAULT 0,
      marketing INTEGER NOT NULL DEFAULT 0, consent_at INTEGER, spent REAL NOT NULL DEFAULT 0,
      orders INTEGER NOT NULL DEFAULT 0, created INTEGER, last_order INTEGER)`);
  }

  cleanup(now) {
    this.sql.exec('DELETE FROM orders WHERE created < ?', now - DAY);
    this.sql.exec('DELETE FROM limits WHERE at < ?', now - HOUR);
    this.sql.exec('DELETE FROM takeaway WHERE created < ?', now - 30 * DAY);
    // Customers who have not ordered for 2 years are removed
    this.sql.exec('DELETE FROM customers WHERE COALESCE(last_order, created) < ?', now - 730 * DAY);
  }

  count(k, since) {
    return this.sql.exec('SELECT COUNT(*) AS n FROM limits WHERE k = ? AND at >= ?', k, since).one().n;
  }

  add(order, ip) {
    const now = Date.now();
    this.cleanup(now);
    // Limits per 10 minutes: 5 orders per table, 60 per internet connection
    // (guests on the restaurant WiFi share one address)
    const since = now - 10 * 60 * 1000;
    if (this.count('t:' + order.table, since) >= 5 || this.count('ip:' + ip, since) >= 60) return { error: 'too_many', status: 429 };
    this.sql.exec('INSERT INTO limits (k, at) VALUES (?, ?), (?, ?)', 't:' + order.table, now, 'ip:' + ip, now);
    const row = this.sql.exec(
      'INSERT INTO orders (created, tbl, lang, note, lines, total) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      now, order.table, order.lang, order.note, JSON.stringify(order.lines), order.total
    ).one();
    return { id: row.id };
  }

  customer(phone) {
    return this.sql.exec('SELECT * FROM customers WHERE phone = ?', phone).toArray()[0] || null;
  }

  loyalty(phone) {
    const c = this.customer(phone);
    if (!c || !c.loyalty) return { member: false, discount: 0 };
    return { member: true, discount: discountFor(c.spent, this.env), next: nextTier(c.spent, this.env) };
  }

  addTakeaway(o, ip) {
    const now = Date.now();
    this.cleanup(now);
    // Max 3 takeaway orders per phone per hour and 20 per connection per 10 minutes
    if (this.count('p:' + o.phone, now - HOUR) >= 3 || this.count('tip:' + ip, now - 10 * 60 * 1000) >= 20) return { error: 'too_many', status: 429 };
    this.sql.exec('INSERT INTO limits (k, at) VALUES (?, ?), (?, ?)', 'p:' + o.phone, now, 'tip:' + ip, now);

    let c = this.customer(o.phone);
    if (o.loyalty || o.marketing) {
      if (!c) {
        this.sql.exec('INSERT INTO customers (phone, name, email, loyalty, marketing, consent_at, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
          o.phone, o.name, o.email, o.loyalty ? 1 : 0, o.marketing ? 1 : 0, now, now);
      } else {
        this.sql.exec('UPDATE customers SET name = ?, email = COALESCE(NULLIF(?, \'\'), email), loyalty = ?, marketing = ?, consent_at = ? WHERE phone = ?',
          o.name, o.email, o.loyalty ? 1 : 0, o.marketing ? 1 : 0, now, o.phone);
      }
      c = this.customer(o.phone);
    } else if (c) {
      // Guest unticked both boxes: consent withdrawn
      this.sql.exec('UPDATE customers SET loyalty = 0, marketing = 0 WHERE phone = ?', o.phone);
      c = this.customer(o.phone);
    }
    const member = !!(c && c.loyalty);
    const discount = member ? discountFor(c.spent, this.env) : 0;
    const token = crypto.randomUUID();
    const row = this.sql.exec(
      `INSERT INTO takeaway (created, token, name, phone, email, pickup, lang, note, lines, total, discount, loyalty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      now, token, o.name, o.phone, o.email, o.pickup, o.lang, o.note, JSON.stringify(o.lines), o.total, discount, member ? 1 : 0
    ).one();
    return { id: row.id, token, discount };
  }

  takeawayStatus(id, token) {
    const t = this.sql.exec('SELECT status AS state, ready_at, discount FROM takeaway WHERE id = ? AND token = ?', id, token).toArray()[0];
    return t || { error: 'not_found', status: 404 };
  }

  list() {
    this.cleanup(Date.now());
    const orders = this.sql.exec('SELECT * FROM orders WHERE done = 0 ORDER BY created').toArray()
      .map(o => ({ ...o, lines: JSON.parse(o.lines) }));
    const takeaway = this.sql.exec(`SELECT id, created, name, phone, pickup, lang, note, lines, total, discount, loyalty, status, ready_at
      FROM takeaway WHERE status IN ('new', 'accepted') ORDER BY created`).toArray()
      .map(o => {
        const total = euros(o.total);
        return { ...o, lines: JSON.parse(o.lines), to_pay: o.discount ? fmtEur(total * (100 - o.discount) / 100) : o.total };
      });
    return { orders, takeaway };
  }

  done(id) {
    this.sql.exec('UPDATE orders SET done = 1 WHERE id = ?', id);
    return { ok: true };
  }

  setTakeaway(id, action, minutes) {
    const t = this.sql.exec('SELECT * FROM takeaway WHERE id = ?', id).toArray()[0];
    if (!t) return { error: 'not_found', status: 404 };
    const now = Date.now();
    if (action === 'accept') {
      this.sql.exec("UPDATE takeaway SET status = 'accepted', ready_at = ? WHERE id = ?", now + minutes * 60 * 1000, id);
    } else if (action === 'reject') {
      this.sql.exec("UPDATE takeaway SET status = 'rejected', closed = ? WHERE id = ?", now, id);
    } else if (action === 'done') {
      if (t.status !== 'done') {
        this.sql.exec("UPDATE takeaway SET status = 'done', closed = ? WHERE id = ?", now, id);
        const paid = euros(t.total) * (100 - t.discount) / 100;
        this.sql.exec('UPDATE customers SET spent = spent + ?, orders = orders + 1, last_order = ? WHERE phone = ? AND loyalty = 1',
          Math.round(paid * 100) / 100, now, t.phone);
      }
    }
    return { ok: true };
  }

  customers() {
    return this.sql.exec('SELECT * FROM customers ORDER BY spent DESC').toArray()
      .map(c => ({ ...c, discount: c.loyalty ? discountFor(c.spent, this.env) : 0 }));
  }

  deleteCustomer(phone) {
    this.sql.exec('DELETE FROM customers WHERE phone = ?', phone);
    this.sql.exec("UPDATE takeaway SET name = '(obrisano)', phone = '', email = '' WHERE phone = ?", phone);
    return { ok: true };
  }
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

function cors(request, env) {
  const origin = request.headers.get('Origin');
  const extra = (env.EXTRA_ORIGINS || '').split(',').filter(Boolean);   // local testing only
  return SITE_ORIGINS.includes(origin) || extra.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' }
    : {};
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function validLines(lines) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 40) return null;
  const out = [];
  for (const l of lines) {
    const qty = parseInt(l?.qty, 10);
    const name = str(l?.name, 160);
    if (!name || !(qty >= 1 && qty <= 30)) return null;
    out.push({ qty, name, price: str(l?.price, 20) });
  }
  return out;
}

// Accept only a small, well-formed order
function validOrder(body) {
  const table = parseInt(body?.table, 10);
  if (!(table >= 1 && table <= TABLES)) return null;
  const lines = validLines(body.lines);
  if (!lines) return null;
  return { table, lines, note: str(body.note, 300), lang: str(body.lang, 4), total: str(body.total, 20) };
}

function validTakeaway(body) {
  const lines = validLines(body?.lines);
  const name = str(body?.name, 60);
  const phone = normPhone(body?.phone);
  const email = str(body?.email, 120);
  const pickup = str(body?.pickup, 5);
  if (!lines || !name || !phone) return null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  if (pickup !== 'asap') {
    const m = pickup.match(/^(\d{2}):(\d{2})$/);
    if (!m) return null;
    const min = +m[1] * 60 + +m[2];
    if (min < TAKEAWAY_FROM || min > TAKEAWAY_UNTIL) return null;
  }
  return { lines, name, phone, email, pickup, note: str(body.note, 300), lang: str(body.lang, 4),
    total: str(body.total, 20), loyalty: body.loyalty === true, marketing: body.marketing === true };
}

// null = PIN matches; otherwise the error to return
function pinError(request, env, name = 'WAITER_PIN', header = 'X-Waiter-Pin') {
  const expected = String(env[name] || '').trim();
  if (!expected) return 'no_pin';
  return (request.headers.get(header) || '').trim() === expected ? null : 'pin';
}

const html = page => new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const store = env.ORDERS.get(env.ORDERS.idFromName('deveron'));
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    const c = cors(request, env);

    if (request.method === 'OPTIONS' && path.startsWith('/api/')) return new Response(null, { status: 204, headers: c });

    // ---- guests ----
    if (path === '/api/order' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, c); }
      const order = validOrder(body);
      if (!order) return json({ error: 'invalid' }, 400, c);
      const res = await store.add(order, ip);
      return json(res, res.status || 200, c);
    }

    if (path === '/api/takeaway' && request.method === 'POST') {
      if (!takeawayOpen()) return json({ error: 'closed' }, 403, c);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, c); }
      const o = validTakeaway(body);
      if (!o) return json({ error: 'invalid' }, 400, c);
      const res = await store.addTakeaway(o, ip);
      return json(res, res.status || 200, c);
    }

    let m = path.match(/^\/api\/takeaway\/(\d+)$/);
    if (m && request.method === 'GET') {
      const res = await store.takeawayStatus(+m[1], url.searchParams.get('token') || '');
      return json(res, res.status || 200, { ...c, 'Cache-Control': 'no-store' });
    }

    if (path === '/api/loyalty' && request.method === 'GET') {
      const phone = normPhone(url.searchParams.get('phone'));
      if (!phone) return json({ member: false, discount: 0 }, 200, c);
      return json(await store.loyalty(phone), 200, { ...c, 'Cache-Control': 'no-store' });
    }

    // ---- waiter tablet ----
    if (path === '/api/orders' && request.method === 'GET') {
      const err = pinError(request, env);
      if (err) return json({ error: err }, 401);
      return json({ ...(await store.list()), now: Date.now() });
    }

    m = path.match(/^\/api\/orders\/(\d+)\/done$/);
    if (m && request.method === 'POST') {
      const err = pinError(request, env);
      if (err) return json({ error: err }, 401);
      return json(await store.done(+m[1]));
    }

    m = path.match(/^\/api\/takeaway\/(\d+)\/(accept|reject|done)$/);
    if (m && request.method === 'POST') {
      const err = pinError(request, env);
      if (err) return json({ error: err }, 401);
      let minutes = 20;
      if (m[2] === 'accept') {
        try { minutes = Math.min(180, Math.max(5, parseInt((await request.json()).minutes, 10) || 20)); } catch {}
      }
      const res = await store.setTakeaway(+m[1], m[2], minutes);
      return json(res, res.status || 200);
    }

    // ---- owner ----
    if (path === '/api/admin/customers' && request.method === 'GET') {
      const err = pinError(request, env, 'ADMIN_PIN', 'X-Admin-Pin');
      if (err) return json({ error: err }, 401);
      return json({ customers: await store.customers(), tiers: tiers(env) });
    }

    m = path.match(/^\/api\/admin\/customers\/([^/]+)$/);
    if (m && request.method === 'DELETE') {
      const err = pinError(request, env, 'ADMIN_PIN', 'X-Admin-Pin');
      if (err) return json({ error: err }, 401);
      return json(await store.deleteCustomer(decodeURIComponent(m[1])));
    }

    if (path === '/' || path === '/konobar') return html(WAITER_PAGE);
    if (path === '/admin') return html(ADMIN_PAGE);
    return new Response('Not found', { status: 404 });
  },
};
