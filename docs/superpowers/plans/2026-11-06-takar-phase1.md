# Takar phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Possum (meja.) into Takar phase 1: stations, option groups that move stock, prep batches with shelf life, pack-based receiving with sanity checks, guided counts with variance approval, a Today screen, six roles with PIN sign-in and an append-only audit log, across paired POS / station / back-office devices.

**Architecture:** Keep the local-first outbox and the single `apply_operation` RPC. Add a `pull` RPC so every paired device sees new work; add device modes and per-kind role/device rules in one new migration (0009) that re-creates `apply_operation`, `bootstrap`, `enroll_device`, `approve`, `manage_staff`. On the client extend the domain types, `Commands`, `synchronize` and the screens; new screens are Station, Count, Today, Audit.

**Tech Stack:** Vite 7, React 19, TypeScript strict, TanStack Router, Dexie, Supabase (Auth + Postgres), Vitest, Playwright, PGlite for migration tests. Source files keep the repository's compact style; no reformatting.

**Spec:** `docs/superpowers/specs/2026-11-06-takar-prd.md` + `docs/superpowers/specs/2026-11-06-takar-design-decisions.md`

## Global Constraints

- Money integer rupiah ≤ 1e9; quantities thousandths of base unit ≤ 1e12 (existing `money()`, `convert()`).
- Every client-side rule that the server enforces is mirrored in `Commands` (a rejected op halts the outbox).
- UI copy in Bahasa Indonesia, plain words; roles in `roleLabel`.
- Base unit immutable; catalog versions immutable; movement ids `<opId>` or `<opId>-<stockId>` on both sides.
- `pnpm build`, `pnpm test`, `pnpm test:db`, `pnpm test:e2e` green after every task.

## Review Focus

1. A station tablet marks lines ready while the till is saving the same order: the till's save must still be accepted (Task 2 test "ready does not bump revision", Task 3 test "save keeps server readyAt").
2. A swap option whose negative delta exceeds the base recipe: consumption must clamp at zero, on both sides (Task 1 `consumption` test, Task 2 DB test).
3. Pull after a local operation that already synced: the pulled movement with the same id must not double count (Task 3 sync test).
4. A delivery typed as "2,5 karton": decimal comma and pack conversion must give 2.5 × pack size (Task 1 `convert` test).
5. A cashier closing a shift with a Rp10.001 gap needs a PIN; Rp10.000 does not (Task 11 unit test).

---

### Task 1: Domain model and calculations

**Files:**
- Modify: `src/domain/types.ts`, `src/domain/calculate.ts`, `src/domain/sample.ts`, `src/domain/permissions.ts`
- Test: `tests/unit/calculate.test.ts` (append), `tests/unit/search.test.ts` (new)

**Interfaces (produces):**
- `Role = 'owner'|'manager'|'admin'|'chef'|'cashier'|'barista'|'kitchen'`; `Station = 'kitchen'|'bar'`; `DeviceMode = 'pos'|'station'|'office'`.
- `Identity` gains `mode: DeviceMode|null` (null = unpaired) and keeps `primary`.
- `MenuItem` gains `type: 'food'|'beverage'|'snack'`, `tags: string[]`, `aliases: string[]`, `station: Station`, `lowAt: number`, `ignoreStock: boolean`, `groups: OptionGroup[]`; `Modifier` gains `group?: string`, `default?: boolean`.
- `StockItem` gains `aliases: string[]`, `area: string`, `packs: Pack[]` (`{name: string; qty: number}`), `shelfLife?: number`, `station?: Station`.
- `Line` gains `station: Station`, `preparedAt?: string`, `readyAt?: string`.
- `Settings` gains `stations: {kitchen: number; bar: number}`, `varianceLimit: number`, `lowAt: number`.
- `ApprovalAction` adds `'count'|'variance'|'publish'`; `OpKind` adds `'count.record'`.
- New `CountSession {id; area; status:'draft'|'submitted'|'approved'; lines:{stockId; counted?: number}[]; startedBy; startedAt; submittedAt?; approvedAt?; approvedBy?}`.
- `Movement` gains `photo?: string`.
- `calculate.ts`: `convert(qty, unit, base, packs?)` accepts a decimal comma and a pack name as `unit`; `consumption()` clamps per line per stock at 0; `canMake(item, balance: (id)=>number)`, `search(items, q)` (name/aliases/tags, case-insensitive, diacritic-free, typo tolerant via subsequence + Levenshtein ≤ 2 on words), `sanity(qty, history: number[])` → `'ok'|'high'|'low'`, `countGap(expected, counted, unitCost)`, `usagePerDay(movements, stockId, days=7)`, `daysLeft(balance, perDay)`.
- `permissions.ts`: `can(role, action)` with actions `sell|station|backoffice|approve|catalog|inventory|counts|settings|team|audit`; `roleLabel`/`roleTitle` for 7 roles; `access` table rewritten.

- [ ] Write failing tests in `tests/unit/calculate.test.ts`: `convert('2,5','kg','g')===2_500_000`; `convert('2','karton','ml',[{name:'karton',qty:12_000_000}])===24_000_000`; `consumption` with modifier recipe `[{stockId:'milk',qty:-300_000}]` on base `[{stockId:'milk',qty:195_000}]` gives 0 for milk; `canMake` picks the minimum and returns Infinity for an empty recipe; `sanity(60_000,[10_000,10_000,12_000])==='high'`, `sanity(1_000,…)==='low'`, fewer than 3 deliveries → `'ok'`; `countGap` flags when |gap| > 5% of expected.
- [ ] Write `tests/unit/search.test.ts`: `search(menu,'amer')` and `search(menu,'amricano')` both return the Americano items; alias match; tag match; empty query returns all.
- [ ] Run `pnpm test -- tests/unit/calculate.test.ts tests/unit/search.test.ts` → fails on missing exports.
- [ ] Implement the types, helpers, `sample.ts` (Ziggy-style demo: Americano hot/iced with aliases, Ice Matcha Latte with size/milk/sugar groups, Ziggy Fried Rice with ayam ungkep prep item, areas, packs, stations) and `permissions.ts`.
- [ ] Run `pnpm test` → all pass; `npx tsc -b` → clean (fix every compile error the new fields cause across the app by giving defaults where the UI builds items).

### Task 2: Migration 0009 (server contract)

**Files:**
- Create: `supabase/migrations/202611060009_takar.sql`
- Modify: `scripts/test-db.mjs` (new tests), `scripts/provision-staff.mjs` (roles, `--pin`)

**Produces:**
- Schema: `memberships.role` check for 7 roles; `devices.mode text check in (pos,station,office) default 'pos'`; `inventory_items` columns `aliases jsonb`, `area text`, `packs jsonb`, `shelf_life int`, `station text`; `purchases.photo text`; `counts` table `(restaurant_id, id uuid, area text, actor uuid, approver text, lines jsonb, occurred_at, operation_id uuid)`; `approvals.action` check adds `count, variance, publish`.
- `enroll_device(device_id uuid, mode text default 'pos')`: pos keeps primary semantics; station/office just insert/un-revoke the device row with that mode.
- `approve(...)`: lockout 3 failures in 5 minutes; actions extended.
- `manage_staff(target, new_role, new_active)`: 7 roles; owner and manager may call it (manager may not touch owners).
- `bootstrap(device_id)` returns additionally `device: {mode, enrolled}`, `team: [{id,name,role}]`, `now`, `counts` (last 50), and stock rows with the new columns.
- `pull(since timestamptz)` returns `{now, orders, shifts, cash, movements, counts, catalog?: {menu, stock}, settings?}` for rows with `received_at`/`updated_at` > since, role-filtered like bootstrap.
- `audit_log(from_day date, to_day date)` returns rows `{id, kind, at, actor, actorName, device, mode, approvedBy, payload}` for kinds `order.void, refund.record, shift.cash, stock.record, count.record, catalog.publish, settings.update, shift.close` and `order.save` when the discount changed.
- `apply_operation`: per-kind role table and device rule (primary for shift/order/payment/refund kinds; any enrolled device otherwise); no 120 s freshness checks; owner/manager may `shift.close`/`order.void` on another actor's shift; `order.void`, cash `payment.record` and `shift.close` allowed after expiry; `order.ready` with optional `station` sets `readyAt` on prepared lines of that station, no revision bump, no expectedRevision; `order.prepare` stamps `preparedAt` and uses per-line clamped consumption; `order.save` compares prepared lines ignoring `readyAt`, ignores client `prep`, recomputes `prep`; `validate_recipe(rid, recipe, allow_negative)` for modifier recipes; `catalog.publish` validates and stores the new item and stock fields and needs approval `publish` when the actor is not owner/manager and an active item has an empty recipe; `count.record` writes movements + `counts` row with approval `count` for non-managers; `shift.close` needs approval `variance` when |variance| > settings.varianceLimit and actor is not owner/manager; `stock.record` accepts `photo` (stored on `purchases`) and is allowed for `admin, chef, kitchen, barista` only for kinds `waste` (and `purchase` for admin).
- [ ] Add DB tests to `scripts/test-db.mjs`: migration applies; `enroll_device(station)` does not change the primary; a kitchen member on a station device can `order.ready` and `stock.record waste` but not `payment.record`; `order.ready` keeps `revision`; `order.save` after a station ready is accepted and keeps `readyAt`; swap option consumption clamps at 0; `count.record` by admin needs approval, by manager not; `shift.close` with gap > limit by cashier needs `variance` approval; `pull(since)` returns the order created after `since` and nothing before; `audit_log` lists the void with its approver; 3 wrong PINs lock.
- [ ] Run `pnpm test:db` → new tests fail (functions missing).
- [ ] Write the migration (full re-creations of the five functions, following 0008's style).
- [ ] Run `pnpm test:db` → all pass; `database.types.ts` regenerated.

### Task 3: Client core (commands, sync, context, login)

**Files:**
- Modify: `src/lib/commands.ts`, `src/lib/sync.ts`, `src/lib/db.ts` (Dexie v5: `counts` table; meta `pullCursor`), `src/app/context.tsx`, `src/features/auth/Login.tsx` (bootstrap), `src/lib/database.types.ts` (generated)
- Test: `tests/unit/commands.test.ts`, `tests/unit/sync.test.ts`, `tests/unit/offline-harness.ts`

**Produces:**
- `Commands.run` gating: selling kinds need `user.primary`; other kinds need `user.mode` (paired); demo always allowed. `Commands.allowed(kind)` uses `can()`.
- `Commands.ready(id, station?)`, `Commands.stockRecord(..., photo?)` (role check via `can(role,'inventory')` or waste for station roles), `Commands.recordCount(session, reasons, approval?)` → `count.record`, `Commands.publish(menu, stock, approval?)` (needs `publish` approval when chef/admin publishes an active item without a recipe), `Commands.closeShift(counted, approval?)` (variance approval), `Commands.prepare` stamps `preparedAt` + `station`, `Commands.save` keeps the stored order's `prep`/`readyAt`.
- `synchronize(db, user, transport, puller?)`: push, then `pull(cursor)` and merge (skip records with pending ops; movements upsert by id; catalog replaced when no pending `catalog.publish`).
- `useApp()` additionally exposes `balances: Map<string,number>`, `canMake(item)`, `counts`, `mode`, `station` (local setting), `office = can(role,'backoffice')`.
- `bootstrap()` stores `device.mode`, `team` (localStorage `takar-team`) and `pullCursor`.
- [ ] Tests: `ready('kitchen')` marks only kitchen lines and leaves revision; `save` after a ready keeps `readyAt`; a station-mode identity may `ready` and `stockRecord('waste')` but `save` throws `Transaksi hanya di perangkat kasir utama`; `recordCount` writes one count movement per line with the right delta and one outbox op; `closeShift` with gap > `varianceLimit` by a cashier needs an approval; pull merge: a pulled movement with the id of a local synced one does not duplicate, and a pulled order with a pending local op is skipped.
- [ ] Run tests → fail; implement; run `pnpm test` → pass; `npx tsc -b` clean.

### Task 4: POS

**Files:**
- Modify: `src/features/pos/Pos.tsx`, `src/features/orders/Receipt.tsx`, `src/styles.css`
- Test: `tests/e2e/pos-flow.spec.ts`, `tests/e2e/meja.ts`, `tests/e2e/regressions.spec.ts`, `tests/e2e/rbac.spec.ts` (labels)

- Search uses `search()` over name/aliases/tags; filters `Semua / Makanan / Minuman / Camilan`.
- New cart starts `dinein` with label = next pager number (max numeric label among today's orders + 1, shown as "Pager 12", editable, `maxLength={100}`).
- Option sheet: groups rendered as radio rows (swap/level/size, with a "biasa" base choice) or checkboxes (add); defaults preselected; price updates live; each choice shows its stock effect ("ganti susu segar → oat, +Rp5.000").
- Menu cards: `canMake` → disabled "Habis · bahan kurang" or "Sisa N" badge; manual `soldOut` still wins.
- "Kirim ke stasiun" button (replaces "Ke dapur"); lines carry `station`.
- Payment: quick amounts Uang pas / 50k / 100k / 200k, change in large type; QRIS checkbox kept.
- Pay/save use the live order revision from `orders`.
- [ ] Update e2e helpers for new labels; add e2e "options sheet changes price and stock effect text"; run `pnpm test:e2e` → pass.

### Task 5: Station screen and orders

**Files:**
- Create: `src/features/station/Station.tsx`
- Modify: `src/main.tsx` (route `/station`), `src/app/Shell.tsx` (nav per role/mode, dark class), `src/features/orders/Orders.tsx` (kitchen tab → per station, uses `readyAt`), `src/features/orders/Receipt.tsx` (ticket per station), `src/styles.css` (`.station-*`, `.dark`)
- Test: `tests/e2e/station.spec.ts`

- Station picker (kitchen/bar) stored in localStorage `takar-station`; big type; oldest first; pager number; options under each item; red after target; "Siap" per ticket → `commands.ready(id, station)`; waste dialog (item, amount, reason preset: rusak, jatuh, salah pesanan, kedaluwarsa, makan staf) → `stockRecord('waste')`; prep list + expiring prep (Task 8 helpers); quick count link (Task 9).
- [ ] e2e: send an order with a food and a drink; bar station shows only the drink; mark ready; Pesanan shows the order still preparing until the kitchen marks ready; then "Siap".

### Task 6: Menu, ingredients and device settings

**Files:**
- Modify: `src/features/settings/Settings.tsx`, `src/lib/import.ts`, `src/styles.css`
- Test: `tests/unit/import.test.ts`, `tests/e2e/backoffice.spec.ts`, `tests/e2e/regressions.spec.ts`

- Menu editor: type, tags (free text with datalist, "Buat tag"), aliases, station, lowAt, ignoreStock, photo, recipe lines by search with unit select (g/kg, ml/L, pcs, packs), live cost / margin / food-cost %, option groups editor (kind, choices with price and recipe delta expressed as "ganti X dengan Y", "kurangi X", "tambah X").
- Stock editor: aliases, area (datalist of existing areas), packs ("1 karton = 12.000 ml" sentence), par, shelf life + station for prep items.
- Items without a recipe flagged in the list; publishing with one by chef/admin asks for the `publish` PIN.
- Device panel: pair as Kasir / Stasiun / Back office (owner/manager), shows mode; settings form gets station targets and variance limit.
- Sync panel: "Buang operasi ini" for rejected ops after a recovery export; default tab by role.
- CSV import: menu columns `name,type,price` (category accepted and mapped), stock columns add `area,pack_name,pack_qty`.
- [ ] Unit test for the import mapping; e2e: create an item with a swap group and sell it (ties to Task 4).

### Task 7: Inventory and receiving

**Files:**
- Modify: `src/features/inventory/Inventory.tsx`, `src/features/purchases/Purchases.tsx`, `src/lib/menu-photo.ts` (export generic `compressPhoto`)
- Test: `tests/e2e/backoffice.spec.ts`

- Movement history with running balance, person, kind; filter by area; units in packs or loose; delivery photo; sanity warning with converted total and usual amount, confirm on second tap; waste reasons preset.
- [ ] e2e: receive 2 karton of milk → balance +24.000 ml; receiving 20 karton shows the sanity warning.

### Task 8: Prep batches

**Files:**
- Modify: `src/features/production/Production.tsx`, `src/domain/calculate.ts` (`prepList`, `expiring`)
- Test: `tests/unit/calculate.test.ts`, `tests/e2e/backoffice.spec.ts`

- Prep list: prep items at or below par with suggested batches `ceil((2·par − balance) ÷ yield)`, most urgent first; batch dialog records actual yield and logs the gap in the reason; expiring = production movements older than `shelfLife − 2h`, "Buang sisa" wastes `min(balance, batch qty)`.

### Task 9: Counts

**Files:**
- Create: `src/features/counts/Counts.tsx`
- Modify: `src/main.tsx` (`/counts`), `src/app/Shell.tsx`, `src/styles.css`
- Test: `tests/e2e/counts.spec.ts`

- Start a count for an area (or "semua"); inputs in packs or loose, expected hidden; pause/resume (session persisted in Dexie); submit → review (manager): expected vs counted, rupiah gap, sorted, flagged > 5%, reason per flagged line; approve → PIN for non-managers → `recordCount`. Due list (weekly top 20, monthly all).
- [ ] e2e: count rice short by 500 g → review flags it → approve → stock shows the counted amount and the movement reads "Hitung Dry store".

### Task 10: Today and reports

**Files:**
- Create: `src/features/today/Today.tsx`
- Modify: `src/main.tsx` (`/today`, office roles land there), `src/features/reports/Reports.tsx` (presets, food cost, waste, usage gap, print), `src/app/Shell.tsx`
- Test: `tests/e2e/today.spec.ts`

- Cards: sales, food-cost %, waste, usage gap; lists with links: low stock + days left, voids today, flagged count gaps, no-recipe items, overdue counts, expiring prep. Notification permission button; notify on new low-stock items.

### Task 11: Controls

**Files:**
- Modify: `src/features/reports/Reports.tsx` (variance PIN), `src/app/Approval.tsx` (new actions copy), `src/features/auth/Login.tsx` (staff picker + PIN), `src/app/Shell.tsx` (idle lock), `src/features/admin/Admin.tsx` (roles), `scripts/provision-staff.mjs`
- Create: `src/features/audit/Audit.tsx` (`/audit`)
- Test: `tests/unit/commands.test.ts` (variance boundary), `tests/e2e/rbac.spec.ts`

- Shift close: gap over limit → cashier gets the PIN dialog (`variance`, amount = |gap|).
- Login: if `takar-team` cached → name picker + PIN (password), else email form; demo picker lists all 7 roles.
- Idle lock after 2 min on pos/station: overlay, PIN check against `sha256(pin+user.id)` stored at sign-in; "Ganti pengguna" signs out.
- Audit page: server `audit_log` with filters and CSV; offline fallback to the local list from Reports.

### Task 12: Brand, docs and cleanup

**Files:**
- Modify: `index.html`, `vite.config.ts`, `package.json` (name), `public/icon.svg`, `src/app/Shell.tsx`, `src/features/auth/Login.tsx`, `README.md`, `docs/SUPABASE.md`, `docs/IMPLEMENTATION.md`, `src/features/catering/Catering.tsx` (DP > total guard, re-stamp lines on edit), `src/lib/commands.ts` (deliver fallback recipe)
- [ ] `pnpm build && pnpm test && pnpm test:db && pnpm test:e2e` all green; README describes Takar, roles, device modes, pull sync, counts, audit, limitations and the phase-2 list.
