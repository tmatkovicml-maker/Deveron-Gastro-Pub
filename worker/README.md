# Deveron narudžbe (Cloudflare Worker)

Prima narudžbe sa stolova (`deveronpub.com/?stol=N`) i narudžbe za van, prikazuje ih na tabletu kod šanka, vodi anonimne loyalty kartice i čuva povijest narudžbi za administraciju.

## Postavljanje (jednom)
1. Cloudflare → **Workers & Pages** → **Create** → **Import a repository** → `Deveron-Gastro-Pub`.
2. **Root directory**: `worker` (ostalo ostaviti kako jest) → **Deploy**.
3. Worker `deveron-gastro-pub` → **Settings** → **Runtime variables and secrets** → **Add** (type **Secret**):
   - `WAITER_PIN` – PIN za konobare (tablet)
   - `ADMIN_PIN` i `OWNER_PIN` – dva odvojena administratorska PIN-a (administrator i vlasnik) za stranicu `/admin`
4. Neobavezno (type **Text**): `LOYALTY_TIERS` – pragovi popusta, npr. `100:10,300:15`
   (od 100 € potrošnje 10 %, od 300 € 15 %). Bez nje vrijedi `100:10,300:15`.
5. Adresa Workera (`https://deveron-gastro-pub.t-matkovicml.workers.dev`) upisana je u `index.html` kao `ORDER_API`.

## Tablet
Otvoriti adresu Workera u pregledniku tableta, upisati `WAITER_PIN` i dodirnuti „Uključi zvuk i počni".
- Narudžba sa stola: „✓ Otkucano".
- Narudžba za van: „✓ 15/30/45 min" (prihvati), „✗ Odbij", „📞 Nazovi", a nakon preuzimanja „✓ Preuzeto i plaćeno"
  (tek tada se iznos, umanjen za loyalty popust, pribraja loyalty kartici).
- Poziv sa stola (gumb 🙋 na mobitelu gosta): „🙋 POZIV KONOBARA" ili „🧾 RAČUN · 💳 KARTICA / 💶 GOTOVINA" → „✓ Riješeno".
- „🚫 Rasprodano" (gore desno): jelo ili piće označeno kao rasprodano gostima piše „Trenutno nije dostupno",
  ne može se naručiti i AI ga ne preporučuje. Oznaka vrijedi do kraja dana.

## Administracija
`https://deveron-gastro-pub.t-matkovicml.workers.dev/admin` → `ADMIN_PIN` ili `OWNER_PIN`.
- **Narudžbe**: sve narudžbe za stolom i za van po razdoblju (danas, jučer, 7/30 dana, mjesec, od–do), zbrojevi, najprodavanije, izvoz u CSV.
- **Loyalty kartice**: anonimni kodovi, potrošnja, popust, brisanje.
- **Narudžbe za van na webu**: prekidač Pauziraj / Uključi (zadano pauzirano). Dok je pauzirano, gumb „Naruči za van" je skriven, a Worker odbija narudžbe za van.

## AI asistent
Gosti na webu (kartica „AI Chat") pitaju o jelima, vinima, alergenima i restoranu; odgovara Claude (Anthropic) na jeziku gosta, samo iz `menu.csv` i podataka o restoranu u `src/ai.js`.
1. [console.anthropic.com](https://console.anthropic.com) → **API Keys** → **Create Key**. Ključ se nikome ne šalje.
2. Worker → **Settings** → **Runtime variables and secrets** → **Add** → type **Secret**, ime `ANTHROPIC_API_KEY`, vrijednost ključ.
3. Neobavezno (type **Text**): `AI_MODEL` (zadano `claude-opus-5`; jeftinije `claude-haiku-4-5`), `AI_DAILY_LIMIT` (najviše pitanja dnevno, zadano 300).
4. `/admin` → **AI asistent na webu**: Isključi / Uključi. Tamo piše i broj pitanja danas.
Kartica „AI Chat" vidi se samo kad je ključ upisan i prekidač uključen. Ograničenja: 30 pitanja po uređaju u 10 min i dnevni maksimum. Pitanja se ne spremaju. U Anthropic konzoli (Billing → Limits) preporučuje se postaviti mjesečni limit potrošnje.

## API
- `POST /api/order` – narudžba sa stola (samo s deveronpub.com; najviše 5 po stolu u 10 min)
- `POST /api/takeaway` – narudžba za van (08:00–21:30, ne 25.12.; najviše 3 po mobitelu na sat)
- `GET /api/takeaway/:id?token=` – stanje narudžbe za van (`new`, `accepted`, `rejected`, `done`)
- `GET /api/loyalty?card=` – popust i potrošnja loyalty kartice
- `GET /api/status` – jesu li narudžbe za van i AI asistent uključeni, i što je danas rasprodano
- `POST /api/call` – gost sa stola zove konobara ili traži račun `{table, kind: waiter|bill, pay?: cash|card}`
- `POST /api/chat` – pitanje AI asistentu `{messages, lang}` → `{reply}` (samo s deveronpub.com)
- `GET /api/orders` – otvorene narudžbe (zaglavlje `X-Waiter-Pin`)
- `POST /api/orders/:id/done`, `POST /api/takeaway/:id/accept|reject|done`, `POST /api/calls/:id/done`,
  `GET /api/menu-names`, `POST /api/soldout {name, on}` (zaglavlje `X-Waiter-Pin`)
- `GET /api/admin/orders?from=&to=`, `GET /api/admin/cards`, `DELETE /api/admin/cards/:code`, `GET|POST /api/admin/settings` (zaglavlje `X-Admin-Pin`)

Čuvanje: narudžbe (stol i za van) godinu dana; ime i mobitel gosta za van 7 dana; loyalty kartice 2 godine od zadnjeg korištenja. Tablet prikazuje samo otvorene narudžbe iz zadnja 24 sata.
Lokalno testiranje: `npx wrangler dev` uz datoteku `.dev.vars` (npr. `WAITER_PIN=1234`, `ADMIN_PIN=9999`, `OWNER_PIN=8888`).
