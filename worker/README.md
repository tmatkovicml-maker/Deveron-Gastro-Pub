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
- „📅 Rezervacije": nova rezervacija s weba zasvira i pojavi se kao narančasta kartica → „✓ Potvrdi i odaberi stol" (dodir na stol u tlocrtu, može i više stolova; sivo = zauzeto drugom rezervacijom ±2 h) ili „✗ Nema mjesta". Popis po danu: „✓ Stigli", „Stol", „Nisu došli", „Otkaži" i „＋ Rezervacija (telefon)" za rezervacije primljene telefonom. U „🗺 Tlocrt" današnje rezervacije su plave.
- „🚫 Rasprodano" (gore desno): jelo ili piće označeno kao rasprodano gostima piše „Trenutno nije dostupno",
  ne može se naručiti i AI ga ne preporučuje. Oznaka vrijedi do kraja dana.

## Administracija
`https://deveron-gastro-pub.t-matkovicml.workers.dev/admin` → `ADMIN_PIN` ili `OWNER_PIN`.
- **Narudžbe**: sve narudžbe za stolom i za van po razdoblju (danas, jučer, 7/30 dana, mjesec, od–do), zbrojevi, najprodavanije, izvoz u CSV.
- **Loyalty kartice**: anonimni kodovi, potrošnja, popust, brisanje.
- **Online rezervacije na webu**: prekidač Uključi / Isključi (zadano isključeno). Dok je isključeno, gumb „Rezerviraj" vodi na resOS kao dosad; uključeno otvara naš obrazac (12:00–21:30 svakih 30 min, do 12 osoba, do 60 dana unaprijed, najmanje sat vremena prije).
- **Rezervacije**: popis po razdoblju sa zbrojevima (potvrđeno, čeka potvrdu, nisu došli, preko weba).
- **Tlocrt**: stolovi terase i restorana. Stol se povuče na novo mjesto, a dodirom mu se mijenja naziv, broj mjesta i prostor; tu se i dodaje ili briše. Broj u QR kodu (`?stol=12`) se ne mijenja, pa se QR kartice tiskaju samo za nove stolove (`deveronpub.com/qr.html` uvijek pokazuje trenutne nazive).
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
- `GET /api/status?stol=12` – jesu li narudžbe za van i AI asistent uključeni, što je danas rasprodano i naziv stola
- `GET /api/tables` – stolovi (id, naziv, prostor) za QR kartice
- `POST /api/reservation`, `GET /api/reservation/:id?token=`, `POST /api/reservation/:id/cancel` – rezervacija gosta
- `POST /api/call` – gost sa stola zove konobara ili traži račun `{table, kind: waiter|bill, pay?: cash|card}`
- `POST /api/chat` – pitanje AI asistentu `{messages, lang}` → `{reply}` (samo s deveronpub.com)
- `GET /api/orders` – otvorene narudžbe (zaglavlje `X-Waiter-Pin`)
- `POST /api/orders/:id/done`, `POST /api/takeaway/:id/accept|reject|done`, `POST /api/calls/:id/done`,
  `GET /api/menu-names`, `POST /api/soldout {name, on}`, `GET|POST /api/reservations`,
  `POST /api/reservations/:id/confirm|reject|arrived|noshow|cancel` (zaglavlje `X-Waiter-Pin`)
- `GET /api/admin/orders?from=&to=`, `GET /api/admin/cards`, `DELETE /api/admin/cards/:code`, `GET|POST /api/admin/settings`, `GET|POST /api/admin/tables` (zaglavlje `X-Admin-Pin`)

Čuvanje: narudžbe (stol i za van) i rezervacije godinu dana; ime i mobitel gosta za van 7 dana, kod rezervacije 30 dana nakon datuma; loyalty kartice 2 godine od zadnjeg korištenja. Tablet prikazuje samo otvorene narudžbe iz zadnja 24 sata.
Lokalno testiranje: `npx wrangler dev` uz datoteku `.dev.vars` (npr. `WAITER_PIN=1234`, `ADMIN_PIN=9999`, `OWNER_PIN=8888`).
