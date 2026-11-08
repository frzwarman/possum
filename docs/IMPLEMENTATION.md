# Implementation checkpoints

Repository inspected: empty, no existing package manager or configuration. One Vite application, strict TypeScript, pnpm lockfile. No production credentials supplied.

1. Foundation: types and integer calculation rules; transactional Dexie command/outbox; isolated demo; login and primary device authorization; order/payment/receipt.
2. Service: drafts and saved orders, explicit preparation, printable kitchen changes, shift cash and close, dated reports.
3. Stock: immutable movements, versioned recipes, purchases and counts; menu/settings onboarding and CSV preview.
4. Reliability: idempotent SQL RPC, RLS tests, retry/recovery, PWA update controls, accessibility/browser tests, deployment and recovery runbooks.

Design: background #f6f5f0, surface #ffffff, ink #222c27, green #205c45, muted #647168, warning #925e16. System sans-serif, tabular money. Desktop left navigation / menu / receipt cart; phone bottom navigation and full-height cart dialog. Compact menu tiles with optional 420 px WebP photos and visible prices. Actions stay near the current order. Blank photos use the bundled food illustration, so images never become a setup dependency.

Defaults: IDR integer rupiah, quantities in thousandths of a base unit; 04:00 business-day cutoff; Asia/Jakarta; tax/service off; 12-hour shift authorization; single full-bill payment; full refunds only, online manager only. Refund never restores stock. Preparation consumes versioned recipe/add-ons/packaging once per line batch. Prepared lines are locked; additions get new line IDs; prepared cancellations leave consumption intact. Operational reporting starts at configured go-live date. Physical printing and Android hardware require external acceptance.

## Takar phase 1 (2026-11-06)

Built on the slices above from `docs/superpowers/specs/2026-11-06-takar-prd.md`, following
`docs/superpowers/plans/2026-11-06-takar-phase1.md`:

1. Domain: seven roles, device modes, option groups as recipe deltas, packs, areas, shelf life, stations on lines, count sessions.
2. Server (`202611060009_takar.sql`): per-kind role and device rules, `pull`, `audit_log`, `count.record`, variance and publish approvals, relaxed shift rules, no freshness windows.
3. Client core: `Commands` per-kind gating, `ready(station)`, `recordCount`, `closeShift(approval)`, `publish(approval)`, push-then-pull sync, pull cursor from bootstrap.
4. Screens: POS (search, pager, option sheet, availability, quick cash), Station, Settings (menu editor with groups and costs, ingredient editor with packs, device pairing, discard rejected op), Inventory (packs, photo, sanity check), Production (prep list, yield gap, expiring), Counts, Today, Reports (presets, food cost, waste, gap, print), Audit, Login (name + PIN), idle lock.

Verified here: `pnpm test` (179), `pnpm test:db` (51), `pnpm test:e2e` (35), `tsc -b`, `pnpm build`. An independent review pass (16 findings) was folded in before these numbers were taken. Not verified here: the hosted Supabase project, Android tablets, printers, Cloudflare.

## Ziggy Lounge pilot (2026-11-08)

From `docs/superpowers/specs/2026-11-08-takar-pilot-prd.md` (decisions 18–22 in the design-decisions doc): `settings.stationTablets` off hides the stations and moves stock at payment; cashier gets Stok / Produksi / Hitung stok; the till locks the back office while a shift is open (`tillLocked`, `Office` route wrapper, Reports and Inventory fall back to the cashier view); `count.submit` op and `counts.status` column; PIN provisioning for every role.

Verified here: `pnpm test` (180), `pnpm test:db` (52), `pnpm test:e2e` (37, incl. `tests/e2e/pilot.spec.ts`), `tsc -b`, `pnpm build`.
