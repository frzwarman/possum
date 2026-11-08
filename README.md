# Takar — setiap gram tercatat

Takar is a point of sale, kitchen and bar station system, and recipe-level stock tracker for a
single café or restaurant, built as a local-first Progressive Web App on the Possum (meja.)
codebase. Everything the app says to its users is in Bahasa Indonesia; this documentation is in
English, with the on-screen labels quoted so you can match them.

The product requirements are in [docs/superpowers/specs/2026-11-06-takar-prd.md](docs/superpowers/specs/2026-11-06-takar-prd.md);
the decisions that map them onto this codebase are in
[docs/superpowers/specs/2026-11-06-takar-design-decisions.md](docs/superpowers/specs/2026-11-06-takar-design-decisions.md).

```
open shift → take order → send to stations → mark ready → payment → receipt → close shift
 (float)     (pager no.,   (ticket splits:    (bar / kitchen  (cash quick   (print or   (count, gap over
              options)      bar + kitchen,     tablet)          amounts,      share)      the limit needs
                            stock moves now)                     QRIS)                    a manager PIN)
```

Every sale moves stock through a recipe tree: ingredients (bought in packs, stocked in g, ml or pcs),
prep items made in batches (ayam ungkep, sambal, syrups) and menu items whose options add, swap or
scale recipe lines. Voids, discounts, refunds, cash gaps, stock adjustments and counts need a manager
PIN and land in an audit log nobody can edit. The till keeps selling offline.

## Three device modes, one stock ledger

| Mode | Runs on | Who | What it can do |
|---|---|---|---|
| **POS** (`pos`) | the one cashier tablet | cashier, manager, owner | take orders, send to stations, take payment, open and close the shift |
| **Station** (`station`) | kitchen tablet, bar tablet | kitchen crew, barista | see its own tickets oldest first, mark ready, log waste, make prep batches, count its area |
| **Back office** (`office`) | laptop, manager's phone | owner, manager, inventory admin, head chef | Today, menu and recipes, ingredients and receiving, counts, reports, audit log, team |

A device is paired once by an owner or manager (*Lainnya → Printer & perangkat*). Only the POS device may
sell; every paired device sends its own work (ready, waste, batches, counts) and pulls everyone else's
through the `pull` RPC: station tablets every 5 s, the till every 10 s, laptops every 30 s. An unpaired
device is a read-only dashboard.

### Pilot mode: no station tablets yet

The Ziggy Lounge pilot (`docs/superpowers/specs/2026-11-08-takar-pilot-prd.md`) runs with the cashier
tablet and the manager's laptop only. *Lainnya → Restoran → "Tablet dapur & bar menerima tiket"* is off
(the default for a provisioned restaurant; the demo has it on):

- the cashier tells the bar and kitchen; paying an order sends it and deducts stock in the same tap, so
  "Ke stasiun" and the Stasiun screens are hidden;
- the cashier keeps stock between orders: the Stok, Produksi and Hitung stok links are theirs (low and
  sold-out menu, waste, batches, counts), never money or documents;
- the till never opens the manager screens while a shift is open, not even for an owner who signed in
  with their PIN; Sif & kas shows the cashier's blind view, the back office returns once the shift is
  closed or from the laptop;
- a count submitted on a tablet (`count.submit`) lands on the laptop as "Perlu ditinjau"; the manager
  approves it there (or on the same device with a PIN) into one `count.record`.

## Roles

| | Pemilik | Manajer | Admin stok | Kepala dapur | Kasir | Barista | Dapur |
|---|---|---|---|---|---|---|---|
| Sell, send to stations, take payment, open and close shift | yes | yes | – | – | yes | – | – |
| Discount, void, refund, cash out, cash gap over the limit | yes | yes | – | – | manager PIN | – | – |
| Station: tickets, ready, waste, prep batches | yes | yes | yes | yes | yes | yes | yes |
| Menu and recipes (publishing an active item without a recipe) | yes | yes | PIN | PIN | – | – | – |
| Ingredients, receiving, purchasing | yes | yes | yes | – | – | – | – |
| Stock counts (approving the result) | yes | yes | PIN | PIN | – | PIN | PIN |
| Today, reports, audit log, settings, devices, team | yes | yes | – | – | – | – | – |

The server (`apply_operation`) re-checks every rule; a hidden button is never the only guard. Each
owner and manager sets a 6-digit approval PIN in *Lainnya → PIN persetujuan*; three wrong PINs pause
approvals for five minutes. Staff sign in on a shared device by picking their name and typing their
own 6-digit PIN (`pnpm staff add … --pin`); POS and station devices lock after two minutes idle.

## Features, by PRD section

- **F1 Take an order.** One forgiving search over names, aliases and tags (`amer` and `amricano` both
  find the Americanos); four filters (Semua, Makanan, Minuman, Camilan); every new order is dine-in with
  the next pager number; one sheet for size, milk, sugar and extras with the price updating live and
  each choice saying what it does to stock; one tap sends the ticket, split by station; cash with
  quick amounts and a large change figure, QRIS confirmed by the cashier; cards go grey when the
  ingredients run out and show *Sisa N* when few portions are left.
- **F2 Stations.** `/station`: kitchen or bar, big type, dark mode, tickets oldest first, red after the
  station's target minutes, *Siap* per ticket, waste in three taps, the prep list and batches about
  to expire.
- **F3 Menu and recipes.** One form: name, type, station, tags, aliases, price, photo, recipe lines in
  any matching unit with their cost, option groups (add, swap, level, size) expressed as recipe
  deltas, live cost / margin / food-cost %. Items without a recipe are flagged; a chef or admin needs
  a manager PIN to publish one as active.
- **F4 Prep batches.** A prep item is a stock item with a batch recipe, yield, shelf life and station.
  One step records a batch; the actual yield enters stock and the gap is written into the movement.
- **F5 Ingredients and receiving.** Base unit, packs ("1 karton = 12.000 ml"), par, storage area,
  aliases; deliveries typed in packs with an optional delivery-note photo; a delivery over 5× or under
  ⅕ of the usual size needs a second tap; every movement with who, when and the running balance.
- **F6 Counts.** Count one storage area on a tablet with the system figure hidden, pause and resume,
  review expected vs counted in units and rupiah sorted by gap, reasons for gaps over 5%, approval
  into one `count.record` operation. Weekly for the 20 most-used ingredients, monthly for all.
- **F7 Today.** Sales, food-cost %, waste and the usage gap for the day; stock under par with days
  left, voids, count gaps, items without a recipe, overdue counts and expiring batches, each linking
  to its fix. Menu items go sold out by themselves when they cannot be made.
- **F8 Controls.** Seven roles, device modes, PIN approvals, PIN sign-in, idle lock, and `/audit`.

Deferred to later phases, as the PRD says: purchase orders from the low-stock list and supplier price
comparison (the existing purchase-order screen stays), recipe approvals, a one-time approval code on
the manager's phone, batch invoices, LAN / ESC-POS printing, Talenta and accounting.

## Design system

The look follows the Figma file **TAKAR POS** (Design system page): Plus Jakarta Sans (self-hosted,
`@fontsource-variable/plus-jakarta-sans`), ink `#1B1D21` and lime `#D3F26A` as the brand, grey canvas,
1 px borders with no shadows on cards, radii 6/10/14/20, pills for chips and badges, pastel stat cards
(lavender, sky, mint, teal). Every colour is a CSS variable at the top of `src/styles.css`; the dark set
applies under `.station.dark`. Lime is reserved for the one primary POS action per view and the active
nav item. The till uses the 88 px icon rail, the laptop the 248 px sidebar. The mark ("the pour") lives
in `src/components/logo.tsx` and `public/icon.svg`. Decisions 23–30 in
`docs/superpowers/specs/2026-11-06-takar-design-decisions.md` list what was matched and what was not
(icons stay Lucide; the logo is redrawn from the construction grid).

### Demo pictures

The demo catalogue and its ingredients carry photos hotlinked from [Unsplash](https://unsplash.com) (free licence,
hotlinking allowed, resized by their CDN to 480×360). They are keyed by item id in `src/domain/sample.ts`; the service
worker caches them so the demo keeps its pictures offline, and an existing demo install gets them filled in on the
next start. A real restaurant still uploads its own photos (compressed to WebP on the device); a catalog also accepts
an `images.unsplash.com` URL as a photo.

## Why local-first

The cashier must keep serving when the internet drops. Every action is written to the device's own
database first and queued for the server second, so a dead connection is a sync delay, not a stopped
queue of customers. The server remains the authority on money and stock: when the queue drains,
Postgres re-validates every operation before accepting it, and every paired device pulls what the
others did.

```
  ┌────────────── paired device (Android / Chrome, PWA): POS, station or back office ──────────────┐
  │  React 19 + TanStack Router                                                                      │
  │        │ commands (src/lib/commands.ts)                                                          │
  │        ▼                                                                                         │
  │  ┌──────────── ONE Dexie transaction ────────────┐                                               │
  │  │  domain record (order / movement / count)     │   ← what the screen reads                     │
  │  │  + outbox operation (idempotent, has an id)   │   ← what the server will replay               │
  │  └───────────────────────────────────────────────┘                                               │
  │        │ synchronize() — push in order, stop on the first conflict, then pull(since)             │
  └────────┼─────────────────────────────────────────────────────────────────────────────────────────┘
           ▼
  ┌──── Supabase ─────────────────────────────────────────────────────────────────────────────────┐
  │  Auth (email + password; staff PINs are their passwords; sign-ups disabled)                   │
  │  Postgres: apply_operation(jsonb) ← the ONLY write path. pull / bootstrap / audit_log ← reads │
  │  RLS on every exposed table; clients hold SELECT and nothing else                             │
  └───────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Architecture

| Layer | Choice | Note |
|---|---|---|
| App | Vite 7 + React 19 + TypeScript (strict) | one SPA, no server rendering |
| Routing | TanStack Router | `/pos` eager, every other screen lazy |
| Local database | Dexie (IndexedDB), `src/lib/db.ts` | one database per identity + device |
| Queue | transactional outbox in the same Dexie database | record and operation commit together or not at all |
| Sync | `src/lib/sync.ts` | push (Web Locks, ordered, batched, backs off, halts on rejection) then pull |
| Server | Supabase Postgres + Auth | `apply_operation`, `bootstrap`, `pull`, `audit_log`, `approve`, `enroll_device`, `manage_staff`, `sales_report` |
| Hosting | Cloudflare Pages (static) | see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| Offline shell | vite-plugin-pwa / Workbox, `registerType: 'prompt'` | never reloads itself mid-checkout |

## Data model and conventions

- **Money is integer rupiah.** `money()` rejects anything that is not a safe non-negative integer up to
  1,000,000,000.
- **Quantities are thousandths of a base unit.** 1 kg = `1_000_000`, 1 l = `1_000_000`, 1 pcs = `1_000`.
  Base units are `g`, `ml`, `pcs` and are immutable once an ingredient exists. Packs convert to the base
  unit (`{name:'karton', qty:12_000_000}`); `convert()` accepts a decimal comma.
- **Option deltas.** A modifier's recipe may carry negative amounts (oat milk: −195 ml fresh milk,
  +195 ml oat milk). Consumption nets options against the base recipe per line and never below zero.
- **Service then tax**, each rounded half-up; both default to 0 bps.
- **Stock is derived from immutable movements**, never stored as a balance. "Can make" is the lowest
  whole number of portions any recipe line allows; at `lowAt` or fewer the card says *Sisa N*, below 1
  the item is sold out by itself (a manager can keep selling it with *Tetap jual*).
- **Ingredients are consumed exactly once, at `order.prepare`** — when the ticket goes to the stations.
  A refund never restores stock. Lines carry their station, `preparedAt` and `readyAt`; a station marks
  its lines ready without touching the order revision, so the till and the tablets never conflict.
- **Immutable catalog versions.** Every order line stores its item's version and a copy of the name,
  price, recipe and options. Any immutable version is accepted on a line.
- **Counts.** `count.record` writes one `count` movement per line that differs (reason "Hitung <area>:
  <alasan>") plus a `counts` row for the variance report.
- **Business day** ends at the configured cutoff — default **04:00**, timezone **Asia/Jakarta**.
- **Operations are idempotent by operation id.** The server serializes writes per restaurant; `pull`
  asks from ten seconds before its last cursor and upserts, so nothing is lost or double counted.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Vite dev server on `0.0.0.0` so a tablet on the same Wi-Fi can open it |
| `pnpm build` | `tsc -b && vite build` → `dist/` |
| `pnpm test` | Vitest unit and integration tests (jsdom + fake-indexeddb) |
| `pnpm test:e2e` | Playwright end-to-end run against a real browser (demo mode) |
| `pnpm test:db` | PGlite: applies every migration, runs the RLS/RPC checks, regenerates `src/lib/database.types.ts` |
| `pnpm measure` | builds if needed, then gates the initial JS bundle |
| `pnpm staff` | owner-only staff provisioning; needs `.env.admin` (see [docs/SUPABASE.md](docs/SUPABASE.md)) |

Test results on this machine on 2026-11-08 (macOS, Node v25): `pnpm test` 180 passed in 9 files,
`pnpm test:db` 52 PostgreSQL checks passed, `pnpm test:e2e` 37 passed, `npx tsc -b` clean, `pnpm build` clean.

### What is NOT verified here

- Physical receipt and ticket printing (browser print only; no LAN / ESC-POS printer).
- Real Android tablets, install-to-home-screen and day-long battery behaviour.
- A hosted Supabase project: migration `202611060009_takar.sql` has been applied only to PGlite.
  Run `supabase db push` and `pnpm test:db` before the pilot, and use the Pro plan as the PRD says.
- Cloudflare Pages deployment as actually served.

## Limitations (deliberate)

- **One outlet per restaurant row; one POS device.** Linked outlets can transfer stock.
- **Offline is bounded to an authorized shift, 12 hours maximum.** No fresh sign-in of a new person
  while offline; the lock screen still works. Void, cash payment and close still work after the 12 hours;
  new work does not.
- **No offline card or QRIS.** Recorded only online, after the cashier confirms the merchant app.
- **Full-bill payment only; full refunds only, online, by a manager, within the original open shift.**
- **Recipe stock is an estimate until a count.** Counts are the correction, and they are logged.
- **Browser storage can be lost.** Persistent storage can be requested but never guaranteed; clearing
  site data on a device destroys its unsynced work. Export from *Lainnya* regularly.
- **Pull covers orders, shifts, cash, stock, counts, catalog and settings.** Purchase orders, catering
  orders and suppliers refresh at sign-in and when the same device writes them.

## Documentation

| Document | For | Contents |
|---|---|---|
| [docs/SUPABASE.md](docs/SUPABASE.md) | developer / administrator | project setup, the migrations, Auth settings, roles and PINs, device pairing |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | developer | Cloudflare Pages, build settings, headers, PWA checks |
| [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) | reviewer | the slices, the documented defaults, verified vs. externally unverified |
| [docs/superpowers/plans/2026-11-06-takar-phase1.md](docs/superpowers/plans/2026-11-06-takar-phase1.md) | developer | the task plan this phase was built from |
