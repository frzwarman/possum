# Meja — kasir restoran

A mobile-first point of sale for **one** Indonesian restaurant, built as a local-first
Progressive Web App. Everything the app says to its users is in Bahasa Indonesia; this
documentation is in English, with the on-screen labels quoted so you can match them.

Meja replaces the pen-and-paper loop a small warung already runs:

```
open shift → take order → kitchen → payment → receipt → review → close shift
 (count      (write the    (send the   (cash, or   (print or    (what sold,  (count the
  the float)  order down)   ticket)     verified    share the    what is      drawer, note
                                        QRIS/card)  text)        owed)        the variance)
```

Each of those steps already exists on paper. Meja keeps the same order, adds arithmetic
that cannot slip, and leaves a record the owner can read at closing time.

**Who it is for:** a single outlet with 2-10 staff, one primary cashier device, a phone or
tablet on the counter, and internet that is usually there but not always.

## Why local-first

The cashier must keep serving when the internet drops. Every action is written to the
device's own database first and queued for the server second, so a dead connection is a
sync delay, not a stopped queue of customers. The server remains the authority on money:
when the queue drains, Postgres re-validates every operation before accepting it.

```
  ┌──────────────────────── primary cashier device (Android / Chrome, PWA) ─────────────┐
  │                                                                                     │
  │  React 19 + TanStack Router                                                         │
  │        │ commands (src/lib/commands.ts)                                             │
  │        ▼                                                                            │
  │  ┌──────────── ONE Dexie transaction ────────────┐                                  │
  │  │  domain record (order / movement / shift)     │   ← what the screen reads        │
  │  │  + outbox operation (idempotent, has an id)   │   ← what the server will replay  │
  │  └───────────────────────────────────────────────┘                                  │
  │        │ synchronize() — in order, one at a time, stops on the first conflict       │
  └────────┼────────────────────────────────────────────────────────────────────────────┘
           │  HTTPS, authenticated as the signed-in staff member
           ▼
  ┌──── Supabase ──────────────────────────────────────────────────────────────────────┐
  │  Auth (email + password, sign-ups disabled)                                        │
  │  Postgres:  apply_operation(jsonb)  ← the ONLY write path. SECURITY DEFINER.       │
  │             re-derives every total, checks device/shift/role, then commits         │
  │  RLS on every exposed table; clients hold SELECT and nothing else                  │
  └────────────────────────────────────────────────────────────────────────────────────┘

  Static build (dist/) is served by Cloudflare Pages. It contains no secrets.
```

## Architecture

| Layer | Choice | Note |
|---|---|---|
| App | Vite 7 + React 19 + TypeScript (strict) | one SPA, no server rendering |
| Routing | TanStack Router | `/pos` eager, the other four routes lazy |
| Local database | Dexie (IndexedDB), `src/lib/db.ts` | one database per identity + device |
| Queue | transactional outbox in the same Dexie database | record and operation commit together or not at all |
| Sync | `src/lib/sync.ts` | Web Locks, ordered, batched, backs off, halts on rejection |
| Server | Supabase Postgres + Auth | one RPC, `apply_operation` |
| Authorization | RLS on all 16 exposed tables + explicit checks inside the RPC | clients have no write grants |
| Hosting | Cloudflare Pages (static) | see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| Offline shell | vite-plugin-pwa / Workbox, `registerType: 'prompt'` | never reloads itself mid-checkout |

## Data model and conventions

- **Money is integer rupiah.** No floats anywhere. `money()` rejects anything that is not a
  safe non-negative integer up to 1,000,000,000.
- **Quantities are thousandths of a base unit.** 1 kg = `1_000_000`, 1 l = `1_000_000`,
  1 pcs = `1_000`. Base units are `g`, `ml`, `pcs` and are immutable once an ingredient exists.
- **Service then tax**, each rounded half-up: `floor((x * bps + 5000) / 10000)`. Service is
  charged on subtotal minus discount; tax on subtotal minus discount plus service. Both
  default to **0 bps** — off.
- **Stock is derived from immutable movements**, never stored as a balance. The current
  quantity is the sum of `opening | purchase | waste | count | adjustment | preparation` rows.
- **Ingredients are consumed exactly once, at `order.prepare`** — when the ticket goes to the
  kitchen, not at payment. A second prepare on the same line is refused by both the device and
  the server.
- **A refund never restores stock.** Cooked food cannot be un-cooked. An *unprepared*
  cancellation is a different case: it consumed nothing, so there is nothing to restore.
- **Immutable catalog versions.** Every order line stores its item's catalog version and a copy
  of the name, price, recipe and modifiers. Re-pricing the menu publishes a new version; a
  receipt printed last week never re-prices. The database enforces this
  (`catalog_versions`, and `Catalog version immutable` in the RPC).
- **Business day** ends at the configured cutoff — default **04:00**, timezone
  **Asia/Jakarta** — so a sale at 01:30 belongs to the night before.
- **Operations are idempotent by operation id.** A replay returns the first result. The same
  id with a changed payload is rejected outright.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Vite dev server on `0.0.0.0` so a phone on the same Wi-Fi can open it |
| `pnpm build` | `tsc -b && vite build` → `dist/` |
| `pnpm preview` | serves the built `dist/` for a last look before deploying |
| `pnpm test` | Vitest unit and integration tests (jsdom + fake-indexeddb) |
| `pnpm test:e2e` | Playwright end-to-end run against a real browser |
| `pnpm test:db` | PGlite: applies the three migrations, runs the RLS/RPC checks, and regenerates `src/lib/database.types.ts` |
| `pnpm measure` | builds if needed, then gates the initial JS bundle against the budget |
| `pnpm staff` | owner-only staff provisioning; needs `.env.admin` (see [docs/SUPABASE.md](docs/SUPABASE.md)) |

## Test results, as measured on this machine

Run on 2026-09-21, macOS, Node v25.8.0:

| Check | Command | Result |
|---|---|---|
| Types | `npx tsc -b --force` | clean |
| Unit / integration | `npx vitest run` | **109 passed** in 7 files |
| Database | `node scripts/test-db.mjs` | **19 PostgreSQL integration checks passed** |
| End-to-end | `npx playwright test` | **3 passed** (Chromium, 1440×900) |
| Bundle | `node scripts/measure.mjs` | initial JS **260.5 KiB gzip** over 2 chunks (budget 250-300 KiB), CSS 8.4 KiB, lazy 17.8 KiB, PWA precache 287.5 KiB gzip over 13 files |

The database checks run against PGlite — real PostgreSQL, real migrations, an emulated
`auth.uid()` — not against a hosted project.

### What is NOT verified here

- **Physical receipt printing.** No printer is attached. See [docs/PRINTING.md](docs/PRINTING.md)
  and fill in [docs/HARDWARE.md](docs/HARDWARE.md).
- **Real Android hardware**, install-to-home-screen and day-long battery behaviour.
- **A hosted Supabase project**: live Auth, live RLS under real JWTs, live latency and
  free-tier limits.
- **Cloudflare Pages deployment**, its headers and redirects as actually served.

## Roles

| | Owner | Manager | Cashier |
|---|---|---|---|
| Take orders, send to kitchen, take payment | yes | yes | yes |
| Apply a discount | yes | yes | no |
| Void an order (with a reason) | yes | yes | no |
| Refund (full, online only) | yes | yes | no |
| Record stock (opening, purchase, waste, count, adjustment) | yes | yes | no |
| Publish menu / change settings | yes | yes | no |
| Server sales report | yes | yes | no |
| Enroll the primary device | yes | yes | no |
| Hand the primary device over | yes | no | no |

**Public registration is disabled.** The app has no sign-up screen. A fresh project is
bootstrapped once with `pnpm staff init <email> <nama>`, which creates the restaurant row and
its first owner; after that the owner creates each account from their own terminal with
`scripts/provision-staff.mjs` (`pnpm staff add …`),
which uses a service-role key kept in `.env.admin` — gitignored, never bundled, never
prefixed `VITE_`. Passwords are shown once.

**The owner area has its own door.** `/admin` is chosen from the URL before the cashier
router is mounted, so it never appears inside the staff app and never loads the cashier
shell, shift or device state: it has its own sign-in form, accepts only an active `owner`,
signs anyone else straight back out, and signs out separately. There the owner changes a
staff role or revokes access through the owner-only `manage_staff` RPC — an owner cannot
change their own row, so the restaurant keeps a way back in. Creating an account, resetting
a password and reading staff emails still need the terminal.

There is also a **local demo** on the login screen. It never contacts a server, seeds 12
sample menu items and 6 ingredients, and lives only in that browser.

## Cost and free-tier assumptions

Meja is designed to run on **Supabase Free + Cloudflare Pages Free**, which for one outlet
means an expected bill of **Rp 0** beyond the domain, if you choose to buy one.

- The frontend is static: a few hundred KiB per install, then cached. Pages Free allows 500
  builds/month and unmetered requests.
- The database load is one small RPC per operation — roughly one per order, preparation,
  payment, stock record and shift event. A busy day is thousands of rows, not millions.
- **Check usage monthly:** Supabase dashboard → *Reports* / *Usage* (database size, egress,
  monthly active users); Cloudflare dashboard → *Workers & Pages* → your project → builds.
- Supabase Free **pauses** a project after a week of inactivity, and free-tier storage,
  egress and backup retention are capped.

Plainly: free hosting is not an unlimited production guarantee. Exceeding those limits, or
needing stronger availability, point-in-time recovery or retained backups, means a paid plan
or a different deployment plan. Decide that before the restaurant depends on it, not after.

## Limitations

These are deliberate boundaries of this version, not bugs:

- **One outlet.** One restaurant row, one menu, one set of settings. No multi-branch.
- **2-10 staff.** `pnpm staff add` warns past 10 accounts and needs `--force`.
- **ONE primary cashier device** may record transactions. Any other signed-in device is a
  read-only dashboard. Moving the primary device is a deliberate, online, owner-only,
  reconciled handover — never automatic.
- **Offline is bounded to an already-authorized shift, 12 hours maximum.** No fresh login, no
  role change, no shift opening, no settings or menu change while offline.
- **No offline card or QRIS.** Those are recorded only online, and only after the operator
  confirms the payment in the merchant app; the server re-checks freshness within 2 minutes.
- **Full-bill payment only.** No split bills, no partial or multiple tenders per order.
- **Full refunds only, online, manager or owner, within the original shift while it is still
  open.** There is no partial refund.
- **Recipe-based stock is an estimate** until a physical count reconciles it. Yield, spillage
  and staff meals are not guessed; record a `count` and the difference becomes an explicit
  movement.
- **Browser printing cannot confirm that paper came out.** The app records "print requested"
  and a separate operator confirmation, and says so on screen.
- **Browser storage can be lost.** Persistent storage can be requested but never guaranteed;
  clearing site data or using private browsing on the cashier device destroys unsynced work.

## Documentation

| Document | For | Contents |
|---|---|---|
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | restaurant owner | installing on Android, the daily routine, outages, the paper fallback, reading the closing report |
| [docs/PRINTING.md](docs/PRINTING.md) | owner + developer | the printer abstraction, 58/80 mm layouts, the hardware acceptance checklist, what printing does not prove |
| [docs/HARDWARE.md](docs/HARDWARE.md) | tester | the fill-in sheet the app's test-print dialog points at |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | developer | Cloudflare Pages Free, build settings, headers, redirects, PWA checks |
| [docs/SUPABASE.md](docs/SUPABASE.md) | developer / administrator | project setup, the three migrations, Auth settings, device enrollment, verifying RLS, password recovery |
| [docs/BACKUP.md](docs/BACKUP.md) | administrator | the three different "backups", `pg_dump` and restore, identity recovery, validating a restore safely |
| [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) | reviewer | the four slices, the documented defaults, verified vs. externally unverified |
