// AI assistant for guests: answers questions about the menu, wines, allergens and the
// restaurant, in the guest's language. The API key lives in the ANTHROPIC_API_KEY secret;
// the model can be changed with the AI_MODEL variable.
import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MODEL = 'claude-opus-5';
const MENU_URL = 'https://deveronpub.com/menu.csv';
const MENU_TTL = 10 * 60 * 1000;
const MAX_TURNS = 10, MAX_CHARS = 500;

const LANG_NAMES = { HR: 'Croatian', EN: 'English', DE: 'German', IT: 'Italian', FR: 'French', ES: 'Spanish',
  PT: 'Portuguese', NL: 'Dutch', PL: 'Polish', RU: 'Russian', HU: 'Hungarian', CS: 'Czech', SK: 'Slovak',
  SL: 'Slovenian', UA: 'Ukrainian', RO: 'Romanian' };

const ALLERGENS = '1 cereals (gluten), 2 crustaceans, 3 eggs, 4 fish, 5 peanuts, 6 soy, 7 milk (lactose), 8 nuts, ' +
  '9 celery, 10 mustard, 11 sesame, 12 sulphites, 13 lupin, 14 molluscs';

const RESTAURANT = `Deveron Gastro Pub, Ulica Vladimira Gortana 32, 51550 Mali Lošinj, Croatia. Phone +385 51 231 234.
Named after a sailing ship built in Great Britain for the Cosulich family of Lošinj, always captained by Lošinj sailors.
Rated 12.5/20 points by Gault&Millau Croatia.
Open every day 08:00–24:00, kitchen 08:00–22:00, closed on 25 December.
Table reservations: https://deveron-gastro-pub-1683645478.resos.com/booking
WiFi network "deveronpub", password "deveronpub2019".
Parking: Nova Obala, Lidl car park and the sports hall (Dvorana) car park, about 5 minutes' walk.
Ordering: guests at a table scan the QR code on the table, add items with the + button and send the order to the waiter.
Instagram: @deveronpub. Website: deveronpub.com.
Prices are in euros; each item also shows its anchor price of 10 September 2026.`;

// ---- menu from menu.csv (same file the website uses) ----
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

function menuText(csv) {
  const rows = parseCSV(csv);
  const head = rows[0].map(h => h.trim());
  const get = (r, n) => { const k = head.indexOf(n); return k < 0 ? '' : (r[k] || '').trim(); };
  const out = [];
  let section = '';
  for (const r of rows.slice(1)) {
    const name = get(r, 'Naziv HR');
    if (!name || /^(ne|no|0|false)$/i.test(get(r, 'Prikaži'))) continue;
    const sec = [get(r, 'Kartica'), get(r, 'Kategorija')].filter(Boolean).join(' / ');
    if (sec !== section) { out.push(`\n## ${sec}`); section = sec; }
    const en = get(r, 'Naziv EN');
    const bits = [
      name + (en && en.toLowerCase() !== name.toLowerCase() ? ` (EN: ${en})` : ''),
      get(r, 'Količina'),
      get(r, 'Cijena') ? get(r, 'Cijena') + ' €' : '',
      get(r, 'Opis EN') || get(r, 'Opis HR'),
      get(r, 'Alergeni') ? 'allergens ' + get(r, 'Alergeni') : 'allergens not listed',
      get(r, 'Vino uz jelo') ? 'wine pairing: ' + get(r, 'Vino uz jelo') : '',
      /^(ne|no)$/i.test(get(r, 'Za van')) ? 'not for takeaway' : '',
    ].filter(Boolean);
    out.push('- ' + bits.join(' | '));
  }
  return out.join('\n');
}

let MENU_CACHE = { text: '', csv: '', at: 0 };
async function loadCsv(env) {
  if (MENU_CACHE.csv && Date.now() - MENU_CACHE.at < MENU_TTL) return MENU_CACHE;
  try {
    const r = await fetch(env.MENU_CSV_URL || MENU_URL, { cf: { cacheTtl: 300 } });
    if (r.ok) { const csv = await r.text(); MENU_CACHE = { text: menuText(csv), csv, at: Date.now() }; }
  } catch {}
  return MENU_CACHE;
}
async function loadMenu(env) {
  return (await loadCsv(env)).text;
}

// Dishes and drinks for the tablet's sold-out list: [{tab, cat, name}]
export async function menuNames(env) {
  const { csv } = await loadCsv(env);
  if (!csv) return [];
  const rows = parseCSV(csv);
  const head = rows[0].map(h => h.trim());
  const k = n => head.indexOf(n);
  return rows.slice(1)
    .filter(r => (r[k('Naziv HR')] || '').trim() && !/^(ne|no|0|false)$/i.test((r[k('Prikaži')] || '').trim()))
    .map(r => ({ tab: (r[k('Kartica')] || '').trim(), cat: (r[k('Kategorija')] || '').trim(), name: r[k('Naziv HR')].trim() }));
}

function systemPrompt(menu) {
  return `You are the digital host of Deveron Gastro Pub in Mali Lošinj, Croatia, chatting with guests on the restaurant's website, usually on their phone at the table.

Answer in the language the guest writes in (the website language is given with each question). Be warm and brief: two to four short sentences, plain text without Markdown, lists only when the guest asks for several options. Recommend concrete dishes and wines from the menu below with their prices. Suggest the listed wine pairing when it fits.

Only talk about things on the menu and the facts below. If something is not on the menu or you do not know it (for example ingredients that are not listed), say so and suggest asking the waiter. Never invent dishes, prices, opening hours or discounts.

Allergens: use the allergen numbers on the menu. When a guest has an allergy or intolerance, point out which dishes contain that allergen, and always add that they should confirm with the waiter because recipes can change and cross-contact is possible. Items marked "allergens not listed" have no allergen information yet, so do not call them safe.

You cannot take orders, make reservations or change anything. For ordering, tell the guest to use the + buttons in the menu (after scanning the QR code on the table) or to call the waiter; for reservations, give the booking link.

Allergen numbers: ${ALLERGENS}.

# Restaurant
${RESTAURANT}

# Menu (Croatian name, English name in brackets)
${menu || '(The menu could not be loaded right now. Tell the guest to look at the Menu tab or ask the waiter.)'}`;
}

// Accept a short alternating conversation that ends with the guest's question
export function validChat(body) {
  let msgs = Array.isArray(body?.messages) ? body.messages.slice(-MAX_TURNS) : [];
  while (msgs.length && msgs[0]?.role !== 'user') msgs.shift();
  const clean = [];
  let expect = 'user';
  for (const m of msgs) {
    const content = typeof m?.content === 'string' ? m.content.trim().slice(0, MAX_CHARS) : '';
    if (m?.role !== expect || !content) return null;
    clean.push({ role: m.role, content });
    expect = expect === 'user' ? 'assistant' : 'user';
  }
  if (!clean.length || clean[clean.length - 1].role !== 'user') return null;
  const lang = LANG_NAMES[String(body.lang || '').toUpperCase()] || 'the guest\'s language';
  return { messages: clean, lang };
}

export async function askClaude(env, chat, soldout = []) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const menu = await loadMenu(env);
  // Today's sold-out items go with the question, so the cached system prompt stays the same
  const today = soldout.length ? `\n[Sold out today, do not recommend: ${soldout.join('; ')}]` : '';
  const messages = chat.messages.map((m, i) => i === chat.messages.length - 1
    ? { role: 'user', content: `[Website language: ${chat.lang}]${today}\n${m.content}` } : m);

  const model = env.AI_MODEL || DEFAULT_MODEL;
  const params = {
    model,
    max_tokens: 2000,
    system: [{ type: 'text', text: systemPrompt(menu), cache_control: { type: 'ephemeral' } }],
    messages,
  };
  let response;
  if (/opus-5|fable/.test(model)) {
    // Short answers need little reasoning; a declined request is retried on Anthropic's fallback model
    response = await client.beta.messages.create({
      ...params, output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    });
  } else {
    response = await client.messages.create(params);   // e.g. AI_MODEL=claude-haiku-4-5 for lower cost
  }

  if (response.stop_reason === 'refusal') return { reply: '', refused: true };
  const reply = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  return { reply };
}
