# Takar on Possum: design decisions

Companion to `2026-11-06-takar-prd.md`. The PRD says what Takar must do; this file records how it is
built on the existing Possum (meja.) codebase, which the PRD names as the base. Phase 1 = F1–F8 minus
PUR-1 (purchase orders from the low-stock list), PUR-2 (supplier comparison) and MENU-6 (recipe
approvals). Purchase orders already exist in Possum and stay as they are.

## Intent

One app, three device modes (POS, Station, Back office), one append-only stock ledger. Every sale moves
stock through a recipe tree. Voids, discounts, refunds, adjustments, counts and cash gaps need a
manager PIN and leave an audit entry. The POS keeps selling offline.

## Kept from Possum (not re-decided)

- Local-first PWA: Dexie + transactional outbox + one `apply_operation` RPC; integer rupiah; quantities
  in thousandths of a base unit (g, ml, pcs); immutable catalog versions; stock = sum of movements;
  ingredients consumed when the ticket is sent (`order.prepare`); refund never restores stock;
  business day cutoff; 12-hour shift authorization; one primary till.
- Prep items = stock items with a `production` recipe (batch inputs + yield). A sale uses portions of
  the prep item; the raw ingredients left when the batch was made (PRD F4).
- Supabase Auth email + password; the owner provisions accounts from the terminal.

## Decided here

1. **Brand.** Visible name Takar, tagline "Setiap gram tercatat". Storage keys (`meja-identity`,
   `meja-device`, Dexie database names) stay, so existing installs keep their data.
2. **Roles.** `owner, manager, admin, chef, cashier, barista, kitchen`. Owner = brand account (super
   admin); manager = Toper; admin = inventory admin; chef = head chef. Approvers are owner and manager
   only. Back office screens open for owner, manager, admin, chef. Stations open for everyone except
   cashier-only accounts are also allowed (a waiter may check a ticket). Selling needs owner, manager
   or cashier. Server mirrors every rule per operation kind.
3. **Device modes.** A device is paired once by an owner/manager as `pos`, `station` or `office`
   (`enroll_device(device_id, mode)`). `pos` is the single primary till (existing semantics).
   Selling operations require the primary till; `order.ready`, waste, prep batches and counts are
   accepted from any paired device; back-office writes from any paired device. An unpaired device
   stays a read-only dashboard. Which station a station tablet shows (kitchen or bar) is a local
   setting on that tablet.
4. **Pull sync.** Non-primary devices never saw new work before. A `pull(since)` RPC returns orders,
   shifts, stock movements, cash movements and (when changed) catalog and settings received after
   `since`, filtered by role like `bootstrap`. `synchronize()` pushes then pulls; station devices poll
   every 5 s, the till every 10 s, back office every 30 s. Movement ids are the same on both sides
   (`<op>` or `<op>-<stock>`), so pulled rows upsert without double counting. Records with a pending
   local operation are not overwritten.
5. **Option groups as recipe deltas.** `MenuItem.groups: {id, name, kind: add|swap|level|size,
   required}` and `Modifier.group`, `Modifier.default`. A modifier's recipe may carry negative
   quantities: "Oat milk" = −195 ml fresh milk, +195 ml oat milk; "Less sugar" = −8 ml syrup; a size
   adds or removes cup and ingredient amounts. Consumption clamps each ingredient at zero per line.
   Totals, `calculate_total`, receipts and the immutable-snapshot rules are unchanged.
6. **Catalog fields.** Menu item: `type` (food|beverage|snack), `tags[]`, `aliases[]`, `station`
   (kitchen|bar), `lowAt` (Running-low threshold in portions, default 5), `groups[]`. The old free-text
   `category` stays as the type label so older rows and the server check keep working. Stock item:
   `aliases[]`, `area` (storage area), `packs[] {name, qty}` (pack size in thousandths of the base
   unit: "karton = 12 × 1 L" is `{name:'karton', qty:12_000_000}`), `shelfLife` hours (prep items),
   `station` (where the prep item is made). `threshold` is the par level.
7. **Can make / sold out.** `canMake(item, balances)` = min over recipe lines of floor(stock ÷ qty);
   empty recipe = unlimited. Running low at `lowAt` or fewer; sold out below 1 (auto, from local stock,
   refreshed by pull). A manager override is the existing `soldOut` flag plus a new `ignoreStock` flag,
   both published as a catalog version, so the override is in the audit trail.
8. **Stations and ready.** Lines carry `station` (from the item) and get `preparedAt` when sent and
   `readyAt` when the station marks them ready. `order.ready {id, station?}` marks that station's
   lines ready without bumping the order revision, so a station tablet and the till never conflict;
   `order.save` ignores `prep`/`readyAt` when checking immutability and re-applies the server's values.
   An order is `ready` when every prepared line is ready. Late = elapsed since `preparedAt` past the
   station target (settings `stations.kitchen` 15 min, `stations.bar` 8 min).
9. **Counts.** A count session is local (`counts` table) until submitted: area, lines, expected hidden.
   Review shows expected vs counted in units and rupiah (latest cost), sorted by rupiah gap, flagged
   over 5%. Approval sends one `count.record` operation (PIN approval for non-managers, action
   `count`) that writes one `count` movement per line, reason "Hitung <area>: <reason>", plus a
   `counts` row for history. Due dates: weekly for the 20 most-used ingredients (most preparation
   movements in the last 7 days), monthly for everything.
10. **Receiving.** Amounts can be typed in packs; cost per line; optional delivery-note photo (same
    WebP compression as menu photos; stored on the purchase row). Sanity check on the device: more
    than 5× or less than ⅕ of the median of the last 5 deliveries needs a second tap. Applies to
    `stock.record` purchases and PO receipts.
11. **Approvals.** New actions `count`, `variance` (shift close gap over `settings.varianceLimit`,
    default Rp10.000, for non-managers) and `publish` (publishing a catalog with an active item that
    has no recipe, for chef/admin). Lockout: 3 wrong PINs in 5 minutes (was 5 in 15). Remote one-time
    code (CTL-2 "on my phone") is deferred: the manager is on site in the pilot.
12. **Sign-in and lock.** Staff accounts use a 6-digit PIN as the Supabase password
    (`pnpm staff add … --pin`). After a manager has paired a device the device keeps the team list, so
    staff pick their name and type the PIN. POS and station devices lock after 2 minutes idle; unlock
    checks the PIN against a local hash, so it works offline.
13. **Audit log.** `audit_log(from, to)` reads `sync_operations` for sensitive kinds with actor, device
    mode, approver and the operation payload; the screen filters by person and kind and exports CSV.
14. **Today.** Manager home: sales, food-cost %, waste and usage gap for the day, plus everything
    waiting: low stock with days left (balance ÷ average daily use over 7 days), voids to review,
    flagged count gaps, items without a recipe, overdue counts, prep about to expire. Browser
    notifications fire for new low-stock items while the page is open; push to a closed phone is
    phase 2.
15. **Server rules relaxed to stop the outbox halting** (from the functional audit): the 120-second
    freshness window is removed for catalog, settings, refunds, shift open and non-cash payments (the
    device still requires a connection for them); an owner or manager may void orders in and close
    another person's shift; void, cash payment and close are accepted after the 12-hour expiry;
    any immutable catalog version is accepted on a line; a rejected operation can be discarded from
    the sync panel after a recovery export.
16. **Reports.** Day / week / month presets; food cost, waste value and usage gap added; CSV export
    is the Excel path; PDF is the browser's print of the report page. Batch invoices, Talenta,
    accounting and LAN/ESC-POS printing stay out (browser printing only).
17. **Language.** Bahasa Indonesia in the app, plain words (bahan, bahan olahan, menu, pilihan, stasiun,
    area simpan, par, hitung stok). English docs.

## Pilot addendum (2026-11-08)

From `2026-11-08-takar-pilot-prd.md` (the short Ziggy Lounge pilot PRD), on top of the decisions above:

18. **No station tablets.** `settings.stationTablets` (default off for a provisioned restaurant, on in the
    demo). Off: paying an order prepares every unprepared line first, so stock moves at payment; the
    "Ke stasiun" button, the Stasiun nav link and the Stasiun tab in Pesanan are hidden. The station
    code stays for the later tablets.
19. **The cashier keeps stock.** Cashier joins the crew grants (waste, prep, counts): Stok, Produksi and
    Hitung stok appear for every role. On the till with a shift open only waste can be recorded; purchases
    and adjustments stay with the admin and the managers.
20. **The till never opens the manager screens during a shift.** `tillLocked = primary && shift` hides the
    Back office group, `/today`, `/sales`, `/catering`, `/purchases`, `/transfers` and `/audit` redirect
    to `/pos`, Reports falls back to the cashier's blind view and Inventory to waste-only. An owner or
    manager who signs in on the tablet with a PIN after closing gets everything back; the laptop is never
    locked. Their PIN hash is never stored on a device, so the lock screen logs them out.
21. **Counts travel.** `count.submit` stores the submitted session server-side (`counts.status`), so a
    count taken on the tablet appears on the laptop as "Perlu ditinjau"; `count.record` approves it.
22. **PINs for every role.** `pnpm staff add … --pin` accepts a PIN for owners and managers too (with a
    warning); `team_json` lists every login so the name picker works for the manager on the tablet.

Still later, as the pilot PRD says: purchase orders, supplier comparison, recipe approval, bar and
kitchen tablets.

## Visual system (2026-11-08, from the Figma file "TAKAR POS")

The Figma file (view-only for the MCP connection, read through the browser) fixes the look; the app
now follows it. Decisions:

23. **Tokens.** Semantic colours as CSS variables on `:root` (`--ink #1B1D21`, `--lime #D3F26A`,
    `--canvas #EEF0F2`, `--surface #FFFFFF`, `--bg-subtle #F6F7F8`, `--bg-muted/--border #EBEDEF`,
    `--border-strong #C9CCD1`, `--text-secondary #6E737B`, `--text-disabled #9A9EA5`, status
    good/warning/critical/info fg+bg, station kitchen/bar fg+bg, `--level-fill #F2B233`, pastels
    lavender/sky/mint/teal). Dark values (`--canvas #101113`, `--surface #1B1D21`, `--text #F6F7F8`,
    `--text-secondary #9A9EA5`) apply under `.station.dark` and `[data-theme=dark]`; the other dark
    shades are derived, the file only exposes the light set to viewers. The old `--green/--muted/--paper/--bg`
    names alias the new tokens so nothing else had to move.
24. **Type.** Plus Jakarta Sans (self-hosted via `@fontsource-variable/plus-jakarta-sans`, works offline);
    body 14/20, labels 13 SemiBold, captions 12, micro 11, H1 28 Bold on pages, 22 SemiBold in sheets,
    32 Bold for the total due. Sentence case everywhere, no all-caps.
25. **Shape.** Radii 6/10/14/20; cards and rows 1 px border, no shadow; only floating sheets, toasts and
    menus get elevation. Buttons 48 px (POS actions 56 px), chips and badges are pills.
26. **Colour roles.** Ink is the primary button and the active chip; lime is the one primary POS action
    per view (pay, open or close shift, mark ready, record batch) and the active nav item; the level bar is
    green / kunyit / red; stat cards sit on lavender, sky, mint and teal in that order; danger buttons are
    solid red and always sit behind a manager PIN.
27. **Shell.** The back office keeps the 248 px white sidebar (outlet switcher, nav, profile); the till
    shows the 88 px icon rail from the design whenever the back office is closed on that device
    (`.sidebar.rail`), so the cashier sees Kasir, Pesanan, Sif & kas, Stok, Produksi, Hitung stok, Lainnya.
28. **Components rebuilt to the file.** Menu card (photo, name, price, level bar with "N tersisa",
    "Running low" / "Sold out" pills on the photo), order line (station badge, round stepper), chips with
    counts, order type segmented control, PIN pad (six dots + 3×4 pad) shared by sign-in, the lock screen
    and manager approvals, "Siapa yang bertugas hari ini?" person cards on sign-in, pastel stat cards,
    station ticket with a header block and a lime Mark ready.
29. **Logo.** "The pour" mark (T with a pouring stem and a lime drop) is drawn by hand from the brand
    sheet's 64-grid construction in `src/components/logo.tsx` and `public/icon.svg`; the file does not
    allow viewers to copy the SVG, so the geometry is a close match, not the exported asset.
30. **Icons stay Lucide.** The file uses Hugeicons; Lucide has the same 1.5 px stroke language and is
    already everywhere in the code, so no icon dependency was swapped.

### Cashless pilot revision (13 Nov 2026)

Source: `2026-11-13-takar-pilot-prd-cashless.md` and Figma "Ziggy pilot: Product" (C0–C12, M1–M8) with its 19 comments.
Server contract: `supabase/migrations/202611130010_cashless.sql`.

31. **Cashless is a switch, not a rewrite.** `settings.cashless` (with `settings.edcs`, default BCA, BRI, Mandiri) hides
    cash, the opening float and the drawer; the cash path stays for other outlets. The server refuses cash when it is on.
32. **EDC payment.** Card or QRIS plus the machine; the approval code from the slip is optional (≤30 chars) and is
    searchable on Orders and the close. Stored on the order's `payment` and on `payments.edc` / `approval_code`.
33. **The receipt always prints** in cashless mode: the receipt dialog requests the print as it opens. No switch.
34. **Compliment is a third order mode** (`mode:'compliment'`, `compliment:{kind:'staff'|'family',who}`), per the PRD
    rule (the Figma comment "rules staff sama owner sama" was overruled by the user): staff meal = drinks free, food
    half price (the discount rounds down); owner's family = everything free, paid with method `none`. The discount is
    the rule's, recomputed by the server (`compliment_discount`, drink = catalog type or a drink-like category, the same
    rule as `menuType()`), so it needs no PIN. No tax or service on a compliment (`order_total`). Compliments still move
    stock, are excluded from sales everywhere (`isSale`, `sales_report`) and sum against `settings.complimentBudget`
    on Today.
35. **Void an item** (`order.voidline`): a made line on an open or paid order of the current shift, manager's PIN,
    reason and approver kept on the line, totals (and a compliment's discount) recomputed. The last line is voided
    with the whole order (or refunded) instead. Stock stays deducted as preparation; it is not reclassified as waste.
    On a paid order the cashier voids the difference on the EDC too, and the settlement expects the new total.
36. **The cashless close** replaces the drawer count: each EDC's slip against the sum of that machine's paid orders.
    The PIN threshold is the sum of each machine's absolute gap, so a short and an over machine never cancel out.
    `shifts.settlements` keeps `[{edc,expected,slip}]`. The cashier sees Takar's expected amount per EDC (a slip is
    machine-printed, so a blind count adds nothing).
37. **Count before close** is enforced on the till only: the close button stays off until a count was sent since the
    shift opened. The server does not check it.
38. **Items lost** on count review: a shortfall divided by the per-portion use of the active menu item that needs the
    most of that ingredient, so the estimate errs low (−50 g espresso beans ≈ 3 espresso).
39. **Orders keeps its cards** (the Playwright specs select `.order-card`) and gains the Figma's functions: search by
    number, name, item or approval code; Paid / Unpaid / Voided / Compliment filters with counts; sort; payment and
    approval code on each card; void an item in the detail. The Figma table-and-side-panel layout is not copied yet.
    Left out: "Pending EDC" as its own status (an unpaid order is the pending one), and all WhatsApp screens
    (C6b, C11b, C11c, C12, P1, P2), which the PRD prices as an add-on after the pilot.

## Left to the builder

Exact copy, icons and layout; CSS for the new screens (reuse the existing panel, stock-row, metric and
order-card styles); sample demo data for the new fields; test wording.
