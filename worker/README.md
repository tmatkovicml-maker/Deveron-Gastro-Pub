# Deveron narudžbe (Cloudflare Worker)

Prima narudžbe sa stolova (`deveronpub.com/?stol=N`) i prikazuje ih na tabletu kod šanka.

## Postavljanje (jednom)
1. Cloudflare → **Workers & Pages** → **Create** → **Import a repository** → `Deveron-Gastro-Pub`.
2. **Root directory**: `worker` (ostalo ostaviti kako jest) → **Deploy**.
3. Worker `deveron-orders` → **Settings** → **Variables and Secrets** → **Add**:
   type **Secret**, name `WAITER_PIN`, value = PIN za konobare (npr. 4 znamenke).
4. Adresu Workera (npr. `https://deveron-orders.NESTO.workers.dev`) upisati u `index.html` kao `ORDER_API`.

## Tablet
Otvoriti adresu Workera u pregledniku tableta, upisati PIN i dodirnuti „Uključi zvuk i počni".

## API
- `POST /api/order` – narudžba sa stola (dopušteno samo s deveronpub.com; najviše 5 po stolu u 10 min)
- `GET /api/orders` – otvorene narudžbe (zaglavlje `X-Waiter-Pin`)
- `POST /api/orders/:id/done` – označi kao otkucano (zaglavlje `X-Waiter-Pin`)

Narudžbe se brišu nakon 24 sata. Lokalno testiranje: `npx wrangler dev` uz datoteku `.dev.vars` s redkom `WAITER_PIN=1234`.
