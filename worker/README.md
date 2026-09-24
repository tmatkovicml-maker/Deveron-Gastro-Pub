# Deveron narudžbe (Cloudflare Worker)

Prima narudžbe sa stolova (`deveronpub.com/?stol=N`) i narudžbe za van, prikazuje ih na tabletu kod šanka i vodi loyalty program.

## Postavljanje (jednom)
1. Cloudflare → **Workers & Pages** → **Create** → **Import a repository** → `Deveron-Gastro-Pub`.
2. **Root directory**: `worker` (ostalo ostaviti kako jest) → **Deploy**.
3. Worker `deveron-gastro-pub` → **Settings** → **Runtime variables and secrets** → **Add** (type **Secret**):
   - `WAITER_PIN` – PIN za konobare (tablet)
   - `ADMIN_PIN` – PIN vlasnika (stranica `/admin`: gosti, potrošnja, izvoz, brisanje)
4. Neobavezno (type **Text**): `LOYALTY_TIERS` – pragovi popusta, npr. `100:10,300:15`
   (od 100 € potrošnje 10 %, od 300 € 15 %). Bez nje vrijedi `100:10,300:15`.
5. Adresa Workera (`https://deveron-gastro-pub.t-matkovicml.workers.dev`) upisana je u `index.html` kao `ORDER_API`.

## Tablet
Otvoriti adresu Workera u pregledniku tableta, upisati `WAITER_PIN` i dodirnuti „Uključi zvuk i počni".
- Narudžba sa stola: „✓ Otkucano".
- Narudžba za van: „✓ 15/30/45 min" (prihvati), „✗ Odbij", „📞 Nazovi", a nakon preuzimanja „✓ Preuzeto i plaćeno"
  (tek tada se iznos, umanjen za loyalty popust, pribraja potrošnji gosta).

## Vlasnik
`https://deveron-gastro-pub.t-matkovicml.workers.dev/admin` → `ADMIN_PIN`.

## API
- `POST /api/order` – narudžba sa stola (samo s deveronpub.com; najviše 5 po stolu u 10 min)
- `POST /api/takeaway` – narudžba za van (08:00–21:30, ne 25.12.; najviše 3 po mobitelu na sat)
- `GET /api/takeaway/:id?token=` – stanje narudžbe za van (`new`, `accepted`, `rejected`, `done`)
- `GET /api/loyalty?phone=` – popust za broj mobitela
- `GET /api/orders` – otvorene narudžbe (zaglavlje `X-Waiter-Pin`)
- `POST /api/orders/:id/done`, `POST /api/takeaway/:id/accept|reject|done` (zaglavlje `X-Waiter-Pin`)
- `GET /api/admin/customers`, `DELETE /api/admin/customers/:phone` (zaglavlje `X-Admin-Pin`)

Čuvanje: narudžbe sa stola 24 h, narudžbe za van 30 dana, gosti do povlačenja privole ili 2 godine bez narudžbe.
Lokalno testiranje: `npx wrangler dev` uz datoteku `.dev.vars` (npr. `WAITER_PIN=1234`, `ADMIN_PIN=9999`).
