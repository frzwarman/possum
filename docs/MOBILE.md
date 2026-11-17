# Takar Stok: the phone app

Takar Stok is a React Native (Expo) app in [`mobile/`](../mobile). Staff use it on a phone to do two jobs by
scanning barcodes:

- **Hitung stok**: count an area. Scan a bahan, type the full packs and the open one, next. The amount Takar
  expects is never shown. A finished count is sent for review; the manager approves it in Takar as today.
- **Terima barang**: record a delivery. Scan each item that arrived, type the amount and the price, optionally
  photograph the nota, and put it into stock.

It writes to the same Supabase database as the web app, through the same rules. The design and its reasons are in
[superpowers/specs/2026-11-17-takar-stok-app-design.md](superpowers/specs/2026-11-17-takar-stok-app-design.md).

**What it does not do (yet):** receive against a purchase order, approve a count, record waste or batches, print
labels, lock itself after idle minutes, or let Takar un-pair a lost phone. See [Known limits](#known-limits).

## How it fits with Takar

| The phone does | Through | Who may |
| --- | --- | --- |
| Read bahan, barcodes and the team | `stock_app(device_id)` | any active staff member |
| Send a count for review | `apply_operation`, `count.submit` | every role |
| Record a delivery | `apply_operation`, `stock.record` kind `purchase` | owner, manager, admin stok |
| Link or remove a barcode | `link_barcode`, `unlink_barcode` | every role, on a paired phone |
| Pair this phone | `enroll_phone(device_id)` | owner, manager |

- Counts and deliveries use the operations the web app already sends, so permissions, the manager's approval and
  the audit log are unchanged. In the audit log a phone shows as "Ponsel stok".
- The new pieces are in one migration, `supabase/migrations/202611170004_stock_app.sql`. It only adds things.
- The phone's decisions (barcodes, counts, deliveries, the offline queue, sending) are plain TypeScript in
  `src/stok/`, next to Takar's unit maths in `src/domain/`. The phone bundles those same files, and the web app's
  `pnpm test` covers them.

## Try it

### The demo, in a browser

No database needed. It runs on Takar's sample bahan and keeps everything in the browser.

```bash
cd mobile
```

```bash
npm install
```

```bash
npx expo start --web
```

Choose **Coba demo**. Three barcodes are known in the demo; type one into "Ketik kode atau cari nama bahan" and
press Enter: `8991002101234` (Air mineral botol, on a dus), `8992753102207` (Biji kopi, on a bungkus),
`8998866200301` (Telur, a single item). Any other number is "belum dikenal" and can be linked.

### On a phone, with Expo Go

1. Install **Expo Go** on the phone (Play Store or App Store).
2. Put the phone and this Mac on the same Wi-Fi.
3. Start the app's server and scan the QR code it prints (Expo Go on Android, the Camera app on iPhone):

```bash
npx expo start
```

The demo works straight away. To use the real store, connect it first (next section).

Expo 58 lists Node 22, 24 or 26. Node 25 prints `EBADENGINE` warnings and works.

## Connect it to the store

1. **Apply the migration** to the hosted Supabase project. This also applies any other migration that is waiting,
   so check the list first:

```bash
supabase db push --dry-run
```

```bash
supabase db push
```

2. **Give the app the project's address and key.** They are the same two values the web app has in its `.env`
   under `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`:

```bash
cp .env.example .env
```

   Fill `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in `mobile/.env`, then restart
   `npx expo start`. Without them the app only offers the demo.

3. **Pair the phone, once.** An owner or manager chooses "Masuk dengan email", signs in, and taps
   "Pasangkan ponsel ini". Then "Ganti" to sign out.
4. **Staff sign in** by tapping their name and typing their 6-digit PIN, as on the tablet. The names appear after
   the first sign-in on that phone.

## Using it

- **A barcode the app has not seen** opens "Kode … belum dikenal". Pick the bahan and say whether the code is on a
  single item ("satuan") or on a pack. Every phone in the store knows it from then on.
- **A bahan without a barcode** is found by name in the same field, or picked from the list.
- **A wrong link** is removed from the bahan's entry in a count: "Kode terpasang", then "Lepas". Scan the code
  again to link it to the right bahan.
- **No signal** is fine. A count or a delivery is saved on the phone and sent when there is signal; Beranda shows
  "n belum terkirim" until then. "Ganti" (switch user) waits until that person's work has been sent.
- **"Perlu perhatian"** lists work Takar refused, with the reason. "Kirim ulang" sends it again as new work;
  "Hapus" discards it. Takar refuses work that waited more than 7 days or that carries a time more than 2 minutes
  ahead of the server, so a phone with a wrong clock ends up here.
- **Prices** are optional. A delivery with no price still adds stock; Takar's unit cost only reads deliveries that
  have one.

## Build an Android app file (APK)

This Mac has no Android SDK, so the installable file is built on Expo's servers. It needs a free Expo account.

```bash
npx eas-cli@latest login
```

```bash
npx eas-cli@latest env:set --name EXPO_PUBLIC_SUPABASE_URL --value <project url> --environment preview --visibility plaintext
```

```bash
npx eas-cli@latest env:set --name EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY --value <publishable key> --environment preview --visibility plaintext
```

```bash
npx eas-cli@latest build -p android --profile preview
```

- The first build asks to create the project on your Expo account and to make an Android signing key. Say yes to
  both.
- Before that first build, confirm the app's id in `mobile/app.json` (`android.package`, now `app.takar.stok`).
  It identifies the app on every phone and is awkward to change later.
- The build ends with a link and a QR code. Open it on the phone and install the APK.
- An iPhone build needs an Apple developer account (US$99 a year); the code is the same.

## What was checked, and what was not

| Checked on this Mac | How |
| --- | --- |
| Server rules | `pnpm test:db`: 64 checks, 4 of them new (pairing, barcode links, `stock_app`, a count and a delivery from a phone) |
| Phone logic | `pnpm test`: 233 tests, 26 of them for `src/stok` and the shared count arithmetic |
| Types and bundles | `npx tsc --noEmit`, `npx expo-doctor` (20/20), and bundle exports for Android and web |
| Every screen, in demo mode in a browser | sign in, count by typed code, link an unknown code, pause and resume across a reload, send, record a delivery with the "unusual amount" warning, and the refused-work list |

| Not checked: needs a real phone | Why |
| --- | --- |
| The camera reading a barcode, and the torch | no camera here |
| The delivery-note photo and its shrinking to the server's 70 000-character WebP limit | no camera here |
| Signing in, pairing and sending against the hosted project | the migration is not applied there yet |
| The app with the phone truly offline | browser checks only |

The first run on a phone should walk exactly those four.

## Known limits

- **No idle lock.** The tablets lock after idle minutes; the phone does not. The signed-in name is always on
  Beranda and "Ganti" is one tap. A shared phone left signed in as admin stok lets the next person record a
  delivery under that name.
- **A lost phone cannot be un-paired from Takar.** Until a device list with "revoke" exists, deactivate the
  account that was signed in on it.
- **Deliveries have no purchase order** and are never paid from the cash drawer. PO receiving stays on the laptop.
- **One count per bahan, not per shelf.** As on the web, a bahan belongs to one area and a count sets its whole
  stock.
- **The list of bahan is not paged.** Fine for a few hundred; a store with many more would want a virtual list.

## For developers

- `mobile/` has its own `package.json` and npm lockfile. It is not a workspace of the web app. Add packages with
  `npx expo install <package>`, which picks versions that match the SDK.
- `mobile/metro.config.js` lets the bundler read `../src/domain` and `../src/stok`. Nothing in those folders may
  import React Native, Expo, the DOM or Node.
- Six screens are switched by state in `mobile/App.tsx`; there is no router. `mobile/src/state.tsx` holds the
  shared state and wires the tested logic to storage and the server; `mobile/src/platform/` is the only place
  that talks to Supabase or the image tools.
- After a change, from `mobile/`: `npx tsc --noEmit` and `npx expo-doctor`; from the repo root: `pnpm test` and
  `pnpm test:db`.
- `mobile/AGENTS.md` carries the same notes for coding agents.
