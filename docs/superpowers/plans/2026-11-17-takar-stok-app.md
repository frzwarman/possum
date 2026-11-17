# Takar Stok Phone App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A React Native (Expo) phone app, "Takar Stok", in which staff count stock and record deliveries by scanning barcodes, writing to the same Supabase database as Takar.

**Architecture:** The phone's decision logic is plain TypeScript in `src/stok/`, next to Takar's domain code, so the web app's `pnpm test` and `tsc -b` cover it. The Expo app in `mobile/` holds only platform glue, state and screens, and bundles `src/domain` and `src/stok` through Metro `watchFolders`. Counts and deliveries go through the existing `apply_operation`; one additive migration adds barcodes, phone pairing and a single read call.

**Tech Stack:** Expo SDK 58 (React Native 0.88, React 19.3, TypeScript 6), `expo-camera`, `expo-sqlite` (its `localStorage`), `expo-crypto`, `expo-image-manipulator`, `@supabase/supabase-js` 2. Postgres functions tested on PGlite. Vitest.

**Spec:** [docs/superpowers/specs/2026-11-17-takar-stok-app-design.md](../specs/2026-11-17-takar-stok-app-design.md)

## Global Constraints

- Work on branch `worktree-stock-app` in `.claude/worktrees/stock-app`. Commit after each task. Never push, never touch `main`, never apply anything to the hosted Supabase project.
- The migration only adds things. No existing function, table or policy is redefined.
- Counts and deliveries change stock only through `apply_operation` (`count.submit`, and `stock.record` with kind `purchase`).
- The phone never shows expected stock, a gap or a stock value.
- Roles are unchanged: every role counts; owner, manager and admin record deliveries; owner and manager pair.
- A barcode is 4 to 64 printable ASCII characters with no spaces. A 12-digit code gets a leading `0`. Types read: `ean13`, `ean8`, `upc_a`, `upc_e`, `code128`, `code39`, `itf14`, `qr`.
- A delivery-note photo is `data:image/webp;base64,…` of at most 70 000 characters in total.
- A full count's area label is exactly `Semua area`.
- Deliveries from the phone always send `fromDrawer: false`.
- UI text is Indonesian. Colours: ink `#1B1D21`, lime `#D3F26A`, paper `#F6F5F0`. Font: Plus Jakarta Sans.
- `mobile/` has its own `package.json` and npm lockfile. It is not a pnpm workspace. Packages are added with `npx expo install`.
- Files in `src/stok/` and `src/domain/` import nothing from React Native, Expo, the DOM or Node.
- Node here is 25.8. Expo prints `EBADENGINE` warnings and works (checked). Do not change the system Node.
- These stay green after every task: `pnpm test:db`, `pnpm test`, `npx tsc -b`.

## Review Focus

Each line names a condition the spec implies, the behaviour a person would expect, and the task whose tests pin it.

1. **The app is closed or killed mid-entry.** The paused count, the delivery being entered and the unsent queue are exactly as left. Task 5 (`Queue` reloads from storage) and Task 6 (state writes on every change).
2. **The same work is submitted twice** (double tap, or a retry after the reply was lost). Stock moves once. Task 4 (delivery jobs reuse the line's id) and Task 5 (`add` skips a queued id; a job keeps its id after a network error).
3. **The same product scanned on Android and on iPhone, or typed with stray spaces.** It finds the same link. Task 4 (`normalizeCode`).
4. **Another person signs in while someone's work is still queued.** Their work is not sent under the new name and is not lost. Task 5 (`flush` sends only the signed-in person's jobs).
5. **A bahan or a pack is removed in Takar while a count is paused or a code is linked.** The count still submits without that bahan; the code still finds the bahan in its base unit. Task 4 (`countJob`, `lookup`).

## File Structure

| File | Responsibility |
| --- | --- |
| `supabase/migrations/202611170004_stock_app.sql` | `phone` device mode, `enroll_phone`, `barcodes`, `link_barcode`, `unlink_barcode`, `stock_app` |
| `scripts/test-db.mjs` | four new PGlite tests |
| `src/domain/measure.ts` | pack-and-loose arithmetic, moved out of `Counts.tsx` |
| `src/features/counts/Counts.tsx` | imports `measure` instead of defining it |
| `src/features/audit/Audit.tsx` | one label: `phone: 'Ponsel stok'` |
| `src/stok/types.ts` | the phone's shared types |
| `src/stok/barcode.ts` | normalise a code, find its bahan |
| `src/stok/count.ts` | start a count, set an amount, build the submit job |
| `src/stok/delivery.ts` | units, amounts, cost, sanity flag, build the delivery jobs |
| `src/stok/queue.ts` | the persisted queue of unsent work, plus `load` / `save` |
| `src/stok/sync.ts` | send the queue, decide final versus retry |
| `src/stok/demo.ts` | demo identity, sample snapshot and an in-memory server |
| `tests/unit/measure.test.ts`, `stok-logic.test.ts`, `stok-sync.test.ts` | unit tests |
| `mobile/` | the Expo app: `App.tsx`, `src/platform/` (Supabase, photo), `src/state.tsx`, `src/ui/`, `src/screens/` |
| `docs/MOBILE.md`, `README.md` | how to run, pair, build and release |

---

### Task 1: Database: phones, barcodes and one read call

**Files:**
- Create: `supabase/migrations/202611170004_stock_app.sql`
- Modify: `scripts/test-db.mjs` (insert before the line `// Independent database restoration, never a live environment.`)

**Interfaces:**
- Produces, all `security definer`, `search_path=''`, executable by `authenticated` only:
  - `enroll_phone(device_id uuid) returns void`. Errors: `Manager required` (42501), `The till cannot be a phone`.
  - `link_barcode(device_id uuid, barcode text, item text, pack_name text default '') returns void`. Errors: `No active staff membership` (42501), `Device not enrolled`, `Invalid barcode`, `Unknown stock item`, `Unknown pack`. An existing code moves to the new bahan.
  - `unlink_barcode(device_id uuid, barcode text) returns void`. Same membership and device errors. Removing a code that is not there is not an error.
  - `stock_app(device_id uuid) returns jsonb` with keys `restaurantId, name, role, store, timezone, now, device {mode, enrolled, primary}, team [{id, name, role, login}], stock [{id, name, unit, area?, packs, aliases, cost?, usual?}], barcodes [{code, stockId, pack}]`.
    - `cost` and `usual` appear only for owner, manager and admin.
    - `cost` is rupiah per thousandth of the base unit: the latest movement of kind purchase, production or transfer with `qty>0` and `cost>0`, as `bootstrap` computes `costs`.
    - `usual` is the last five purchase quantities, oldest first.
- Table `barcodes(restaurant_id, code, stock_id, pack default '', linked_by, linked_at)`, primary key `(restaurant_id, code)`, `code ~ '^[\x21-\x7e]{4,64}$'`, foreign keys to `inventory_items` and `memberships`, RLS on, no grants to `anon` or `authenticated`.
- `devices.mode` check becomes `('pos','station','office','phone')` (constraint `devices_mode_check`).

- [ ] **Step 1: Write the failing tests**

```js
// ---- Takar Stok (202611170004): phones, barcodes, one read call ----
const phone = randomUUID();
const link = (dev, code, item, pack = "") => db.query("select public.link_barcode($1,$2,$3,$4)", [dev, code, item, pack]);
const codes = async () => (await read("select code,stock_id,pack from public.barcodes where restaurant_id=$1 order by code", [rid])).rows;
const stockApp = async (dev) => (await db.query("select public.stock_app($1) as s", [dev])).rows[0].s;
const till = async () => (await read("select primary_device_id from public.restaurants where id=$1", [rid])).rows[0].primary_device_id;
await test("Only an owner or manager pairs a phone, and the till never becomes one", async () => {
  await login(kitchen);
  await assert.rejects(db.query("select public.enroll_phone($1)", [phone]), /Manager required/);
  await login(owner);
  const before = await till();
  await db.query("select public.enroll_phone($1)", [phone]);
  assert.deepEqual((await read("select mode,revoked_at from public.devices where restaurant_id=$1 and id=$2", [rid, phone])).rows, [{ mode: "phone", revoked_at: null }]);
  await assert.rejects(db.query("select public.enroll_phone($1)", [before]), /till cannot be a phone/);
  assert.equal(await till(), before);
});
await test("Any member links a barcode on a paired phone; a second link moves it; bad input and unpaired devices are refused", async () => {
  await login(kitchen);
  await link(phone, "8991002101234", "rice", "karung");
  assert.deepEqual(await codes(), [{ code: "8991002101234", stock_id: "rice", pack: "karung" }]);
  await link(phone, "8991002101234", "egg");
  assert.deepEqual(await codes(), [{ code: "8991002101234", stock_id: "egg", pack: "" }]);
  await assert.rejects(link(phone, "12", "egg"), /Invalid barcode/);
  await assert.rejects(link(phone, "8991 002", "egg"), /Invalid barcode/);
  await assert.rejects(link(phone, "8991002101234", "nope"), /Unknown stock item/);
  await assert.rejects(link(phone, "8991002101234", "rice", "dus"), /Unknown pack/);
  await assert.rejects(link(randomUUID(), "8991002101234", "rice"), /Device not enrolled/);
  await assert.rejects(db.query("select * from public.barcodes"), /permission denied/);
  await login(outsider);
  await assert.rejects(link(phone, "8991002101234", "rice"), /Device not enrolled/);
  await login(kitchen);
  await db.query("select public.unlink_barcode($1,$2)", [phone, "8991002101234"]);
  await db.query("select public.unlink_barcode($1,$2)", [phone, "8991002101234"]);
  assert.deepEqual(await codes(), []);
  await link(phone, "8991002101234", "rice", "karung");
});
await test("stock_app gives a phone its bahan, barcodes and team; prices only to those who receive; never another store", async () => {
  await login(admin);
  await send(opOn(phone, "stock.record", { stockId: "rice", kind: "purchase", qty: 25000000, cost: 300000, fromDrawer: false, reason: "CV Beras, nota 1" }));
  const a = await stockApp(phone), rice = a.stock.find((s) => s.id === "rice");
  assert.deepEqual([a.restaurantId, a.role, a.store, a.timezone, a.device.enrolled, a.device.mode], [rid, "admin", "Warung Uji", "Asia/Jakarta", true, "phone"]);
  assert.deepEqual([rice.unit, rice.area, rice.packs[0].name, rice.aliases[0]], ["g", "Dry store", "karung", "nasi"]);
  assert.equal(rice.cost, 300000 / 25000000);
  assert.equal(rice.usual.at(-1), 25000000);
  assert.deepEqual(a.barcodes, [{ code: "8991002101234", stockId: "rice", pack: "karung" }]);
  assert.ok(a.team.some((m) => m.id === kitchen && m.role === "kitchen"));
  await login(kitchen);
  const k = await stockApp(phone);
  assert.ok(k.stock.length > 0 && k.stock.every((s) => s.cost === undefined && s.usual === undefined));
  await login(outsider);
  const o = await stockApp(phone);
  assert.deepEqual([o.restaurantId, o.device.enrolled, o.barcodes.length], [other, false, 0]);
  assert.ok(o.stock.every((s) => s.id !== "rice"));
  await login(owner);
});
await test("A count and a delivery from a paired phone go through apply_operation; crew cannot receive and an unpaired phone is refused", async () => {
  await login(kitchen);
  const id = randomUUID();
  await send(opOn(phone, "count.submit", { id, area: "Dry store", lines: [{ stockId: "rice", counted: 1000, reason: "" }] }));
  assert.deepEqual((await read("select status from public.counts where id=$1", [id])).rows, [{ status: "submitted" }]);
  await assert.rejects(send(opOn(phone, "stock.record", { stockId: "rice", kind: "purchase", qty: 1000, cost: 0, fromDrawer: false, reason: "x" })), /Manager permission/);
  await assert.rejects(send(opOn(randomUUID(), "count.submit", { id: randomUUID(), area: "Dry store", lines: [{ stockId: "rice", counted: 1, reason: "" }] })), /Device not enrolled/);
  await login(owner);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm test:db`
Expected: the four new tests FAIL (`function public.enroll_phone(uuid) does not exist`), the other 60 pass.

- [ ] **Step 3: Write the migration** to the contracts above. Follow the style of `202611170001_telegram.sql`: a short comment per object saying why, `revoke all … from public,anon` then `grant execute … to authenticated`. Qualify parameters with the function name wherever a column has the same name.

- [ ] **Step 4: Run to see them pass**

Run: `pnpm test:db`
Expected: `64 PostgreSQL integration checks passed`.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers supabase/migrations/202611170004_stock_app.sql scripts/test-db.mjs
git commit -m "feat: phone pairing, barcodes and a read call for the stock app"
```

---

### Task 2: Share the count arithmetic

**Files:**
- Create: `src/domain/measure.ts`, `tests/unit/measure.test.ts`
- Modify: `src/features/counts/Counts.tsx` (lines 12 to 15 and 20 to 23), `src/features/audit/Audit.tsx:19`

**Interfaces:**
- Produces, from `src/domain/measure.ts`:
  - `type Entry = { packs: Record<string, string>; loose: string; big: boolean }`
  - `const blank: Entry`
  - `const BIG: Record<string, string>` (`{ g: 'kg', ml: 'l' }`)
  - `measure(s: Pick<StockItem, 'unit' | 'packs'>, e: Entry): number | undefined`: thousandths of the base unit; `undefined` when every box is blank; throws `convert`'s message on a bad number.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { blank, measure } from '../../src/domain/measure'
const milk = { unit: 'ml' as const, packs: [{ name: 'karton', qty: 12_000_000 }] }
describe('measure', () => {
  it('adds full packs and the open one', () => expect(measure(milk, { packs: { karton: '2' }, loose: '5', big: true })).toBe(29_000_000))
  it('reads a blank entry as not counted and 0 as a count of nothing', () => {
    expect(measure(milk, blank)).toBeUndefined()
    expect(measure(milk, { ...blank, loose: '0' })).toBe(0)
  })
  it('accepts a comma and a trailing comma, refuses anything else', () => {
    expect(measure({ unit: 'g' }, { ...blank, loose: '2,5', big: true })).toBe(2_500_000)
    expect(measure({ unit: 'g' }, { ...blank, loose: '2,' })).toBe(2000)
    expect(() => measure({ unit: 'g' }, { ...blank, loose: 'abc' })).toThrow('Gunakan angka positif')
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run tests/unit/measure.test.ts`
Expected: FAIL, cannot resolve `../../src/domain/measure`.

- [ ] **Step 3: Move the code.** Cut `Entry`, `blank`, `BIG`, `measure` and their two comments from `Counts.tsx` into `src/domain/measure.ts` unchanged, except that `measure` takes `Pick<StockItem,'unit'|'packs'>`. `Counts.tsx` imports them from `../../domain/measure`. Keep the file's compact style; change nothing else in it.

- [ ] **Step 4: Add the device label.** In `Audit.tsx` the `DEVICE` map gains `phone: 'Ponsel stok'`.

- [ ] **Step 5: Run the checks**

Run: `pnpm vitest run tests/unit/measure.test.ts && npx tsc -b && pnpm test`
Expected: the new file passes, no type errors, 210 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/domain/measure.ts src/features/counts/Counts.tsx src/features/audit/Audit.tsx tests/unit/measure.test.ts
git commit -m "refactor: share the count arithmetic with the stock app"
```

---

### Task 3: The Expo project

**Files:**
- Create: `mobile/` from the `blank-typescript` template, then `mobile/metro.config.js`, `mobile/.env.example`, `mobile/eas.json`, `mobile/AGENTS.md`, `mobile/assets/*` (icons from Takar's mark)
- Modify: `mobile/app.json`, `mobile/App.tsx`

**Interfaces:**
- Produces: a project in which `import … from '../src/domain/…'` and `'../src/stok/…'` bundle, and these commands pass: `npx tsc --noEmit`, `npx expo-doctor`, `npx expo export --platform android`, `npx expo export --platform web`.

- [ ] **Step 1: Create the project and add the modules**

```bash
npx --yes create-expo-app@latest mobile --template blank-typescript --no-install
cd mobile && rm -rf .git .claude && npm install
npx expo install expo-camera expo-sqlite expo-crypto expo-image-manipulator expo-font react-native-safe-area-context @expo-google-fonts/plus-jakarta-sans @supabase/supabase-js react-dom react-native-web
```

The template ships its own `.git` and a `.claude/settings.json` that switches on an Expo plugin. Both are removed: the app lives in this repo, and enabling a plugin is the user's choice.

- [ ] **Step 2: Configure**
  - `metro.config.js`: Expo's default config with `watchFolders = [path.resolve(__dirname, '../src/domain'), path.resolve(__dirname, '../src/stok')]`.
  - `app.json`: name `Takar Stok`, slug `takar-stok`, portrait, light, `android.package` and `ios.bundleIdentifier` `app.takar.stok` (the user confirms this before the first cloud build), `ios.supportsTablet` false, the `expo-camera` plugin with `cameraPermission` "Takar Stok memakai kamera untuk memindai barcode dan memotret nota." and `recordAudioAndroid: false`, plus the `expo-sqlite` and `expo-font` plugins. Keep `predictiveBackGestureEnabled: false`.
  - `eas.json`: `{ "build": { "preview": { "distribution": "internal", "android": { "buildType": "apk" } }, "production": {} } }`.
  - `.env.example`: `EXPO_PUBLIC_SUPABASE_URL=` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=`.
  - `AGENTS.md`: keep the template's file, replace its "Navigation & Routing" section with: this app has six screens switched by state in `App.tsx`, no router; logic lives in `../src/stok` and is tested by the web app's `pnpm test`.
  - Icons: `icon.png` (1024, ink ground, the Takar mark), the three Android adaptive files and `favicon.png`, rendered from `public/icon.svg`.

- [ ] **Step 3: A first screen that proves the wiring.** `App.tsx` shows "takar stok" in Plus Jakarta Sans on the paper colour, and under it `quantity(convert('2,5','kg','g'))` and `roleLabel.admin` imported from `../src/domain`. Import fonts by weight path (`@expo-google-fonts/plus-jakarta-sans/500Medium` and so on) so only three weights are bundled: 500, 600, 700.

- [ ] **Step 4: Run the checks**

```bash
npx tsc --noEmit && npx expo-doctor && npx expo export --platform android --output-dir dist && npx expo export --platform web --output-dir dist
```
Expected: no type errors, `20/20 checks passed`, one `.hbc` Android bundle, a web `index.html`. `dist/` is already ignored by the template's `.gitignore`.

- [ ] **Step 5: Commit**

```bash
git add mobile
git commit -m "feat: Expo project for the Takar Stok phone app"
```

---

### Task 4: Phone logic: barcodes, counts, deliveries

**Files:**
- Create: `src/stok/types.ts`, `src/stok/barcode.ts`, `src/stok/count.ts`, `src/stok/delivery.ts`, `tests/unit/stok-logic.test.ts`

**Interfaces:**
- Consumes: `convert`, `sanity` from `src/domain/calculate.ts`; `CountSession`, `Pack`, `Role`, `StockItem` from `src/domain/types.ts`.
- Produces, `src/stok/types.ts`:

```ts
export interface TeamMember { id: string; name: string; role: Role; login?: string | null }
export interface PhoneStock { id: string; name: string; unit: StockItem['unit']; area?: string; packs?: Pack[]; aliases?: string[]; cost?: number; usual?: number[] }
export interface BarcodeLink { stockId: string; pack: string }
export interface Snapshot { restaurantId: string; name: string; role: Role; store: string; timezone: string; now: string; device: { mode: string | null; enrolled: boolean; primary: boolean }; team: TeamMember[]; stock: PhoneStock[]; barcodes: ({ code: string } & BarcodeLink)[] }
export interface Identity { id: string; name: string; role: Role; restaurantId: string; store: string; timezone: string; deviceId: string; paired: boolean; demo: boolean }
export interface DeliveryLine { id: string; stockId: string; unit: string; amount: string; price: string; checked?: string }
export interface Delivery { id: string; note: string; photo?: string; lines: DeliveryLine[] }
export type Job = { id: string; actor: string; occurredAt: string; label: string; state: 'pending' | 'rejected'; error?: string } & (
  | { type: 'op'; kind: 'count.submit' | 'stock.record'; payload: Record<string, unknown> }
  | { type: 'link'; code: string; stockId: string; pack: string }
  | { type: 'unlink'; code: string })
export interface Operation { id: string; kind: string; actor: string; restaurantId: string; deviceId: string; occurredAt: string; payload: Record<string, unknown> }
export interface Server {
  snapshot(deviceId: string): Promise<Snapshot>
  apply(operation: Operation): Promise<void>
  link(deviceId: string, code: string, stockId: string, pack: string): Promise<void>
  unlink(deviceId: string, code: string): Promise<void>
  pair(deviceId: string): Promise<void>
}
export interface KV { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
```

- Produces, `src/stok/barcode.ts`:
  - `BARCODE_TYPES = ['ean13','ean8','upc_a','upc_e','code128','code39','itf14','qr'] as const`
  - `normalizeCode(raw: string): string | undefined`
  - `lookup(code: string, links: Record<string, BarcodeLink>, stock: PhoneStock[]): { item: PhoneStock; pack?: Pack } | undefined`
- Produces, `src/stok/count.ts`:
  - `ALL_AREAS = 'Semua area'`
  - `areas(stock: PhoneStock[]): string[]`: distinct, sorted.
  - `startCount(stock: PhoneStock[], area: string, userId: string, id: string, now: string): CountSession`: `''` means every area; lines sorted by area then name; throws `Tidak ada bahan di area ini`.
  - `setCounted(session: CountSession, stockId: string, counted: number | undefined): CountSession`: adds the line when the bahan is not in the count yet.
  - `countJob(session: CountSession, stock: PhoneStock[], actor: string, id: string, now: string): Job`: payload `{ id: session.id, area, lines: [{ stockId, counted, reason: '' }] }`, label `Hitung <area> · <n> bahan`; throws `Belum ada bahan yang dihitung`.
- Produces, `src/stok/delivery.ts`:
  - `units(item: PhoneStock): { name: string; per: number }[]`: each pack, then `kg` or `l` (per 1 000 000) when the base is `g` or `ml`, then the base unit (per 1000).
  - `lineQty(item: PhoneStock, line: DeliveryLine): number`: thousandths of the base unit; blank or zero is 0; throws `convert`'s message.
  - `lineCost(item: PhoneStock, line: DeliveryLine): number`: amount × price, rounded; 0 when the price is blank.
  - `suggestedPrice(item: PhoneStock, unit: string): string`: `cost × per` rounded, or `''`.
  - `flag(item: PhoneStock, line: DeliveryLine): 'high' | 'low' | undefined`: `sanity(qty, item.usual ?? [])`, silent once `line.checked === line.amount`.
  - `deliveryJobs(delivery: Delivery, stock: PhoneStock[], actor: string, now: string): Job[]`: one `stock.record` per line with `id = line.id` and payload `{ stockId, kind: 'purchase', qty, reason, cost, fromDrawer: false }`, plus `photo` on the first line only. Throws `Isi pemasok atau nomor nota`, `Tambahkan bahan yang datang`, `Cek jumlah yang ditandai`, `Harga terlalu besar` (cost over 1 000 000 000).

- [ ] **Step 1: Write the failing tests** in `tests/unit/stok-logic.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { lookup, normalizeCode } from '../../src/stok/barcode'
import { ALL_AREAS, areas, countJob, setCounted, startCount } from '../../src/stok/count'
import { deliveryJobs, flag, lineCost, lineQty, suggestedPrice, units } from '../../src/stok/delivery'
import type { Delivery, PhoneStock } from '../../src/stok/types'

const milk: PhoneStock = { id: 'milk', name: 'Susu UHT', unit: 'ml', area: 'Kulkas bar', packs: [{ name: 'karton', qty: 12_000_000 }], cost: 0.018, usual: [36_000_000, 36_000_000, 36_000_000] }
const syrup: PhoneStock = { id: 'syrup', name: 'Sirup vanila', unit: 'pcs', area: 'Rak bar', usual: [6000, 6000, 6000] }
const rice: PhoneStock = { id: 'rice', name: 'Beras', unit: 'g', area: 'Dry store' }
const stock = [syrup, rice, milk]
const now = '2026-11-17T03:00:00.000Z'

describe('barcode', () => {
  it('trims, and gives a 12-digit code its leading zero', () => {
    expect(normalizeCode(' 8991002101234\n')).toBe('8991002101234')
    expect(normalizeCode('036000291452')).toBe('0036000291452')
  })
  it('refuses a code that is too short, too long or has a space inside', () => {
    expect(normalizeCode('12')).toBeUndefined()
    expect(normalizeCode('8991 002')).toBeUndefined()
    expect(normalizeCode('x'.repeat(65))).toBeUndefined()
  })
  it('finds the bahan and its pack, and falls back to the base unit when the pack is gone', () => {
    expect(lookup('1', {}, stock)).toBeUndefined()
    expect(lookup('1', { '1': { stockId: 'milk', pack: 'karton' } }, stock)).toEqual({ item: milk, pack: milk.packs![0] })
    expect(lookup('1', { '1': { stockId: 'milk', pack: 'dus' } }, stock)).toEqual({ item: milk, pack: undefined })
    expect(lookup('1', { '1': { stockId: 'gone', pack: '' } }, stock)).toBeUndefined()
  })
})

describe('count', () => {
  it('lists areas and walks a count by area, then name', () => {
    expect(areas(stock)).toEqual(['Dry store', 'Kulkas bar', 'Rak bar'])
    const all = startCount(stock, '', 'u1', 'c1', now)
    expect([all.area, all.status, all.startedBy, all.startedAt]).toEqual([ALL_AREAS, 'draft', 'u1', now])
    expect(all.lines.map((l) => l.stockId)).toEqual(['rice', 'milk', 'syrup'])
    expect(startCount(stock, 'Rak bar', 'u1', 'c2', now).lines).toEqual([{ stockId: 'syrup' }])
    expect(() => startCount(stock, 'Gudang', 'u1', 'c3', now)).toThrow('Tidak ada bahan di area ini')
  })
  it('sets, clears and adds a line', () => {
    const c = startCount(stock, 'Rak bar', 'u1', 'c2', now)
    expect(setCounted(c, 'syrup', 6000).lines).toEqual([{ stockId: 'syrup', counted: 6000 }])
    expect(setCounted(setCounted(c, 'syrup', 6000), 'syrup', undefined).lines).toEqual([{ stockId: 'syrup', counted: undefined }])
    expect(setCounted(c, 'milk', 0).lines).toEqual([{ stockId: 'syrup' }, { stockId: 'milk', counted: 0 }])
  })
  it('sends only what was counted, and drops a bahan that no longer exists', () => {
    let c = startCount(stock, '', 'u1', 'c1', now)
    expect(() => countJob(c, stock, 'u1', 'j1', now)).toThrow('Belum ada bahan yang dihitung')
    c = setCounted(setCounted(c, 'milk', 29_000_000), 'rice', 0)
    expect(countJob(c, [milk, syrup], 'u1', 'j1', now)).toEqual({
      id: 'j1', actor: 'u1', occurredAt: now, state: 'pending', type: 'op', kind: 'count.submit', label: 'Hitung Semua area · 1 bahan',
      payload: { id: 'c1', area: ALL_AREAS, lines: [{ stockId: 'milk', counted: 29_000_000, reason: '' }] },
    })
  })
})

describe('delivery', () => {
  const line = (p: Partial<Delivery['lines'][number]> = {}) => ({ id: 'l1', stockId: 'milk', unit: 'karton', amount: '3', price: '216000', ...p })
  it('offers packs, then kg or L, then the base unit', () => {
    expect(units(milk)).toEqual([{ name: 'karton', per: 12_000_000 }, { name: 'l', per: 1_000_000 }, { name: 'ml', per: 1000 }])
    expect(units(syrup)).toEqual([{ name: 'pcs', per: 1000 }])
  })
  it('turns an amount into base units and a cost', () => {
    expect(lineQty(milk, line())).toBe(36_000_000)
    expect(lineQty(milk, line({ unit: 'l', amount: '2,5' }))).toBe(2_500_000)
    expect(lineQty(milk, line({ amount: '' }))).toBe(0)
    expect(() => lineQty(milk, line({ amount: '3 karton' }))).toThrow('Gunakan angka positif')
    expect(lineCost(milk, line())).toBe(648_000)
    expect(lineCost(milk, line({ price: '' }))).toBe(0)
    expect(suggestedPrice(milk, 'karton')).toBe('216000')
    expect(suggestedPrice(rice, 'kg')).toBe('')
  })
  it('flags an unusual amount until it is confirmed', () => {
    const big = { id: 'l2', stockId: 'syrup', unit: 'pcs', amount: '60', price: '' }
    expect(flag(syrup, big)).toBe('high')
    expect(flag(syrup, { ...big, checked: '60' })).toBeUndefined()
    expect(flag(syrup, { ...big, amount: '6' })).toBeUndefined()
    expect(flag(rice, { ...big, stockId: 'rice', unit: 'kg' })).toBeUndefined()
  })
  it('builds one stock entry per line, reusing the line id, with the photo on the first', () => {
    const d: Delivery = { id: 'd1', note: ' CV Susu Jaya, nota 1203 ', photo: 'data:image/webp;base64,AAAA', lines: [line(), { id: 'l2', stockId: 'syrup', unit: 'pcs', amount: '6', price: '85000' }] }
    const jobs = deliveryJobs(d, stock, 'u1', now)
    expect(jobs.map((j) => j.id)).toEqual(['l1', 'l2'])
    expect(jobs[0]).toMatchObject({ actor: 'u1', occurredAt: now, state: 'pending', type: 'op', kind: 'stock.record', payload: { stockId: 'milk', kind: 'purchase', qty: 36_000_000, reason: 'CV Susu Jaya, nota 1203', cost: 648_000, fromDrawer: false, photo: 'data:image/webp;base64,AAAA' } })
    expect(jobs[1].type === 'op' && jobs[1].payload).toEqual({ stockId: 'syrup', kind: 'purchase', qty: 6000, reason: 'CV Susu Jaya, nota 1203', cost: 510_000, fromDrawer: false })
  })
  it('refuses a delivery with no note, no lines, or an unconfirmed flag', () => {
    expect(() => deliveryJobs({ id: 'd', note: ' ', lines: [line()] }, stock, 'u1', now)).toThrow('Isi pemasok atau nomor nota')
    expect(() => deliveryJobs({ id: 'd', note: 'x', lines: [] }, stock, 'u1', now)).toThrow('Tambahkan bahan yang datang')
    expect(() => deliveryJobs({ id: 'd', note: 'x', lines: [{ id: 'l2', stockId: 'syrup', unit: 'pcs', amount: '60', price: '' }] }, stock, 'u1', now)).toThrow('Cek jumlah yang ditandai')
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run tests/unit/stok-logic.test.ts`
Expected: FAIL, cannot resolve `../../src/stok/barcode`.

- [ ] **Step 3: Implement the four files** to the interfaces above.

- [ ] **Step 4: Run to see them pass**

Run: `pnpm vitest run tests/unit/stok-logic.test.ts && npx tsc -b`
Expected: 11 tests pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/stok tests/unit/stok-logic.test.ts
git commit -m "feat: barcode, count and delivery logic for the stock app"
```

---

### Task 5: Phone logic: the queue, sending, and demo data

**Files:**
- Create: `src/stok/queue.ts`, `src/stok/sync.ts`, `src/stok/demo.ts`, `tests/unit/stok-sync.test.ts`

**Interfaces:**
- Consumes: `Job`, `Identity`, `Operation`, `Server`, `Snapshot`, `KV` from Task 4; `stock` from `src/domain/sample.ts`.
- Produces, `src/stok/queue.ts`:
  - `load<T>(kv: KV, key: string, fallback: T): T` (missing or broken JSON gives the fallback) and `save(kv: KV, key: string, value: unknown): void`
  - `class Queue { constructor(kv: KV, userId: string); all(): Job[]; add(jobs: Job[]): void; done(id: string): void; reject(id: string, error: string): void; renew(id: string, newId: string, now: string): void; remove(id: string): void }`
    - Stored under `stok-queue-<userId>`; every change is written at once.
    - `add` skips a job whose id is already queued. `renew` turns a rejected job into a pending one with a new id and time.
- Produces, `src/stok/sync.ts`:
  - `class Rejected extends Error`
  - `classify(error: { code?: string; message: string }): Error`: a `Rejected` for codes `P0001`, `23514`, `42501`, `23503`, `23505`, `22P02` (the list in `serverTransport`, `src/lib/sync.ts`), otherwise a plain `Error`.
  - `toOperation(job: Extract<Job, { type: 'op' }>, identity: Identity): Operation`
  - `flush(queue: Queue, identity: Identity, server: Server): Promise<{ sent: number; rejected: number; left: number }>`: pending jobs of `identity.id` only, oldest first. A `Rejected` marks the job and goes on. Any other error stops the run and leaves the rest pending.
- Produces, `src/stok/demo.ts`:
  - `demoIdentity(deviceId: string): Identity` (role `admin`, `demo: true`, `paired: true`, id `demo-admin`)
  - `demoSnapshot(now: string): Snapshot`: Takar's sample `stock`, store `Ziggy Lounge (demo)`, three barcodes: `8991002101234` → `water` / `dus`, `8992753102207` → `coffee` / `bungkus`, `8998866200301` → `egg` / `''`.
  - `demoServer(now: () => string): Server`: keeps links in memory, accepts every job, `snapshot` returns the sample with the current links.

- [ ] **Step 1: Write the failing tests** in `tests/unit/stok-sync.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { demoIdentity, demoServer, demoSnapshot } from '../../src/stok/demo'
import { Queue, load, save } from '../../src/stok/queue'
import { Rejected, classify, flush, toOperation } from '../../src/stok/sync'
import type { Identity, Job, KV, Operation, Server } from '../../src/stok/types'

const memory = (): KV => { const m = new Map<string, string>(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) } }
const me: Identity = { id: 'u1', name: 'Adit', role: 'admin', restaurantId: 'r1', store: 'Ziggy', timezone: 'Asia/Jakarta', deviceId: 'd1', paired: true, demo: false }
const job = (id: string, p: Partial<Job> = {}): Job => ({ id, actor: 'u1', occurredAt: `2026-11-17T03:00:0${id.slice(-1)}.000Z`, label: id, state: 'pending', type: 'op', kind: 'stock.record', payload: { stockId: 'milk' }, ...p } as Job)
const server = (apply: (o: Operation) => Promise<void>): Server => ({ apply, link: async () => {}, unlink: async () => {}, pair: async () => {}, snapshot: async () => demoSnapshot('now') })

describe('queue', () => {
  it('survives a restart and reads broken storage as empty', () => {
    const kv = memory()
    new Queue(kv, 'u1').add([job('j1'), job('j2')])
    expect(new Queue(kv, 'u1').all().map((j) => j.id)).toEqual(['j1', 'j2'])
    expect(new Queue(kv, 'u2').all()).toEqual([])
    kv.setItem('stok-queue-u1', '{broken')
    expect(new Queue(kv, 'u1').all()).toEqual([])
    save(kv, 'k', { a: 1 })
    expect(load(kv, 'k', {})).toEqual({ a: 1 })
    expect(load(kv, 'missing', 7)).toBe(7)
  })
  it('never queues the same id twice', () => {
    const q = new Queue(memory(), 'u1')
    q.add([job('j1')]); q.add([job('j1'), job('j2')])
    expect(q.all().map((j) => j.id)).toEqual(['j1', 'j2'])
  })
  it('keeps a refused job with its message until it is sent again as new or deleted', () => {
    const q = new Queue(memory(), 'u1')
    q.add([job('j1'), job('j2')]); q.reject('j1', 'Device not enrolled')
    expect(q.all()[0]).toMatchObject({ state: 'rejected', error: 'Device not enrolled' })
    q.renew('j1', 'j9', '2026-11-18T00:00:00.000Z')
    expect(q.all().map((j) => [j.id, j.state, j.error])).toEqual([['j2', 'pending', undefined], ['j9', 'pending', undefined]])
    q.remove('j9'); q.done('j2')
    expect(q.all()).toEqual([])
  })
})

describe('sending', () => {
  it('tells a final refusal from a failure worth another try', () => {
    expect(classify({ code: 'P0001', message: 'Operation timestamp outside recovery window' })).toBeInstanceOf(Rejected)
    expect(classify({ code: '42501', message: 'Manager permission required' })).toBeInstanceOf(Rejected)
    expect(classify({ message: 'Failed to fetch' })).not.toBeInstanceOf(Rejected)
    expect(classify({ code: 'PGRST301', message: 'JWT expired' })).not.toBeInstanceOf(Rejected)
  })
  it('wraps a job as the operation apply_operation expects', () => {
    const j = job('j1')
    expect(toOperation(j as Extract<Job, { type: 'op' }>, me)).toEqual({ id: 'j1', kind: 'stock.record', actor: 'u1', restaurantId: 'r1', deviceId: 'd1', occurredAt: j.occurredAt, payload: { stockId: 'milk' } })
  })
  it('sends oldest first and removes what was accepted', async () => {
    const q = new Queue(memory(), 'u1'), seen: string[] = []
    q.add([job('j2'), job('j1')])
    expect(await flush(q, me, server(async (o) => void seen.push(o.id)))).toEqual({ sent: 2, rejected: 0, left: 0 })
    expect(seen).toEqual(['j1', 'j2'])
  })
  it('sets a refused job aside and carries on', async () => {
    const q = new Queue(memory(), 'u1')
    q.add([job('j1'), job('j2')])
    expect(await flush(q, me, server(async (o) => { if (o.id === 'j1') throw new Rejected('Bahan tidak ditemukan') }))).toEqual({ sent: 1, rejected: 1, left: 0 })
    expect(q.all()).toMatchObject([{ id: 'j1', state: 'rejected', error: 'Bahan tidak ditemukan' }])
  })
  it('stops at a network failure and sends the same ids on the next try', async () => {
    const q = new Queue(memory(), 'u1'), seen: string[] = []
    q.add([job('j1'), job('j2')])
    let online = false
    const s = server(async (o) => { seen.push(o.id); if (!online) throw new Error('Failed to fetch') })
    expect(await flush(q, me, s)).toEqual({ sent: 0, rejected: 0, left: 2 })
    online = true
    expect(await flush(q, me, s)).toEqual({ sent: 2, rejected: 0, left: 0 })
    expect(seen).toEqual(['j1', 'j1', 'j2'])
  })
  it('leaves another person\'s work alone', async () => {
    const kv = memory(), q = new Queue(kv, 'u1')
    q.add([job('j1', { actor: 'u2' }), job('j2')])
    expect(await flush(q, me, server(async () => {}))).toEqual({ sent: 1, rejected: 0, left: 0 })
    expect(q.all().map((j) => j.id)).toEqual(['j1'])
  })
  it('sends barcode links through their own calls', async () => {
    const q = new Queue(memory(), 'u1'), calls: string[] = []
    q.add([job('j1', { type: 'link', code: '899', stockId: 'milk', pack: 'karton' } as Partial<Job>), job('j2', { type: 'unlink', code: '899' } as Partial<Job>)])
    await flush(q, me, { ...server(async () => {}), link: async (d, c, s, p) => void calls.push(`link ${d} ${c} ${s} ${p}`), unlink: async (d, c) => void calls.push(`unlink ${d} ${c}`) })
    expect(calls).toEqual(['link d1 899 milk karton', 'unlink d1 899'])
  })
})

describe('demo', () => {
  it('runs on Takar\'s sample bahan and remembers a link', async () => {
    const s = demoServer(() => 'now')
    expect(demoIdentity('d1')).toMatchObject({ role: 'admin', demo: true, paired: true, deviceId: 'd1' })
    expect((await s.snapshot('d1')).barcodes.find((b) => b.code === '8991002101234')).toEqual({ code: '8991002101234', stockId: 'water', pack: 'dus' })
    await s.link('d1', '4902430', 'rice', 'karung')
    expect((await s.snapshot('d1')).barcodes.some((b) => b.code === '4902430' && b.stockId === 'rice')).toBe(true)
    await s.unlink('d1', '4902430')
    expect((await s.snapshot('d1')).barcodes.some((b) => b.code === '4902430')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run tests/unit/stok-sync.test.ts`
Expected: FAIL, cannot resolve `../../src/stok/demo`.

- [ ] **Step 3: Implement the three files** to the interfaces above.

- [ ] **Step 4: Run to see them pass**

Run: `pnpm vitest run tests/unit/stok-sync.test.ts && npx tsc -b && pnpm test`
Expected: 11 tests pass in the file, no type errors, 232 tests pass in all.

- [ ] **Step 5: Commit**

```bash
git add src/stok tests/unit/stok-sync.test.ts
git commit -m "feat: offline queue, sending and demo data for the stock app"
```

---

### Task 6: Platform glue and app state

**Files:**
- Create: `mobile/src/platform/supabase.ts`, `mobile/src/platform/photo.ts`, `mobile/src/state.tsx`

**Interfaces:**
- Consumes: everything from Tasks 4 and 5.
- Produces, `mobile/src/platform/supabase.ts`:
  - `configured: boolean` (both `EXPO_PUBLIC_` values are set)
  - `server: Server`: `stock_app`, `apply_operation`, `link_barcode`, `unlink_barcode`, `enroll_phone` through `supabase.rpc`, every error passed through `classify`.
  - `signIn(email: string, secret: string): Promise<string>` (the user id), `signOut(): Promise<void>`, `currentUser(): Promise<string | undefined>`
  - The client is created as Expo's Supabase guide does: `import 'expo-sqlite/localStorage/install'`, `auth: { storage: localStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false }`, and the `AppState` listener that starts and stops auto refresh.
- Produces, `mobile/src/platform/photo.ts`:
  - `shrinkNote(uri: string): Promise<string>`: a WebP data URL of at most 70 000 characters. Tries widths 900, 720, 560 with `compress` 0.5, 0.35, 0.25 in turn and returns the first that fits; throws `Foto masih terlalu besar. Coba ambil lebih dekat.`
- Produces, `mobile/src/state.tsx`: `AppProvider` and `useApp(): App`

```ts
export interface App {
  ready: boolean; identity?: Identity; team: TeamMember[]; stock: PhoneStock[]; links: Record<string, BarcodeLink>
  jobs: Job[]; drafts: CountSession[]; delivery: Delivery; sent: { id: string; label: string; at: string }[]
  busy: boolean; syncing: boolean; error: string; notice: string
  signIn(email: string, secret: string): Promise<void>; startDemo(): void; signOut(): Promise<void>; pair(): Promise<void>; sync(): Promise<void>
  saveDraft(session: CountSession): void; dropDraft(id: string): void; submitCount(session: CountSession): void
  setDelivery(delivery: Delivery): void; saveDelivery(): void
  link(code: string, stockId: string, pack: string): void; unlink(code: string): void
  renew(jobId: string): void; discard(jobId: string): void; clearMessage(): void
}
```

- Behaviour that the signature does not show:
  - Storage keys: `stok-device`, `stok-team`, `stok-identity`, `stok-snapshot`, and per person `stok-drafts-<id>`, `stok-delivery-<id>`, `stok-sent-<id>`. Every setter writes at once.
  - The device id is made once with `Crypto.randomUUID()` and kept. New ids for jobs, counts, deliveries and lines come from the same call.
  - On start: read storage; a saved identity without a Supabase session (and not demo) is dropped, its queue is kept.
  - `sync()`: `flush`, then `server.snapshot`, then update `stock`, `links`, `team` and `identity.paired`. `No active staff membership` signs the person out. A network failure is not shown as an error; `syncing` and the count of `jobs` tell the story.
  - It runs after anything is queued, when the app comes to the front, and every 30 seconds while `jobs` has pending items.
  - `link` and `unlink` change `links` at once, then queue the job.
  - `submitCount` queues `countJob`, removes the draft, and adds a line to `sent`. `saveDelivery` queues `deliveryJobs` and starts an empty delivery. Both show `Disimpan. Terkirim saat ada sinyal.` when offline, or `Terkirim` once the flush sent them.
  - `signOut` is refused while this person has jobs: `Masih ada <n> catatan belum terkirim. Cari sinyal dulu, lalu ganti pengguna.`
  - `sent` keeps the last 20 items.

- [ ] **Step 1: Write the three files.**

- [ ] **Step 2: Type-check and bundle**

Run (in `mobile/`): `npx tsc --noEmit && npx expo export --platform web --output-dir dist`
Expected: no type errors, the web bundle builds.

- [ ] **Step 3: Commit**

```bash
git add mobile/src
git commit -m "feat: Supabase glue, photo shrinking and app state for the stock app"
```

---

### Task 7: Sign in, pair, home

**Files:**
- Create: `mobile/src/ui/theme.ts`, `mobile/src/ui/kit.tsx`, `mobile/src/screens/SignIn.tsx`, `mobile/src/screens/Pair.tsx`, `mobile/src/screens/Home.tsx`, `mobile/src/screens/Attention.tsx`
- Modify: `mobile/App.tsx`

**Interfaces:**
- Consumes: `useApp()` from Task 6; `roleLabel`, `can` from `src/domain/permissions.ts`.
- Produces:
  - `theme.ts`: the three colours, a muted grey, a warning tint, spacing, and the three font family names.
  - `kit.tsx`: `Screen` (safe-area padding, paper ground, optional back header), `Button` (`primary` lime on ink text, `secondary`, `ghost`, `danger`; `loading`, `disabled`), `Field` (label plus `TextInput`), `Sheet` (a bottom `Modal`), `Chip`, `Toast` (shows `error` or `notice` from `useApp`, tap to dismiss).
  - `App.tsx`: providers, fonts, and the screen switch: not `ready` → blank paper; no identity → `SignIn`; not paired and not demo → `Pair`; otherwise `home | count | receive | attention`. `BackHandler` goes back to `home` from any other screen.

- Screen content (labels exact):
  - **SignIn.** Title `Siapa yang bertugas?`. One card per team member that has a `login`: initials, name, role. Tapping a name opens a 6-digit PIN field (`secureTextEntry`, number pad) that signs in on the sixth digit. Links: `Masuk dengan email` (email and password form) and `Coba demo`. With no team list the email form shows first. Wrong PIN: `PIN salah atau akun tidak aktif`. Not `configured`: only `Coba demo`, with `Koneksi restoran belum diatur.`
  - **Pair.** Owner or manager: `Pasangkan ponsel ini`. Others: `Ponsel ini belum dipasangkan. Minta pemilik atau manajer masuk di ponsel ini sekali.` Both show `Keluar`.
  - **Home.** `Hai <name> · <role>` with `Ganti`. Status line: `Tersinkron`, `Mengirim…`, or `<n> belum terkirim`. Two tiles: `Hitung stok` and `Terima barang`; the second is greyed with `Hanya pemilik, manajer atau admin stok` when `can(role,'inventory')` is false. `Dijeda` lists drafts as `<area> · <n> dari <m> dihitung` with `Lanjutkan`. `Terkirim hari ini` lists today's `sent`. A warning row `Perlu perhatian (<n>)` appears when a job is rejected. Pulling the list down calls `sync()`. Demo shows a `Demo` badge.
  - **Attention.** Each rejected job: its label, the server's message, `Kirim ulang` and `Hapus`.

- [ ] **Step 1: Write the files.**

- [ ] **Step 2: Type-check, bundle, and look at it.** Run in `mobile/`: `npx tsc --noEmit && npx expo export --platform web --output-dir dist`, serve `dist` on `127.0.0.1`, open it at phone width, tap `Coba demo`, and confirm Home shows both tiles and the `Demo` badge with no console errors.

- [ ] **Step 3: Commit**

```bash
git add mobile
git commit -m "feat: sign in, pairing and home screens for the stock app"
```

---

### Task 8: Hitung stok

**Files:**
- Create: `mobile/src/ui/Scanner.tsx`, `mobile/src/ui/ItemPicker.tsx`, `mobile/src/screens/Count.tsx`

**Interfaces:**
- Consumes: `BARCODE_TYPES`, `normalizeCode`, `lookup` (Task 4); `areas`, `startCount`, `setCounted`, `ALL_AREAS` (Task 4); `measure`, `blank`, `BIG`, `Entry` (Task 2); `search`, `quantity` from `src/domain/calculate.ts`; `useApp()`.
- Produces:
  - `Scanner({ onCode, active }: { onCode(code: string): void; active: boolean })`: asks for the camera with `Izinkan kamera`; a `CameraView` strip 180 points high with `barcodeScannerSettings={{ barcodeTypes: [...BARCODE_TYPES] }}`; a `Senter` toggle; ignores the same code for 1.5 seconds; passes codes through `normalizeCode` and drops invalid ones.
  - `ItemPicker({ code, onPick, onClose })`: the "Barcode belum dikenal" sheet. Title `Kode <code> belum dikenal`, a search field, the matching bahan, then `Kode ini untuk:` with `satuan` and one choice per pack (`<name> <amount>`), and `Simpan`. A wrong link is fixed from the bahan's entry with `Lepas`, then by scanning the code again.

- Screen behaviour:
  - No draft open: an area list (`Semua area` first), then `Mulai menghitung`.
  - Scan mode: header `Hitung: <area>`, `<n> dari <m>`, `Jeda`; the scanner; a field `Ketik kode atau cari nama bahan`; `Belum dihitung (<k>)` then `Sudah dihitung (<n>)`, each row showing the name and, once counted, what was typed in words (`2 karton + 5 L = 29.000 ml`); `Kirim untuk ditinjau` at the bottom, disabled until something is counted.
  - The field does two jobs: digits that `lookup` finds open that bahan on submit; anything else filters the list with `search`.
  - A code with no link opens `ItemPicker`. A bahan from another area asks `Bahan ini tercatat di area <X>. Tambahkan ke hitungan ini?`.
  - Entry mode (the camera is off): the bahan's name, one box per pack (`Karton penuh`), one box for the open pack or `Jumlah` with a `g ↔ kg` or `ml ↔ L` switch, the total (`= 29.000 ml`), the linked codes with `Lepas`, and `Simpan, pindai berikutnya`. A linked pack puts the cursor in that pack's box. A bad number shows `convert`'s message and blocks saving.
  - Every change calls `saveDraft`. `Jeda` and the back button return to Home with the draft kept.
  - `Kirim untuk ditinjau` asks `Kirim <n> dari <m> bahan? Yang belum dihitung tidak dikirim.` then calls `submitCount`.
  - Nothing on this screen reads a balance, an expected amount or a cost.

- [ ] **Step 1: Write the files.**

- [ ] **Step 2: Check it in demo mode.** Type-check, bundle for web, open at phone width, then: start a count for `Dry store`; type `8991002101234` (opens Air mineral botol with the cursor in `Dus penuh`); enter `2` and `5`, save; type `4902430` (unknown), link it to Beras as `karung`; pause; resume from Home and confirm the amounts are still there; send, and confirm Home lists it under `Terkirim hari ini`.

- [ ] **Step 3: Commit**

```bash
git add mobile/src
git commit -m "feat: count stock by scanning in the stock app"
```

---

### Task 9: Terima barang

**Files:**
- Create: `mobile/src/screens/Receive.tsx`

**Interfaces:**
- Consumes: `Scanner`, `ItemPicker` (Task 8); `units`, `lineQty`, `lineCost`, `suggestedPrice`, `flag` (Task 4); `shrinkNote` (Task 6); `quantity`, `rupiah` from `src/domain/calculate.ts`; `useApp()`.

- Screen behaviour:
  - Header `Terima barang`. Field `Pemasok / nota` (placeholder `Contoh: CV Susu Jaya, nota 1203`). Button `Foto nota`, which opens the camera full screen with a shutter, shrinks the picture with `shrinkNote`, and then shows a thumbnail with `Ganti` and `Hapus`.
  - The scanner and the same `Ketik kode atau cari nama bahan` field as the count.
  - A found bahan opens a sheet: `Jumlah` (decimal pad), a unit chip per `units(item)` (the linked pack preselected, else the first), `Harga per <unit>` prefilled with `suggestedPrice`, the line total, and `Tambah`. A bahan already in the list opens its line for editing, with `Hapus baris`.
  - The list shows each line as name, amount with unit, and total. A flagged line shows `<amount> <unit> itu <k>× kiriman biasa (<usual>).` or `… jauh di bawah kiriman biasa (<usual>).` with `Ubah` and `Ya, benar` (sets `checked`).
  - Bottom button `Masukkan ke stok · <total>`: disabled with no lines; calls `saveDelivery`, which shows the error from `deliveryJobs` when the note is blank or a flag is open.
  - Every change calls `setDelivery`, so the delivery survives a closed app.
  - The screen is reachable only when `can(role,'inventory')` is true.

- [ ] **Step 1: Write the file.**

- [ ] **Step 2: Check it in demo mode.** Type-check, bundle for web, open at phone width, then: add Air mineral botol, 3 dus, and confirm the price is prefilled and the total is right; add Biji kopi with an amount ten times the usual and confirm the warning blocks saving until `Ya, benar`; leave the note blank and confirm the message; fill it, save, and confirm Home shows the items as sent and the delivery screen is empty again.

- [ ] **Step 3: Commit**

```bash
git add mobile/src
git commit -m "feat: record deliveries by scanning in the stock app"
```

---

### Task 10: Final checks and the guide

**Files:**
- Create: `docs/MOBILE.md`
- Modify: `README.md` (one line under the project map pointing to `docs/MOBILE.md`)

**Interfaces:**
- Consumes: the finished app.

- [ ] **Step 1: Run everything**

```bash
pnpm test:db && pnpm test && npx tsc -b && pnpm build
cd mobile && npx tsc --noEmit && npx expo-doctor && npx expo export --platform android --output-dir dist && npx expo export --platform web --output-dir dist
```
Expected: 64 database checks, 232 unit tests, no type errors, the web app builds, `20/20 checks passed`, both bundles export. Restore `tsconfig.tsbuildinfo` with `git checkout --` if the build touched it.

- [ ] **Step 2: Walk the whole app once more in demo mode** at phone width: sign in, count, link, pause and resume, send, receive, and the `Perlu perhatian` list (reject one job by hand in storage to see it). Take one screenshot each of Home, the count entry and the delivery list.

- [ ] **Step 3: Write `docs/MOBILE.md`**: what the app is and is not; try it with Expo Go (`cp .env.example .env`, fill the two values from the web app's `.env`, `npx expo start`, scan the QR code); the migration that must be applied first (`supabase db push`, the user's call); pairing a phone; building an Android APK with Expo's cloud build (`npx eas-cli@latest login`, set the two `EXPO_PUBLIC_` values in Expo's environment for `preview`, `npx eas-cli@latest build -p android --profile preview`); what was checked here and what only a real phone can check (camera, WebP on device, offline); known limits from the spec (no idle lock, no revoke, no PO receiving).

- [ ] **Step 4: Commit**

```bash
git add docs/MOBILE.md README.md
git commit -m "docs: how to run, pair and build the stock app"
```

## After the plan

Not part of this plan, and each needs the user's word: merging the branch into `main` (rerun every check after merging, because `main` is changing), applying the migration to the hosted project, creating the Expo account and the first APK, and trying the camera on a real phone.
