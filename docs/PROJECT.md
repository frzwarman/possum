# Takar — project overview

> One document that explains the whole project: what it is, who it is for, how it is built, what it
> covers from the product requirements, how it looks, how to run and ship it, and what is still open.
> The other files in `docs/` go deeper on one topic each; this one is the map. Last updated 11 Nov 2026.

## 1. What Takar is

Takar (from *takaran*, a measured amount; tagline *Setiap gram tercatat*, "every gram, accounted for")
is a point of sale that also tracks stock to the gram. It replaces a POS whose stock is never right
and whose deleted sales hide fraud. Every sale, prep batch, delivery, count and waste entry becomes a
movement in one append-only stock ledger, so stock on hand is always the sum of what happened.

It was built for the **Ziggy Lounge pilot** (two weeks, decision on the incumbent system on
15 Nov 2026) on top of the earlier Possum / meja. POS codebase. The app speaks Bahasa Indonesia;
the documentation is in English with on-screen labels quoted.

The loop the product is built around:

```
open shift → take order → tell / send to stations → payment → receipt → close shift → manager review
 (float,      (pager no.,   (pilot: cashier tells    (cash quick  (print or  (count cash,   (Today, count
  PIN)         options)      bar and kitchen;         amounts,     share)     gap over the    approval,
                             tablets later)           QRIS)                   limit needs a   reports,
                                                                               manager PIN)    audit log)
```

## 2. Who uses it, on what

| Role (on screen) | Device | What they do |
|---|---|---|
| Kasir (cashier) | the one cashier tablet, **POS mode** | takes orders and payment, opens and closes the shift; on the Stock tab sees low and sold-out items, records batches and waste, counts after closing |
| Barista, Dapur (kitchen crew) | station tablets, **station mode** (switched off in the pilot) | see their own tickets, mark ready, log waste, make prep batches, count their area |
| Manajer, Pemilik (manager, owner) | laptop, **office mode**; the cashier tablet after closing, by PIN | menu and recipes, ingredients and receiving, count approval, Today, reports, audit log, team and devices; approve voids, discounts, refunds, cash gaps and adjustments with a PIN |
| Admin stok, Kepala dapur | laptop | ingredients, receiving, purchasing (admin); recipes (chef); both need a manager PIN to publish an active item without a recipe |

Two rules from the pilot: the cashier tablet never opens the manager screens while a shift is open,
and after closing the manager can sign in on that tablet with his PIN. A device is paired once by an
owner or manager (*Lainnya → Printer & perangkat*); an unpaired device is read-only.

## 3. What was built, against the PRD

Source documents, in order of authority for the pilot:

- `docs/superpowers/specs/2026-11-08-takar-pilot-prd.md` — the short pilot PRD (wins for the pilot)
- `docs/superpowers/specs/2026-11-06-takar-prd.md` — the full PRD, features F1–F8
- `docs/superpowers/specs/2026-11-06-takar-design-decisions.md` — 30 decisions mapping both onto the code
- `docs/superpowers/plans/2026-11-06-takar-phase1.md` — the task plan that was executed

### Pilot PRD: fully covered

One-screen POS (typo-tolerant search, dine-in default with the next pager number, option sheet, cash
and QRIS, open and close shift), stock deducted when the order is **paid** when there are no station
tablets, the cashier's Stock tab, recipes in grams including prep items, the manager's laptop (Today,
deliveries, count approval, reports, CSV export), manager PIN on void and discount, immutable log, a
PIN for every staff member, the till lock on the back office while a shift is open.

### Cashless revision (13 Nov 2026): covered

`docs/superpowers/specs/2026-11-13-takar-pilot-prd-cashless.md` supersedes the pilot PRD above where they differ:
cashless card or QRIS on an EDC (switch *Tanpa tunai* in *Lainnya → Restoran*), optional approval code, receipt
always prints, Compliment orders (staff meal, owner's family) with a monthly budget on Today, void one item with a
manager PIN, Orders search by number, name, item or approval code with filters, the close matching each EDC's
settlement slip after a stock count, and an "items lost" column on count review. Decisions 31–39. Not done: the
Figma table layout for Orders, a separate "Pending EDC" status, the WhatsApp add-on screens.

### Full PRD, phase 1 (F1–F8 minus PUR-1, PUR-2, MENU-6)

| Feature | Status |
|---|---|
| F1 Take an order (POS-1 … POS-8) | done; POS-5 prints through the browser, not a LAN printer |
| F2 Kitchen and bar stations (STN-1 … STN-5) | done; dark mode for the bar |
| F3 Menu and recipes (MENU-1, 2, 3, 5, 7) | done; MENU-4 has free-text tags but no "Create tag" prompt; MENU-6 (recipe approval) deferred by the PRD |
| F4 Prep batches (PREP-1 … PREP-4) | done |
| F5 Ingredients and receiving (ING-1, ING-2, PUR-3, PUR-4) | done; sanity check covers direct deliveries, not receipts against a PO; PUR-1 and PUR-2 deferred by the PRD |
| F6 Stock counts (CNT-1 … CNT-4) | done |
| F7 Today and automatic sold-out (TDY-1 … TDY-4) | done; push notifications only while Today is open in the browser |
| F8 Controls (CTL-1 … CTL-4) | done; no one-time code for a remote manager; audit log stores the operation payload rather than a literal before/after pair |

Not done, in the order worth closing before a wider rollout: sanity check on PO receipts; negative
stock shown in red with a count prompt; cross-unit conversion on an ingredient ("1 egg = 55 g");
audit log before-and-after columns; remote one-time approval code; LAN / ESC-POS printing; an
English UI. Phase 2 per the PRD: purchase orders from the low-stock list, supplier price comparison,
recipe approvals, bar and kitchen tablets, accounting, attendance.

## 4. How it is built

**Local-first PWA.** Vite 7, React 19, TypeScript strict, TanStack Router, Dexie (IndexedDB) with a
transactional outbox. Every write is a command that updates the local database and queues an
operation; `synchronize()` pushes the queue in time order to one Supabase RPC, `apply_operation`,
which re-checks every rule, then pulls what other devices changed (`pull`, from a cursor with a
10-second overlap). Station tablets pull every 5 s, the till every 10 s, laptops every 30 s. The
till keeps selling offline; conflicts resolve by replay, and rejected operations stay visible until
an owner discards them after an export.

**Server.** Supabase Postgres with RLS; ten migrations under `supabase/migrations/`; `202611060009_takar.sql` carries roles, device modes,
packs, areas, counts, approvals, the pull cursor and the audit log, and `202611130010_cashless.sql` the EDC
payments, compliments, line voids and the EDC settlement. `pnpm test:db` replays every migration in PGlite and regenerates
`src/lib/database.types.ts`.

**Domain.** `src/domain/` holds the types, the integer money and thousandths-of-a-unit quantity
rules, the recipe tree (ingredients, prep items, menu items, option groups as recipe deltas), "can
make", availability, the search, the sanity check, count maths, prep lists and expiry.

**Screens.** `src/features/`: pos, orders (with the receipt), station, inventory, production, counts,
today, reports, sales, purchases, catering, transfers, settings (menu and ingredient editors, devices,
team, CSV import), audit, auth (name + PIN sign-in), admin. The shell (`src/app/Shell.tsx`) shows the
88–96 px icon rail on the till and the full sidebar on the laptop.

**Demo mode.** "Jelajahi demo lokal" seeds a Ziggy-style catalogue with Unsplash photos into a local
database per role; nothing leaves the device.

## 5. How it looks

The visual system comes from the Figma file **TAKAR POS** (Design system page) and is encoded as CSS
variables at the top of `src/styles.css`: ink `#1B1D21` and lime `#D3F26A` as the brand, grey canvas,
white cards with 1 px borders and no shadows, radii 6/10/14/20, pills for chips and badges, pastel
stat cards (lavender, sky, mint, teal), Plus Jakarta Sans self-hosted. Lime is reserved for the one
primary POS action per view and the active nav item. The mark ("the pour") lives in
`src/components/logo.tsx` and `public/icon.svg`. Decisions 23–30 in the design-decisions document
list what matched and what did not (icons stay Lucide; the logo is redrawn from the construction
grid; dark shades beyond the five the file exposes are derived).

## 6. Run, test, ship

```
pnpm install
pnpm dev            # http://localhost:5173, reachable from a tablet on the same Wi-Fi
pnpm test           # Vitest, 180 tests
pnpm test:db        # PGlite, 52 checks, regenerates database.types.ts
pnpm test:e2e       # Playwright in demo mode, 37 tests (needs port 4173 free)
pnpm build          # tsc -b && vite build → dist/
pnpm staff          # provisioning (needs .env.admin; see docs/SUPABASE.md)
```

All five checks were green on 11 Nov 2026. The browser suite starts its own Vite server on port
4173; a second dev server on the same checkout, or another project answering on 4173, makes it fail.

**Database.** `supabase db push` applies new migrations; the hosted project has the first nine; `202611130010_cashless.sql` still needs a push.
**Frontend.** Cloudflare Pages: `pnpm build` then `pnpm dlx wrangler pages deploy dist`, with the two
`VITE_SUPABASE_*` variables set in the Cloudflare project. Order when both change: database first,
then frontend. `public/_headers` carries the security headers; its Content-Security-Policy allows
Supabase and Unsplash and nothing else. Details in `docs/DEPLOYMENT.md` and `docs/SUPABASE.md`.

## 7. Not verified on this machine

Real Android tablets (install, battery, touch), receipt and ticket printers, the hosted Supabase
project under load, the Cloudflare deployment as served, and the two-week pilot metrics (recipe
coverage, stock gap under 5 %, count time under 15 minutes). The PRD's open questions for the client
still stand: QRIS provider, printer models, PB1 and service charge rules, pilot date.

## 8. Where to look

| Question | File |
|---|---|
| How do I set up the backend, accounts and devices? | `docs/SUPABASE.md` |
| How do I deploy and what headers are sent? | `docs/DEPLOYMENT.md` |
| What did each build step add? | `docs/IMPLEMENTATION.md` |
| Why is it built this way? | `docs/superpowers/specs/2026-11-06-takar-design-decisions.md` |
| What was asked for? | the two PRDs under `docs/superpowers/specs/` |
| Day-to-day usage, roles, commands | `README.md` |
