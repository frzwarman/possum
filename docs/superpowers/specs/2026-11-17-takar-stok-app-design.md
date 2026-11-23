# Takar Stok: phone app for stock counts and deliveries

Status: approved on 17 Nov 2026 and built on branch `worktree-stock-app`. How to run, pair and build the app is in
[docs/MOBILE.md](../../MOBILE.md); the task plan is in [plans/2026-11-17-takar-stok-app.md](../plans/2026-11-17-takar-stok-app.md).

## Intent

Staff count stock (stock opname) and record deliveries on a phone, by scanning the item's barcode with the camera.
Everything lands in the same Supabase database Takar uses, so the POS, the Stok page and the reports see it at once.

Why: the PRD names the problem directly ("Deliveries are not entered; stock opname was skipped for 3 months") and
sets the bar ("Receiving and counting must take minutes"). A phone in the storeroom is faster than walking a tablet
or a laptop to the shelves, and scanning removes the step where people pick the wrong bahan from a long list.

## Goals

1. Count an area in minutes: scan an item, type how much is there, next. The system amount stays hidden.
2. Record a delivery in minutes: scan each item that arrived, type the amount in packs and the price, save.
3. A count or delivery entered with no signal is never lost. It is sent when the phone is back online.
4. One set of rules. Permissions, approvals and the audit log stay on the server, as they are for the web app.
5. One set of unit maths. The phone uses Takar's own code for packs, kg/L conversion and the delivery sanity check.

## Non-goals (not in this version)

- Receiving against a purchase order. Deliveries are recorded without a PO, like "Terima kiriman" on the Stok page.
- Approving a count on the phone. The manager still reviews and approves in Takar (PIN or Telegram).
- Waste, production batches, transfers between outlets.
- Printing barcode or QR labels for items that have none.
- An iPhone release. The code runs on iPhone, but installing it on staff iPhones needs an Apple developer account.
- A screen in Takar web to manage barcodes or to list and revoke paired phones.

## Anti-goals (would make it a failure even if it works)

- Showing the expected stock to the person counting. The count must stay blind.
- Losing a finished count or delivery because of a dead spot or a closed app.
- Stock changing through any path other than `apply_operation`.
- A second copy of the unit and pack maths that drifts from Takar's.

## Constraints

- **Server rules that already exist and do not change**
  - Every role may count (`count.submit`). A count changes stock only after a manager approves it (`count.record`).
  - Only owner, manager and admin stok may record a delivery (`stock.record`, kind `purchase`).
  - `apply_operation` refuses a device that is not paired. Only an owner or manager may pair a device.
  - An operation older than 7 days, or stamped more than 2 minutes in the future, is refused.
  - A delivery-note photo must be a WebP data URL of at most 70.000 characters (about 52 KB).
- **This Mac**
  - No Xcode and no Android SDK, so no installable app file can be built here today.
  - Node 25. Expo 58 lists Node 22, 24, 26 or newer. The first build step checks whether Expo runs on 25; if not,
    Node 24 is added alongside (`brew install node@24`), which is the user's call.
  - No Docker, so there is no local Supabase stack. Database tests run on PGlite, as they do today.
- **The repo**
  - Another session is editing `main` right now (18 files changed, one new migration). This work happens on its own
    branch in a worktree and touches as few existing files as possible. It is merged only when the user says so.
  - Nothing is applied to the hosted Supabase project without the user's go-ahead.
- **Stack versions** (current on 17 Nov 2026): Expo SDK 58, React Native 0.88, `expo-camera` 58 (barcode scanning
  built in, works in Expo Go), `@supabase/supabase-js` 2.

## Approaches considered

**How the app reaches phones**

| Option | Trade-off | Decision |
| --- | --- | --- |
| A phone mode inside the Takar web app | One codebase, no store, shares sign-in and the offline queue. Scanner runs in the browser. | Recommended by me, not chosen |
| A separate native app | A real app with a native scanner. Sign-in and the offline queue are built a second time. | **Chosen by the user** |

**How the native app is built** (the user chose React Native)

| Option | Trade-off | Decision |
| --- | --- | --- |
| Expo, offline-ready | Reuses Takar's unit maths, a small queue on the phone holds work until there is signal. Try it with Expo Go. | **Chosen by the user** |
| Expo, online only | Less code. A count entered where there is no signal fails when saving. | Rejected: storerooms have the worst signal |
| React Native without Expo, Vision Camera | Most tunable scanner. Needs Xcode and Android Studio here first, no quick try on a phone. | Rejected: can be swapped in later |

## The design

### Who can do what

| Action | Who | Rule lives in |
| --- | --- | --- |
| Count stock and send it for review | every role | `apply_operation` (unchanged) |
| Record a delivery | owner, manager, admin stok | `apply_operation` (unchanged) |
| Link a barcode to a bahan, or move or remove a link | every role | new `link_barcode` / `unlink_barcode` |
| Pair a phone | owner, manager | new `enroll_phone` |

A role that cannot receive sees "Terima barang" greyed out with the line "Hanya pemilik, manajer atau admin stok".

### Screens

All text is Indonesian. Colours and type follow Takar's live tokens in `src/styles.css` (ink `#1B1D21`, lime
`#D3F26A`, canvas `#EEF0F2` with white surfaces, Plus Jakarta Sans).

**1. Masuk.** Same idea as the shared tablet: tap your name, type your 6-digit PIN.

```
 takar stok                    Ziggy Lounge
 Siapa yang bertugas?
 [KI Kinoy · Barista ] [TO Toper · Pemilik]
 [AD Adit · Admin stok] ...
 Masuk dengan email      Coba demo
```

- The names come from the team list the server returned the last time someone signed in on this phone.
- A new phone has no list yet, so the first sign-in is by email and password.
- The PIN is the password of that person's login, exactly as on the web.

**2. Pasangkan ponsel.** Shown only when the server says this phone is not paired.

- Owner or manager: one button, "Pasangkan ponsel ini".
- Anyone else: "Ponsel ini belum dipasangkan. Minta pemilik atau manajer masuk di ponsel ini sekali."

**3. Beranda.**

```
 Hai Adit · Admin stok            Ganti
 ● Tersinkron            (or: 3 belum terkirim)
 ┌───────────────┐ ┌───────────────┐
 │  Hitung stok  │ │ Terima barang │
 └───────────────┘ └───────────────┘
 Dijeda
  Bar · 12 dari 40 dihitung     Lanjutkan
 Terkirim hari ini
  Gudang · menunggu persetujuan manajer
```

**4. Hitung stok.** Pick an area (or "Semua area"), then count.

```
 ← Hitung: Bar            12 dari 40   Jeda
 ┌─────────── kamera ───────────┐  [senter]
 │      arahkan ke barcode      │
 └──────────────────────────────┘
 [ Ketik kode atau cari nama bahan      ]
 Susu UHT Full Cream
  Karton penuh [ 2 ]   Karton terbuka [ 5 ] L
  = 29.000 ml
 [ Simpan, pindai berikutnya ]
 Belum dihitung (28)
  Sirup Vanila · botol 750 ml
  Gula Aren · kg ...
 [ Kirim untuk ditinjau ]
```

- A scan finds the bahan and opens its entry. The amount is typed: full packs, plus what is left in the open one.
  One scan per unit would be slower than typing "14".
- A bahan without a barcode is picked from the list or found by name or alias.
- A scanned bahan that belongs to another area asks "Bahan ini tercatat di area Gudang. Tambahkan ke hitungan ini?".
- Every keystroke is saved on the phone, so pausing or closing the app costs nothing.
- "Kirim untuk ditinjau" sends what was counted; items left blank are not sent, as on the web.
- No expected amount, gap or value is shown anywhere on the phone.
- The count has the same shape as on the web (`CountSession`, with the area label "Semua area" for a full count)
  and sends the same payload as `submitCount` in `src/lib/commands.ts`, so the review screen in Takar needs no change.

**5. Barcode belum dikenal.** Appears when a scanned code has no link.

```
 Kode 8991002101234 belum dikenal
 [ Cari bahan                       ]
  Susu UHT Full Cream
  Susu Oat ...
 Kode ini untuk:  (•) satuan   ( ) karton 12 × 1 L
 [ Simpan ]
```

- The link is remembered for every phone in the store.
- A code that is linked to the wrong bahan is fixed from that bahan's entry: "Kode terpasang:
  8991002101234 · Lepas", then by scanning it again and picking the right bahan.

**6. Terima barang.**

```
 ← Terima barang
 Pemasok / nota [ CV Susu Jaya, nota 1203 ]   [ Foto nota ]
 ┌─────────── kamera ───────────┐
 └──────────────────────────────┘
 Susu UHT Full Cream      3 karton   Rp 648.000
 Sirup Vanila             6 botol    Rp 510.000
 ⚠ 60 botol itu 10× kiriman biasa (6 botol).  [Ubah] [Ya, benar]
 [ Masukkan ke stok · Rp 1.158.000 ]
```

- A scan opens a small sheet: amount, unit (the item's packs, kg or L, or the base unit) and price per that unit.
- The price is prefilled from the last delivery. It may be left blank; a blank price does not disturb cost reports,
  because Takar's unit cost only reads deliveries with a price.
- The same sanity check as the web: an amount over 5× or under 1/5 of the usual delivery needs a second tap.
- "Pemasok / nota" is required, as on the web. The photo is optional.
- Saving creates one stock entry per line, the same `stock.record` operation the Stok page sends. The reason is the
  "Pemasok / nota" text, the cost is amount × price rounded to whole rupiah, and the photo rides on the first line.
- "Paid from the cash drawer" is not offered on the phone. Deliveries recorded here are paid outside the drawer.

### Barcodes

- A barcode belongs to one bahan in one store, and may name one of that bahan's packs ("karton"). The pack decides
  which box gets focus in a count and which unit is preselected in a delivery.
- Codes are stored as scanned, trimmed. A 12-digit code gets a leading zero, so the same product reads the same on
  Android and iPhone.
- Types read: EAN-13, EAN-8, UPC-A, UPC-E, Code 128, Code 39, ITF-14 and QR.
- If a pack is later renamed or removed in Takar, the code still finds the bahan and falls back to the base unit.

### Offline and sync

- The phone keeps, per signed-in person: paused counts, the delivery being entered, and a queue of unsent work.
- Work is written to the queue first, then sent. Each item has its own id, so sending it twice is harmless.
- Sending is tried when something is queued, when the app comes to the front, every 30 seconds while something is
  waiting, and when the person pulls to refresh.
- If the server refuses an item (wrong role, phone not paired, bahan removed), it moves to "Perlu perhatian" with
  the server's message and two choices: send again as new, or delete. Other items keep going.
- Whether a failure is final or worth another try is decided the way `serverTransport` in `src/lib/sync.ts` does it.
- Switching user is blocked while that person has unsent work, the same rule as the web.
- After each send and each time the app comes to the front, the phone refreshes its list of bahan, barcodes and
  team from the server.

### Server changes (one migration, additions only)

`supabase/migrations/202611170004_stock_app.sql`. Nothing existing is redefined, so it cannot collide with the
migration the other session is writing.

1. `devices.mode` also accepts `phone`.
2. `enroll_phone(device_id)`: owner or manager pairs this phone as a `phone` device. It refuses an id that is the
   store's till.
3. Table `barcodes(restaurant_id, code, stock_id, pack, linked_by, linked_at)`, one row per code per store.
   A code is 4 to 64 printable ASCII characters. No direct access for any role; only the functions below touch it.
4. `link_barcode(device_id, code, stock_id, pack)` and `unlink_barcode(device_id, code)`: any active member on a
   paired device. They check that the bahan exists in that store and that the pack is one of its packs.
5. `stock_app(device_id)`: the one read call. It returns who the person is, the store name and timezone, whether
   the phone is paired, the team list, every bahan (name, unit, area, packs, aliases) and every barcode.
   For owner, manager and admin stok it also returns each bahan's last unit cost and last five delivery amounts,
   which the delivery screen needs. Other roles do not get prices.
   - The cost is rupiah per thousandth of the base unit, the same number `bootstrap` returns in `costs`.
   - The delivery amounts are in thousandths of the base unit, oldest first, the shape `sanity()` takes.
   - A phone that is not paired can still read. It cannot write, as on the web.

Counts and deliveries keep using `apply_operation` as it is.

### Changes to Takar web

- The pack-and-loose arithmetic in `Counts.tsx` (`measure`) moves to a new shared file `src/domain/measure.ts`, and
  `Counts.tsx` imports it. No behaviour change. The phone imports the same file.
- The audit log's device label gains "Ponsel stok", so a delivery recorded on a phone does not show a blank device.
- `docs/MOBILE.md`: how to run, pair, build and release the app.
- Nothing else. The web app does not learn about barcodes in this version.

### The app's code

- `mobile/` in this repo: its own `package.json` and lockfile, not a workspace, so installing and building the
  web app is unaffected.
- It imports `src/domain/calculate.ts`, `measure.ts`, `permissions.ts` and `types.ts` from the web app directly.
- The parts that decide things (queue, sync, barcode lookup, building operations) are plain TypeScript with no
  React Native imports. They live in `src/stok/` in the web app's tree and their tests in `tests/unit/`, so the
  existing `pnpm test` and `tsc -b` cover them without the phone's packages installed.
- Config is `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in `mobile/.env`, the same two
  values the web app has under its `VITE_` names.
- A demo mode ("Coba demo") runs on Takar's sample bahan with no server, for showing the client and for checking
  screens without touching live data.

### How it reaches phones

- **While building:** `npx expo start` in `mobile/`, then scan the QR code with the Expo Go app (Android or iPhone,
  same Wi-Fi as the Mac).
- **For staff:** an Android APK from Expo's cloud build. That needs a free Expo account, which the user creates and
  signs in to; the build command is then one line. The alternative is installing Android Studio on this Mac.
- **Before real use:** the migration is applied to the hosted Supabase project, by the user or on their word.

### How it is checked

| Check | How |
| --- | --- |
| Server rules | New PGlite tests in `scripts/test-db.mjs`: pairing by manager only, link / move / unlink, bad code, bad pack, unpaired phone refused, `stock_app` hides prices from crew and never crosses stores. The existing 60 checks still pass. |
| Phone logic | Unit tests for the queue, sync, barcode lookup and operation building, run by `pnpm test`. |
| Types and bundle | `tsc` in `mobile/`, `expo-doctor`, and an Android bundle export, none of which need the Android SDK. |
| Screens | The app run in a browser in demo mode: sign in, count with a typed code, link an unknown code, send, record a delivery. |
| Camera | By the user on a real phone with Expo Go. I cannot test the camera from this Mac. |
| End to end | By the user: a count sent from the phone appears under "Perlu ditinjau" in Takar, and a delivery appears in the Stok ledger. |

## Calls I made (please check these)

1. **One new read call instead of Takar's own.** I said the phone would read with the same calls as the web app.
   `bootstrap` also carries the whole menu with its photos and the till's orders, which a phone does not need, so
   the phone gets the small `stock_app` call instead. Writing is as promised: counts and deliveries go through
   `apply_operation`.
2. **Barcode links use two small server functions, not `apply_operation`.** Adding them to `apply_operation` means
   copying that 290-line function into a new migration while the other session is working next to it. Links are
   reference data like device pairing, which already has its own function.
3. **Deliveries without a PO only.** PO receiving stays on the laptop for now.
4. **Scan to find, type the amount.** Not one scan per unit.
5. **Every role may link a barcode,** because people meet unknown codes while counting.
6. **No idle PIN lock in this version.** The tablets lock after 2 idle minutes; the phone does not. The signed-in
   name is always on screen and "Ganti" is one tap. Ceiling: a shared phone left signed in as admin stok lets the
   next person record a delivery under that name. Adding the lock later is a contained change.
7. **A lost phone cannot be un-paired from Takar yet.** The stopgap is to deactivate the account that was signed
   in. A device list with "revoke" in Tim & perangkat is a sensible follow-up.
8. **No "paid from the drawer" on the phone.**
9. **Demo mode is included,** mainly so screens can be checked without live data.
10. **Android first,** app name "Takar Stok".

## Left to the builder

- Navigation (a router library or a simple screen switch), component structure and styling details.
- Storage keys and the exact shape of what is kept on the phone.
- How the delivery-note photo is shrunk to fit the server's 70.000-character WebP limit.
- Wording of messages not written out above, in the same tone as Takar.
- The Android package id, to be confirmed with the user before the first cloud build.
