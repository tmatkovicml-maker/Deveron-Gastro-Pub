// Deveron table orders.
//   POST /api/order              guest sends an order from a table (public)
//   GET  /api/orders             open orders for the waiter tablet (PIN)
//   POST /api/orders/:id/done    waiter marks an order as entered in the till (PIN)
//   GET  /                       waiter tablet page
// Orders are kept in one Durable Object (SQLite) and deleted after 24 hours.
import { DurableObject } from 'cloudflare:workers';
import WAITER_PAGE from './waiter.html';

const SITE_ORIGINS = ['https://deveronpub.com', 'https://www.deveronpub.com'];
const TABLES = 40;
const DAY = 24 * 3600 * 1000;

export class Orders extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL, tbl INTEGER NOT NULL,
      lang TEXT, note TEXT, lines TEXT NOT NULL, total TEXT, done INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS limits (k TEXT NOT NULL, at INTEGER NOT NULL)`);
  }

  cleanup(now) {
    this.sql.exec('DELETE FROM orders WHERE created < ?', now - DAY);
    this.sql.exec('DELETE FROM limits WHERE at < ?', now - 10 * 60 * 1000);
  }

  add(order, ip) {
    const now = Date.now();
    this.cleanup(now);
    // Limits per 10 minutes: 5 orders per table, 60 per internet connection
    // (guests on the restaurant WiFi share one address)
    const count = k => this.sql.exec('SELECT COUNT(*) AS n FROM limits WHERE k = ?', k).one().n;
    if (count('t:' + order.table) >= 5 || count('ip:' + ip) >= 60) return { error: 'too_many', status: 429 };
    this.sql.exec('INSERT INTO limits (k, at) VALUES (?, ?), (?, ?)', 't:' + order.table, now, 'ip:' + ip, now);
    const row = this.sql.exec(
      'INSERT INTO orders (created, tbl, lang, note, lines, total) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      now, order.table, order.lang, order.note, JSON.stringify(order.lines), order.total
    ).one();
    return { id: row.id };
  }

  list() {
    this.cleanup(Date.now());
    return this.sql.exec('SELECT * FROM orders WHERE done = 0 ORDER BY created').toArray()
      .map(o => ({ ...o, lines: JSON.parse(o.lines) }));
  }

  done(id) {
    this.sql.exec('UPDATE orders SET done = 1 WHERE id = ?', id);
    return { ok: true };
  }
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

function cors(request, env) {
  const origin = request.headers.get('Origin');
  const extra = (env.EXTRA_ORIGINS || '').split(',').filter(Boolean);   // local testing only
  return SITE_ORIGINS.includes(origin) || extra.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' }
    : {};
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Accept only a small, well-formed order
function validOrder(body) {
  const table = parseInt(body?.table, 10);
  if (!(table >= 1 && table <= TABLES)) return null;
  if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 40) return null;
  const lines = [];
  for (const l of body.lines) {
    const qty = parseInt(l?.qty, 10);
    const name = str(l?.name, 160);
    if (!name || !(qty >= 1 && qty <= 30)) return null;
    lines.push({ qty, name, price: str(l?.price, 20) });
  }
  return { table, lines, note: str(body.note, 300), lang: str(body.lang, 4), total: str(body.total, 20) };
}

function pinOk(request, env) {
  const pin = request.headers.get('X-Waiter-Pin') || '';
  return !!env.WAITER_PIN && pin === env.WAITER_PIN;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const store = env.ORDERS.get(env.ORDERS.idFromName('deveron'));

    if (url.pathname === '/api/order') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request, env) });
      if (request.method !== 'POST') return json({ error: 'method' }, 405);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, cors(request, env)); }
      const order = validOrder(body);
      if (!order) return json({ error: 'invalid' }, 400, cors(request, env));
      const ip = request.headers.get('CF-Connecting-IP') || 'local';
      const res = await store.add(order, ip);
      return json(res, res.status || 200, cors(request, env));
    }

    if (url.pathname === '/api/orders' && request.method === 'GET') {
      if (!pinOk(request, env)) return json({ error: 'pin' }, 401);
      return json({ orders: await store.list(), now: Date.now() });
    }

    const m = url.pathname.match(/^\/api\/orders\/(\d+)\/done$/);
    if (m && request.method === 'POST') {
      if (!pinOk(request, env)) return json({ error: 'pin' }, 401);
      return json(await store.done(parseInt(m[1], 10)));
    }

    if (url.pathname === '/' || url.pathname === '/konobar') {
      return new Response(WAITER_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    return new Response('Not found', { status: 404 });
  },
};
