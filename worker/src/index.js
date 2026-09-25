// Deveron orders: table orders, takeaway orders and an anonymous loyalty card.
//
// Guests (from deveronpub.com):
//   POST /api/order                    order from a table QR code
//   POST /api/takeaway                 takeaway order (name, phone, pickup time, optional loyalty card)
//   GET  /api/takeaway/:id?token=…     {state: new|accepted|rejected|done, ready_at}
//   GET  /api/loyalty?card=DEV-XXXX-XXXX  discount and spend of a loyalty card
//   GET  /api/status                   {takeaway, ai, soldout} – switches and today's sold-out items
//   POST /api/chat                     {messages, lang} → {reply}  AI assistant (Claude)
//   POST /api/call                     {table, kind: waiter|bill, pay?: cash|card}  call the waiter / ask for the bill
//   GET  /api/tables                   [{id, name, area}] – table names for the QR cards and the site
//   POST /api/reservation              {day, time, guests, area, name, phone, note, lang} → {id, token}
//   GET  /api/reservation/:id?token=   {state: new|confirmed|rejected|cancelled|arrived|noshow, tables}
//   POST /api/reservation/:id/cancel   {token}  guest cancels
// Tables are kept by a fixed id (the number in the QR code, ?stol=12); the name, place on the
// floor plan and seats can be changed in the admin page without reprinting the QR cards.
// Waiter tablet (X-Waiter-Pin = WAITER_PIN):
//   GET  /api/orders                   open table and takeaway orders
//   POST /api/orders/:id/done          table order entered in the till
//   POST /api/takeaway/:id/accept      {minutes}  accept with ready time
//   POST /api/takeaway/:id/reject
//   POST /api/takeaway/:id/done        collected and paid (adds to the loyalty card)
//   POST /api/calls/:id/done           guest's call handled
//   GET  /api/menu-names               dishes and drinks for the sold-out list
//   POST /api/soldout                  {name, on}  mark an item sold out for today
//   GET  /api/reservations?day=        reservations of a day (plus all waiting for confirmation)
//   POST /api/reservations             phone booking {day, time, guests, name, phone, note, tables}
//   POST /api/reservations/:id/(confirm|reject|arrived|noshow|cancel)  {tables?}
// Admins (X-Admin-Pin = ADMIN_PIN or OWNER_PIN, two separate logins with the same rights):
//   GET  /api/admin/orders?from=&to=   all table and takeaway orders in a period
//   GET  /api/admin/cards              loyalty cards
//   DELETE /api/admin/cards/:code
//   POST /api/admin/settings           {takeaway?, ai?} – pause / resume takeaway orders and the AI assistant
//   GET|POST /api/admin/tables         floor plan: [{id, name, area, x, y, seats}]
// Pages: /  waiter tablet · /admin  orders and loyalty cards
//
// Loyalty is anonymous: a card is only a random code kept on the guest's phone plus the
// amount spent. Takeaway orders need a name and phone for pickup; these are removed after
// 7 days, the anonymous order stays for the statistics. Tiers come from LOYALTY_TIERS,
// e.g. "100:10,300:15" = from 100 € spent 10 % off, from 300 € 15 % off.
// Everything is stored in one Durable Object (SQLite).
import { DurableObject } from 'cloudflare:workers';
import WAITER_PAGE from './waiter.html';
import ADMIN_PAGE from './admin.html';
import { askClaude, validChat, menuNames } from './ai.js';

const SITE_ORIGINS = ['https://deveronpub.com', 'https://www.deveronpub.com'];
// Terrace as in the till (x, y = centre in per cent of the floor plan); ids stay the QR numbers
const DEFAULT_TABLES = [[1,"S-1",6.2,67.2],[2,"S-2",16.3,67.2],[3,"S-3",26.3,67.2],[4,"S-4",36.4,67.2],[5,"S-5",5.7,53.6],[6,"S-6",15.8,53.6],[7,"S-7",26,53.6],[8,"S-8",35.9,53.6],[9,"S-9",45.4,53.6],[10,"S-10",6.6,38.8],[11,"S-11",30.8,38.8],[12,"S-12",5.7,21.3],[13,"S-13",29.2,21.3],[14,"S-14",44,21.3],[15,"S-15",55.6,67.2],[16,"S-16",67.9,67.2],[17,"S-17",80.9,67.2],[18,"S-18",92.6,67.2],[19,"S-19",55.4,53.6],[20,"S-20",67.4,53.6],[21,"S-21",80.7,53.6],[22,"S-22",92.8,53.6],[23,"S-23",55.7,38.8],[24,"S-24",67.7,38.8],[25,"S-25",80.9,38.8],[26,"S-26",92.8,38.8],[27,"S-27",55.3,21.3],[28,"S-28",67.8,21.3],[29,"S-29",80.7,21.3],[30,"S-30",93.2,21.3],[31,"S-31",9.5,92.9],[32,"S-32",20.1,92.9],[33,"S-33",79,92.9],[34,"S-34",90.6,92.9],[35,"VATRA 1",17.8,38.8],[36,"VATRA 2",16,21.3],[37,"DINO 05",46.1,92.9]];
const AREAS = ['terasa', 'restoran'];
// Online reservations: every 30 min from 12:00 to 21:30, up to 12 guests, 60 days ahead,
// at least an hour in advance. Name and phone are removed 30 days after the visit.
const RES_FROM = 12 * 60, RES_UNTIL = 21 * 60 + 30, RES_STEP = 30, RES_MAX_GUESTS = 12, RES_DAYS = 60;
const KEEP_RES_CONTACT_DAYS = 30;
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const KEEP_ORDERS = 365 * DAY, KEEP_CONTACT = 7 * DAY, KEEP_CARDS = 730 * DAY;
const TAKEAWAY_FROM = 8 * 60, TAKEAWAY_UNTIL = 21 * 60 + 30;   // minutes of the day, Croatian time
const CLOSED_DAYS = [[12, 25]];                                // [month, day]
const DEFAULT_TIERS = '100:10,300:15';
const CARD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';        // no 0/O, 1/I
const dailyLimit = env => parseInt(env.AI_DAILY_LIMIT, 10) || 300;   // AI questions per day

function zagrebNow() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Zagreb' }));
  return { month: d.getMonth() + 1, day: d.getDate(), min: d.getHours() * 60 + d.getMinutes() };
}
// "2026-09-25" in Croatian time; sold-out marks only count for that day
function zagrebDay() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Zagreb' });
}
const addDays = (day, n) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isClosedDay = day => CLOSED_DAYS.some(([m, d]) => +day.slice(5, 7) === m && +day.slice(8, 10) === d);
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

function newCardCode() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  const c = [...b].map(x => CARD_CHARS[x % CARD_CHARS.length]).join('');
  return `DEV-${c.slice(0, 4)}-${c.slice(4)}`;
}
// "dev 7k3q9xw2" -> "DEV-7K3Q-9XW2"
function normCard(v) {
  const c = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^DEV/, '');
  return c.length === 8 ? `DEV-${c.slice(0, 4)}-${c.slice(4)}` : '';
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
const toPay = (total, discount) => discount ? fmtEur(euros(total) * (100 - discount) / 100) : total;

export class Orders extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL, tbl INTEGER NOT NULL,
      lang TEXT, note TEXT, lines TEXT NOT NULL, total TEXT, done INTEGER NOT NULL DEFAULT 0)`);
    const cols = this.sql.exec('PRAGMA table_info(orders)').toArray().map(c => c.name);
    if (!cols.includes('done_at')) this.sql.exec('ALTER TABLE orders ADD COLUMN done_at INTEGER');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS limits (k TEXT NOT NULL, at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS takeaway (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL, token TEXT NOT NULL,
      name TEXT, phone TEXT, pickup TEXT, lang TEXT, note TEXT, lines TEXT NOT NULL,
      total TEXT, discount INTEGER NOT NULL DEFAULT 0, card TEXT,
      status TEXT NOT NULL DEFAULT 'new', ready_at INTEGER, closed INTEGER)`);
    // Settings changed from the admin page; takeaway starts paused until switched on
    this.sql.exec(`CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec("INSERT OR IGNORE INTO settings (k, v) VALUES ('takeaway', '0'), ('ai', '1'), ('ai_day', ''), ('res', '0')");
    this.sql.exec('CREATE TABLE IF NOT EXISTS soldout (name TEXT PRIMARY KEY, day TEXT NOT NULL)');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL, token TEXT NOT NULL, source TEXT NOT NULL,
      day TEXT NOT NULL, time TEXT NOT NULL, guests INTEGER NOT NULL, area TEXT, name TEXT, phone TEXT, note TEXT,
      lang TEXT, status TEXT NOT NULL DEFAULT 'new', tables TEXT NOT NULL DEFAULT '[]', decided INTEGER)`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS res_day ON reservations (day)');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tables (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, area TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL,
      seats INTEGER NOT NULL DEFAULT 4)`);
    if (!this.sql.exec('SELECT COUNT(*) AS n FROM tables').one().n) {
      for (const [id, name, x, y] of DEFAULT_TABLES)
        this.sql.exec('INSERT INTO tables (id, name, area, x, y, seats) VALUES (?, ?, ?, ?, ?, 4)', id, name, 'terasa', x, y);
    }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL, tbl INTEGER NOT NULL,
      kind TEXT NOT NULL, pay TEXT, done INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS cards (
      code TEXT PRIMARY KEY, spent REAL NOT NULL DEFAULT 0, orders INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL, last_used INTEGER)`);
  }

  cleanup(now) {
    this.sql.exec('DELETE FROM limits WHERE at < ?', now - HOUR);
    this.sql.exec('DELETE FROM orders WHERE created < ?', now - KEEP_ORDERS);
    this.sql.exec('DELETE FROM takeaway WHERE created < ?', now - KEEP_ORDERS);
    // Name and phone are only needed for pickup
    this.sql.exec("UPDATE takeaway SET name = '', phone = '' WHERE created < ? AND phone != ''", now - KEEP_CONTACT);
    this.sql.exec('DELETE FROM cards WHERE COALESCE(last_used, created) < ?', now - KEEP_CARDS);
    this.sql.exec('DELETE FROM calls WHERE created < ?', now - DAY);
    this.sql.exec('DELETE FROM reservations WHERE created < ?', now - KEEP_ORDERS);
    this.sql.exec("UPDATE reservations SET name = '', phone = '' WHERE day < ? AND phone != ''", addDays(zagrebDay(), -KEEP_RES_CONTACT_DAYS));
  }

  // ---- reservations ----
  resEnabled() {
    return this.setting('res') === '1';
  }

  resRow(r) {
    const names = this.tableNames();
    const ids = JSON.parse(r.tables || '[]');
    return { ...r, tables: ids, table_names: ids.map(i => names[i] || String(i)) };
  }

  addReservation(r, ip) {
    if (!this.resEnabled()) return { error: 'paused', status: 403 };
    const now = Date.now();
    this.cleanup(now);
    if (this.count('rp:' + r.phone, now - DAY) >= 3 || this.count('rip:' + ip, now - 10 * 60 * 1000) >= 10) return { error: 'too_many', status: 429 };
    this.sql.exec('INSERT INTO limits (k, at) VALUES (?, ?), (?, ?)', 'rp:' + r.phone, now, 'rip:' + ip, now);
    const token = crypto.randomUUID();
    const row = this.sql.exec(`INSERT INTO reservations (created, token, source, day, time, guests, area, name, phone, note, lang)
      VALUES (?, ?, 'web', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      now, token, r.day, r.time, r.guests, r.area, r.name, r.phone, r.note, r.lang).one();
    return { id: row.id, token };
  }

  // Phone booking entered on the tablet: confirmed straight away
  addPhoneReservation(r) {
    const row = this.sql.exec(`INSERT INTO reservations (created, token, source, day, time, guests, area, name, phone, note, lang, status, tables, decided)
      VALUES (?, ?, 'phone', ?, ?, ?, '', ?, ?, ?, 'HR', 'confirmed', ?, ?) RETURNING id`,
      Date.now(), crypto.randomUUID(), r.day, r.time, r.guests, r.name, r.phone, r.note, JSON.stringify(r.tables), Date.now()).one();
    return { id: row.id };
  }

  reservationStatus(id, token) {
    const r = this.sql.exec('SELECT * FROM reservations WHERE id = ? AND token = ?', id, token).toArray()[0];
    if (!r) return { error: 'not_found', status: 404 };
    const x = this.resRow(r);
    return { state: x.status, day: x.day, time: x.time, guests: x.guests, tables: x.table_names };
  }

  cancelReservation(id, token) {
    const r = this.sql.exec('SELECT status FROM reservations WHERE id = ? AND token = ?', id, token).toArray()[0];
    if (!r) return { error: 'not_found', status: 404 };
    if (r.status === 'new' || r.status === 'confirmed')
      this.sql.exec("UPDATE reservations SET status = 'cancelled', decided = ? WHERE id = ?", Date.now(), id);
    return { ok: true };
  }

  reservations(day) {
    const rows = this.sql.exec(`SELECT * FROM reservations WHERE day = ? OR (status = 'new' AND day >= ?)
      ORDER BY day, time, id`, day, zagrebDay()).toArray();
    return { reservations: rows.map(r => this.resRow(r)), tables: this.tables(), day };
  }

  setReservation(id, action, tables) {
    const r = this.sql.exec('SELECT * FROM reservations WHERE id = ?', id).toArray()[0];
    if (!r) return { error: 'not_found', status: 404 };
    const status = { confirm: 'confirmed', reject: 'rejected', arrived: 'arrived', noshow: 'noshow', cancel: 'cancelled' }[action];
    if (action === 'confirm') {
      const known = this.tableNames();
      const ids = (tables || []).filter(i => known[i]);
      this.sql.exec('UPDATE reservations SET status = ?, tables = ?, decided = ? WHERE id = ?', status, JSON.stringify(ids), Date.now(), id);
    } else {
      this.sql.exec('UPDATE reservations SET status = ?, decided = ? WHERE id = ?', status, Date.now(), id);
    }
    return { ok: true };
  }

  resHistory(from, to) {
    return this.sql.exec('SELECT * FROM reservations WHERE day >= ? AND day <= ? ORDER BY day, time', from, to).toArray()
      .map(r => this.resRow(r));
  }

  // ---- tables and floor plan ----
  tables() {
    return this.sql.exec('SELECT * FROM tables ORDER BY id').toArray();
  }

  tableNames() {
    return Object.fromEntries(this.tables().map(t => [t.id, t.name]));
  }

  saveTables(list) {
    this.sql.exec('DELETE FROM tables');
    for (const t of list)
      this.sql.exec('INSERT INTO tables (id, name, area, x, y, seats) VALUES (?, ?, ?, ?, ?, ?)', t.id, t.name, t.area, t.x, t.y, t.seats);
    return { tables: this.tables() };
  }

  // ---- sold out today (resets by itself the next day) ----
  soldout() {
    const today = zagrebDay();
    this.sql.exec('DELETE FROM soldout WHERE day != ?', today);
    return this.sql.exec('SELECT name FROM soldout ORDER BY name').toArray().map(r => r.name);
  }

  setSoldout(name, on) {
    if (on) this.sql.exec('INSERT OR REPLACE INTO soldout (name, day) VALUES (?, ?)', name, zagrebDay());
    else this.sql.exec('DELETE FROM soldout WHERE name = ?', name);
    return { soldout: this.soldout() };
  }

  // Order lines are "Naziv HR" or "Naziv HR (0,5 L)"
  soldoutIn(lines) {
    const sold = this.soldout();
    return lines.map(l => l.name).filter(n => sold.some(s => n === s || n.startsWith(s + ' (')));
  }

  // ---- guest calls the waiter or asks for the bill ----
  addCall(c, ip) {
    if (!this.tableNames()[c.table]) return { error: 'no_table', status: 400 };
    const now = Date.now();
    this.cleanup(now);
    const open = this.sql.exec('SELECT id FROM calls WHERE tbl = ? AND kind = ? AND done = 0 AND created >= ?',
      c.table, c.kind, now - 2 * HOUR).toArray()[0];
    if (open) {
      if (c.pay) this.sql.exec('UPDATE calls SET pay = ? WHERE id = ?', c.pay, open.id);
      return { id: open.id };
    }
    if (this.count('call:' + ip, now - 10 * 60 * 1000) >= 20) return { error: 'too_many', status: 429 };
    this.sql.exec('INSERT INTO limits (k, at) VALUES (?, ?)', 'call:' + ip, now);
    const row = this.sql.exec('INSERT INTO calls (created, tbl, kind, pay) VALUES (?, ?, ?, ?) RETURNING id',
      now, c.table, c.kind, c.pay).one();
    return { id: row.id };
  }

  callDone(id) {
    this.sql.exec('UPDATE calls SET done = 1 WHERE id = ?', id);
    return { ok: true };
  }

  count(k, since) {
    return this.sql.exec('SELECT COUNT(*) AS n FROM limits WHERE k = ? AND at >= ?', k, since).one().n;
  }

  add(order, ip) {
    const now = Date.now();
    this.cleanup(now);
    // Limits per 10 minutes: 5 orders per table, 60 per internet connection
    // (guests on the restaurant WiFi share one address)
    if (!this.tableNames()[order.table]) return { error: 'no_table', status: 400 };
    const sold = this.soldoutIn(order.lines);
    if (sold.length) return { error: 'soldout', items: sold, status: 409 };
    const since = now - 10 * 60 * 1000;
    if (this.count('t:' + order.table, since) >= 5 || this.count('ip:' + ip, since) >= 60) return { error: 'too_many', status: 429 };
    this.sql.exec('INSERT INTO limits (k, at) VALUES (?, ?), (?, ?)', 't:' + order.table, now, 'ip:' + ip, now);
    const row = this.sql.exec(
      'INSERT INTO orders (created, tbl, lang, note, lines, total) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      now, order.table, order.lang, order.note, JSON.stringify(order.lines), order.total
    ).one();
    return { id: row.id };
  }

  takeawayEnabled() {
    return this.sql.exec("SELECT v FROM settings WHERE k = 'takeaway'").one().v === '1';
  }

  setting(k) {
    return this.sql.exec('SELECT v FROM settings WHERE k = ?', k).one().v;
  }

  aiEnabled() {
    return this.setting('ai') === '1' && !!this.env.ANTHROPIC_API_KEY;
  }

  status(table) {
    const res = { takeaway: this.takeawayEnabled(), ai: this.aiEnabled(), soldout: this.soldout(), reservations: this.resEnabled() };
    if (table) res.table = this.tableNames()[table] || null;
    return res;
  }

  // For the admin page: switches plus today's AI usage
  adminStatus() {
    const [day, n] = (this.setting('ai_day') || ':0').split(':');
    return { ...this.status(), ai_switch: this.setting('ai') === '1', ai_key: !!this.env.ANTHROPIC_API_KEY,
      ai_today: day === new Date().toISOString().slice(0, 10) ? +n : 0, ai_limit: dailyLimit(this.env) };
  }

  setSettings(s) {
    if (typeof s.takeaway === 'boolean') this.sql.exec("UPDATE settings SET v = ? WHERE k = 'takeaway'", s.takeaway ? '1' : '0');
    if (typeof s.ai === 'boolean') this.sql.exec("UPDATE settings SET v = ? WHERE k = 'ai'", s.ai ? '1' : '0');
    if (typeof s.res === 'boolean') this.sql.exec("UPDATE settings SET v = ? WHERE k = 'res'", s.res ? '1' : '0');
    return this.adminStatus();
  }

  // Protects the AI budget: 30 questions per connection per 10 minutes and a daily maximum
  allowChat(ip) {
    const now = Date.now();
    this.cleanup(now);
    if (this.count('ai:' + ip, now - 10 * 60 * 1000) >= 30) return { error: 'too_many', status: 429 };
    const today = new Date().toISOString().slice(0, 10);
    const [day, n] = (this.setting('ai_day') || ':0').split(':');
    const used = day === today ? +n : 0;
    if (used >= dailyLimit(this.env)) return { error: 'daily_limit', status: 429 };
    this.sql.exec("UPDATE settings SET v = ? WHERE k = 'ai_day'", today + ':' + (used + 1));
    this.sql.exec('INSERT INTO limits (k, at) VALUES (?, ?)', 'ai:' + ip, now);
    return { ok: true };
  }

  card(code) {
    return code ? this.sql.exec('SELECT * FROM cards WHERE code = ?', code).toArray()[0] || null : null;
  }

  loyalty(code) {
    const c = this.card(code);
    if (!c) return { valid: false };
    return { valid: true, code: c.code, spent: c.spent, discount: discountFor(c.spent, this.env), next: nextTier(c.spent, this.env) };
  }

  addTakeaway(o, ip) {
    if (!this.takeawayEnabled()) return { error: 'paused', status: 403 };
    const sold = this.soldoutIn(o.lines);
    if (sold.length) return { error: 'soldout', items: sold, status: 409 };
    const now = Date.now();
    this.cleanup(now);
    // Max 3 takeaway orders per phone per hour and 20 per connection per 10 minutes
    if (this.count('p:' + o.phone, now - HOUR) >= 3 || this.count('tip:' + ip, now - 10 * 60 * 1000) >= 20) return { error: 'too_many', status: 429 };
    this.sql.exec('INSERT INTO limits (k, at) VALUES (?, ?), (?, ?)', 'p:' + o.phone, now, 'tip:' + ip, now);

    let card = null;
    if (o.loyalty) {
      card = this.card(o.card);
      if (!card) {
        let code;
        do { code = newCardCode(); } while (this.card(code));
        this.sql.exec('INSERT INTO cards (code, created) VALUES (?, ?)', code, now);
        card = this.card(code);
      }
    }
    const discount = card ? discountFor(card.spent, this.env) : 0;
    const token = crypto.randomUUID();
    const row = this.sql.exec(
      `INSERT INTO takeaway (created, token, name, phone, pickup, lang, note, lines, total, discount, card)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      now, token, o.name, o.phone, o.pickup, o.lang, o.note, JSON.stringify(o.lines), o.total, discount, card ? card.code : null
    ).one();
    return { id: row.id, token, discount, card: card ? card.code : null };
  }

  takeawayStatus(id, token) {
    const t = this.sql.exec('SELECT status AS state, ready_at, discount FROM takeaway WHERE id = ? AND token = ?', id, token).toArray()[0];
    return t || { error: 'not_found', status: 404 };
  }

  // Open orders for the waiter tablet (older than a day are left out)
  list() {
    const now = Date.now();
    this.cleanup(now);
    const orders = this.sql.exec('SELECT * FROM orders WHERE done = 0 AND created >= ? ORDER BY created', now - DAY).toArray()
      .map(o => ({ ...o, lines: JSON.parse(o.lines) }));
    const takeaway = this.sql.exec(`SELECT id, created, name, phone, pickup, lang, note, lines, total, discount, card, status, ready_at
      FROM takeaway WHERE status IN ('new', 'accepted') AND created >= ? ORDER BY created`, now - DAY).toArray()
      .map(o => ({ ...o, lines: JSON.parse(o.lines), to_pay: toPay(o.total, o.discount) }));
    const calls = this.sql.exec('SELECT * FROM calls WHERE done = 0 AND created >= ? ORDER BY created', now - 2 * HOUR).toArray();
    const today = zagrebDay();
    const res = this.sql.exec(`SELECT * FROM reservations WHERE (status = 'new' AND day >= ?)
      OR (day = ? AND status IN ('confirmed', 'arrived')) ORDER BY day, time`, today, today).toArray().map(r => this.resRow(r));
    return { orders, takeaway, calls, soldout: this.soldout(), tables: this.tables(), reservations: res, today };
  }

  done(id) {
    this.sql.exec('UPDATE orders SET done = 1, done_at = ? WHERE id = ?', Date.now(), id);
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
    } else if (action === 'done' && t.status !== 'done') {
      this.sql.exec("UPDATE takeaway SET status = 'done', closed = ? WHERE id = ?", now, id);
      if (t.card) {
        const paid = Math.round(euros(t.total) * (100 - t.discount)) / 100;
        this.sql.exec('UPDATE cards SET spent = spent + ?, orders = orders + 1, last_used = ? WHERE code = ?', paid, now, t.card);
      }
    }
    return { ok: true };
  }

  // Everything in a period, for the admin pages
  history(from, to) {
    this.cleanup(Date.now());
    const table = this.sql.exec('SELECT * FROM orders WHERE created >= ? AND created < ? ORDER BY created DESC', from, to).toArray()
      .map(o => ({ ...o, lines: JSON.parse(o.lines) }));
    const takeaway = this.sql.exec(`SELECT id, created, name, phone, pickup, lang, note, lines, total, discount, card, status, ready_at, closed
      FROM takeaway WHERE created >= ? AND created < ? ORDER BY created DESC`, from, to).toArray()
      .map(o => ({ ...o, lines: JSON.parse(o.lines), to_pay: toPay(o.total, o.discount) }));
    return { table, takeaway, names: this.tableNames() };
  }

  cards() {
    return this.sql.exec('SELECT * FROM cards ORDER BY spent DESC').toArray()
      .map(c => ({ ...c, discount: discountFor(c.spent, this.env) }));
  }

  deleteCard(code) {
    this.sql.exec('DELETE FROM cards WHERE code = ?', code);
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
const tableId = v => { const n = parseInt(v, 10); return n >= 1 && n <= 999 ? n : 0; };

// Floor plan from the admin page
function validTables(body) {
  const list = Array.isArray(body?.tables) ? body.tables : null;
  if (!list || list.length > 300) return null;
  const ids = new Set(), out = [];
  for (const t of list) {
    const id = tableId(t?.id), name = str(t?.name, 20), area = AREAS.includes(t?.area) ? t.area : '';
    const x = Number(t?.x), y = Number(t?.y), seats = parseInt(t?.seats, 10);
    if (!id || ids.has(id) || !name || !area || !(x >= 0 && x <= 100) || !(y >= 0 && y <= 100) || !(seats >= 1 && seats <= 30)) return null;
    ids.add(id);
    out.push({ id, name, area, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, seats });
  }
  return out;
}

function validOrder(body) {
  const table = tableId(body?.table);
  if (!table) return null;
  const lines = validLines(body.lines);
  if (!lines) return null;
  return { table, lines, note: str(body.note, 300), lang: str(body.lang, 4), total: str(body.total, 20) };
}

function validDayTime(day, time, online) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) return false;
  const today = zagrebDay(), min = +time.slice(0, 2) * 60 + +time.slice(3);
  if (!online) return day >= addDays(today, -1) && day <= addDays(today, 366) && min >= 0 && min < 24 * 60;
  if (day < today || day > addDays(today, RES_DAYS) || isClosedDay(day)) return false;
  if (min < RES_FROM || min > RES_UNTIL || (min - RES_FROM) % RES_STEP) return false;
  return day > today || min >= zagrebNow().min + 60;
}

function validReservation(body) {
  const day = str(body?.day, 10), time = str(body?.time, 5), guests = parseInt(body?.guests, 10);
  const name = str(body?.name, 60), phone = normPhone(body?.phone);
  if (!validDayTime(day, time, true) || !(guests >= 1 && guests <= RES_MAX_GUESTS) || !name || !phone) return null;
  const area = AREAS.includes(body.area) ? body.area : '';
  return { day, time, guests, area, name, phone, note: str(body.note, 300), lang: str(body.lang, 4) };
}

function validPhoneReservation(body) {
  const day = str(body?.day, 10), time = str(body?.time, 5), guests = parseInt(body?.guests, 10);
  const name = str(body?.name, 60);
  if (!validDayTime(day, time, false) || !(guests >= 1 && guests <= 200) || !name) return null;
  const tables = Array.isArray(body.tables) ? body.tables.map(tableId).filter(Boolean).slice(0, 20) : [];
  return { day, time, guests, name, phone: normPhone(body.phone) || str(body.phone, 30), note: str(body.note, 300), tables };
}

function validCall(body) {
  const table = tableId(body?.table);
  if (!table || !['waiter', 'bill'].includes(body.kind)) return null;
  const pay = body.kind === 'bill' && ['cash', 'card'].includes(body.pay) ? body.pay : null;
  return { table, kind: body.kind, pay };
}

function validTakeaway(body) {
  const lines = validLines(body?.lines);
  const name = str(body?.name, 60);
  const phone = normPhone(body?.phone);
  const pickup = str(body?.pickup, 5);
  if (!lines || !name || !phone) return null;
  if (pickup !== 'asap') {
    const m = pickup.match(/^(\d{2}):(\d{2})$/);
    if (!m) return null;
    const min = +m[1] * 60 + +m[2];
    if (min < TAKEAWAY_FROM || min > TAKEAWAY_UNTIL) return null;
  }
  return { lines, name, phone, pickup, note: str(body.note, 300), lang: str(body.lang, 4),
    total: str(body.total, 20), loyalty: body.loyalty === true, card: normCard(body.card) };
}

// null = PIN matches; otherwise the error to return
function pinError(request, env) {
  const expected = String(env.WAITER_PIN || '').trim();
  if (!expected) return 'no_pin';
  return (request.headers.get('X-Waiter-Pin') || '').trim() === expected ? null : 'pin';
}
// Two admin logins (you and the owner), same rights
function adminError(request, env) {
  const pins = [env.ADMIN_PIN, env.OWNER_PIN].map(p => String(p || '').trim()).filter(Boolean);
  if (!pins.length) return 'no_pin';
  return pins.includes((request.headers.get('X-Admin-Pin') || '').trim()) ? null : 'pin';
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

    if (path === '/api/status' && request.method === 'GET') {
      return json(await store.status(tableId(url.searchParams.get('stol'))), 200, { ...c, 'Cache-Control': 'no-store' });
    }

    if (path === '/api/tables' && request.method === 'GET') {
      const list = (await store.tables()).map(t => ({ id: t.id, name: t.name, area: t.area }));
      return json({ tables: list }, 200, { ...c, 'Cache-Control': 'no-store' });
    }

    if (path === '/api/chat' && request.method === 'POST') {
      if (!(await store.aiEnabled())) return json({ error: 'ai_off' }, 503, c);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, c); }
      const chat = validChat(body);
      if (!chat) return json({ error: 'invalid' }, 400, c);
      const allowed = await store.allowChat(ip);
      if (allowed.error) return json(allowed, allowed.status, c);
      try {
        const res = await askClaude(env, chat, await store.soldout());
        return json(res.reply ? { reply: res.reply } : { error: 'no_answer' }, res.reply ? 200 : 502, c);
      } catch (e) {
        console.error('AI error', e?.status, e?.message);
        return json({ error: 'ai_error' }, 502, c);
      }
    }

    if (path === '/api/call' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, c); }
      const call = validCall(body);
      if (!call) return json({ error: 'invalid' }, 400, c);
      const res = await store.addCall(call, ip);
      return json(res, res.status || 200, c);
    }

    if (path === '/api/reservation' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, c); }
      const r = validReservation(body);
      if (!r) return json({ error: 'invalid' }, 400, c);
      const res = await store.addReservation(r, ip);
      return json(res, res.status || 200, c);
    }

    m = path.match(/^\/api\/reservation\/(\d+)$/);
    if (m && request.method === 'GET') {
      const res = await store.reservationStatus(+m[1], url.searchParams.get('token') || '');
      return json(res, res.status || 200, { ...c, 'Cache-Control': 'no-store' });
    }

    m = path.match(/^\/api\/reservation\/(\d+)\/cancel$/);
    if (m && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch {}
      const res = await store.cancelReservation(+m[1], str(body.token, 60));
      return json(res, res.status || 200, c);
    }

    if (path === '/api/loyalty' && request.method === 'GET') {
      const code = normCard(url.searchParams.get('card'));
      return json(code ? await store.loyalty(code) : { valid: false }, 200, { ...c, 'Cache-Control': 'no-store' });
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

    m = path.match(/^\/api\/calls\/(\d+)\/done$/);
    if (m && request.method === 'POST') {
      const err = pinError(request, env);
      if (err) return json({ error: err }, 401);
      return json(await store.callDone(+m[1]));
    }

    if (path === '/api/reservations' && request.method === 'GET') {
      const err = pinError(request, env);
      if (err) return json({ error: err }, 401);
      const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('day') || '') ? url.searchParams.get('day') : zagrebDay();
      return json(await store.reservations(day));
    }

    if (path === '/api/reservations' && request.method === 'POST') {
      const err = pinError(request, env);
      if (err) return json({ error: err }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
      const r = validPhoneReservation(body);
      if (!r) return json({ error: 'invalid' }, 400);
      return json(await store.addPhoneReservation(r));
    }

    m = path.match(/^\/api\/reservations\/(\d+)\/(confirm|reject|arrived|noshow|cancel)$/);
    if (m && request.method === 'POST') {
      const err = pinError(request, env);
      if (err) return json({ error: err }, 401);
      let body = {};
      try { body = await request.json(); } catch {}
      const tables = Array.isArray(body.tables) ? body.tables.map(tableId).filter(Boolean).slice(0, 20) : [];
      const res = await store.setReservation(+m[1], m[2], tables);
      return json(res, res.status || 200);
    }

    if (path === '/api/menu-names' && request.method === 'GET') {
      const err = pinError(request, env);
      if (err) return json({ error: err }, 401);
      return json({ items: await menuNames(env), soldout: await store.soldout() });
    }

    if (path === '/api/soldout' && request.method === 'POST') {
      const err = pinError(request, env);
      if (err) return json({ error: err }, 401);
      let body = {};
      try { body = await request.json(); } catch {}
      const name = str(body.name, 160);
      if (!name) return json({ error: 'invalid' }, 400);
      return json(await store.setSoldout(name, body.on === true));
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

    // ---- admins ----
    if (path.startsWith('/api/admin/')) {
      const err = adminError(request, env);
      if (err) return json({ error: err }, 401);

      if (path === '/api/admin/orders' && request.method === 'GET') {
        const to = parseInt(url.searchParams.get('to'), 10) || Date.now() + DAY;
        const from = parseInt(url.searchParams.get('from'), 10) || to - 7 * DAY;
        return json({ ...(await store.history(from, to)), now: Date.now() });
      }
      if (path === '/api/admin/settings' && request.method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch {}
        return json(await store.setSettings(body));
      }
      if (path === '/api/admin/settings' && request.method === 'GET') {
        return json(await store.adminStatus());
      }
      if (path === '/api/admin/reservations' && request.method === 'GET') {
        const from = str(url.searchParams.get('from'), 10), to = str(url.searchParams.get('to'), 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return json({ error: 'invalid' }, 400);
        return json({ reservations: await store.resHistory(from, to) });
      }
      if (path === '/api/admin/tables' && request.method === 'GET') {
        return json({ tables: await store.tables() });
      }
      if (path === '/api/admin/tables' && request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
        const list = validTables(body);
        if (!list) return json({ error: 'invalid' }, 400);
        return json(await store.saveTables(list));
      }
      if (path === '/api/admin/cards' && request.method === 'GET') {
        return json({ cards: await store.cards(), tiers: tiers(env) });
      }
      m = path.match(/^\/api\/admin\/cards\/([A-Z0-9-]+)$/);
      if (m && request.method === 'DELETE') return json(await store.deleteCard(m[1]));
      return json({ error: 'not_found' }, 404);
    }

    if (path === '/' || path === '/konobar') return html(WAITER_PAGE);
    if (path === '/admin') return html(ADMIN_PAGE);
    return new Response('Not found', { status: 404 });
  },
};
