/**
 * Full-stack browser tests: the real app (Vite dev server, real supabase-js) against the real SQL (every migration in
 * PGlite), with Supabase emulated inside the Playwright worker on http://127.0.0.1:54321 (the e2e build's URL).
 *
 * Import this instead of ../meja:
 *
 *   import { test, expect, signIn, makeTill, outbox, openShift, addItem, sell } from './stack'   // from tests/e2e/*.spec.ts
 *   import { test, expect, signIn } from '/Users/FarizsMBP/Documents/possum/tests/e2e/stack'    // from outside the repo
 *   (also exported: pay, useDevice, cart, go, prints, drawer, balance, manualDiscount, Stack, StackError, types)
 *
 *   test('a cash sale reaches the server', async ({ page, stack }) => {
 *     await signIn(page, stack.users.owner)            // e-mail + password on '/', through GoTrue (signed-out device)
 *     await makeTill(page)                             // Tim & perangkat → Jadikan perangkat ini kasir utama
 *     await page.goto('/pos'); await openShift(page); await addItem(page, 'Es teh'); await sell(page)
 *     await expect.poll(() => stack.sql(`select status from orders`), { timeout: 20_000 }).toEqual([{ status: 'paid' }])
 *     await expect.poll(() => outbox(page), { timeout: 20_000 }).toEqual([])  // nothing pending or rejected on the device
 *   })
 *
 *   Faster than makeTill, for tests about something else: pair server-side, then sign in (pairing is read at sign-in):
 *     const till = await useDevice(context); await stack.rpc(stack.users.owner, 'enroll_device', { device_id: till, mode: 'pos' })
 *     await signIn(page, stack.users.cashier)          // mode 'station' or 'office' pairs other devices the same way
 *
 * The `stack` fixture (one per test, a clone of a database built once per worker, ~0.3 s):
 *   - starts seeded: restaurant "Ziggy Lounge" (defaultSettings: stationTablets on, no tax), the demo's menu and
 *     ingredients with opening stock (10 kg / 10 l / 50 pcs each), one person per role in stack.users
 *     (owner, manager, admin, chef, cashier, barista, kitchen, accountant: { id, email, password, approvalPin?, ... }).
 *     The password is a 6-digit PIN, so name + PIN sign-in works too; owner, manager and admin have an approval PIN.
 *     stack.restaurantId, stack.settings and stack.office (the owner's paired back-office device id) go with it.
 *     test.use({ stackSeed: 'corpus' }) seeds tests/corpus instead (Ziggy's real settings: PB1 10%, service 5%, no
 *     station tablets, EDCs; ~250 bahan, ~100 menus; corpus staff names, extra staff in stack.extra). test.use({
 *     stackSeed: 'empty' }) starts from bare migrations; then `await stack.seed({...})`. stackSeed is a worker option:
 *     Playwright takes its test.use only at the top level of a spec file (not inside a describe) or in the config.
 *   - is attached to the test's `context`, so `page` talks to it. stack.newPage(options?) opens another device (its own
 *     context and storage, same database): a second tablet, the manager's laptop.
 *   - test controls: stack.sql(text, params) (superuser), stack.sqlAs(person, text, params) (RLS as that person),
 *     stack.rpc(person | null, fn, args), stack.apply(person, deviceId, kind, payload, occurredAt?),
 *     stack.offline(on?), stack.delay(ms, key?), stack.fail(key | predicate, failure, { times }), stack.heal(),
 *     stack.calls(key?), stack.ttl (seconds for new access tokens), stack.expireTokens(), stack.endSessions(person?),
 *     stack.token(person), stack.addPerson(restaurantId, {...}), stack.seed({...}), stack.telegram (edge calls).
 *     Keys: an RPC name ('apply_operation', 'pull', 'bootstrap'...), 'table:<name>', 'auth:password',
 *     'auth:refresh_token', 'auth:user', 'auth:logout', 'fn:telegram'.
 *     Failures: 'network' (net::ERR_FAILED), 'offline' (ERR_INTERNET_DISCONNECTED), or a PostgREST error
 *     { code, message, status?, details?, hint? } (status defaults from the code, as PostgREST maps it).
 *     stack.calls() entries: { key, method, url, user (JWT sub), args (RPC body or query), status, error?, at, ms }; status 0
 *     means not answered (aborted by offline()/fail(), or still in flight); ms is the time to answer, injected delay included.
 *   - the browser's own offline mode is Playwright's: `await context.setOffline(true)` (navigator.onLine goes false
 *     and the dev server is unreachable too). stack.offline() is the till's usual case: Wi-Fi up, internet down.
 *   - timing: a device syncs after each action, but a sync that finds another one running skips it (Web Lock,
 *     ifAvailable), and the till's next tick is 10 s away (station 5 s, laptop 30 s). Poll server state with
 *     `expect.poll(..., { timeout: 20_000 })`, not the 7 s default.
 *   - the pilot's own settings (no station tablets, so no "Ke stasiun"; stock moves when paid) are one call away,
 *     before the device signs in: `await stack.apply(stack.users.owner, stack.office, 'settings.update',
 *     { settings: { ...stack.settings, stationTablets: false } })`, then pay with `pay(page)`.
 * See ./supabase.ts for what is emulated and how faithfully.
 */
import type { Page, BrowserContext } from '@playwright/test'
import { test as base, expect, cart } from '../meja'
import { Stack, type Seeded, type SeedOptions } from './supabase'
import { roles } from '../../../src/domain/permissions'
import type { Role } from '../../../src/domain/types'
export { Stack, StackError, SUPABASE_URL, ANON_KEY, type Person, type Seeded, type SeedOptions, type Call, type Failure } from './supabase'
export { expect, prints, openShift, addItem, cart, sell, go, drawer, balance, manualDiscount } from '../meja'

export const test = base.extend<{ stack: Stack }, { stackSeed: 'ziggy' | 'corpus' | 'empty'; stackTemplate: { dump: Blob; seeded?: Seeded } }>({
  // A worker option: test.use({ stackSeed: 'corpus' }) at a file's top level runs that file in workers built for it.
  stackSeed: ['ziggy', { option: true, scope: 'worker' }],
  // Migrations and the seed once per worker; every test gets a clone.
  stackTemplate: [async ({ stackSeed }, use) => {
    const migrated = await Stack.template()
    if (stackSeed === 'empty') return use({ dump: migrated })
    const first = await Stack.create(migrated), seeded = await first.seed(stackSeed === 'corpus' ? await corpus() : {}), dump = await first.dump()
    await first.close()
    await use({ dump, seeded })
  }, { scope: 'worker', timeout: 180_000 }],
  stack: async ({ context, browser, stackTemplate }, use) => {
    const stack = await Stack.create(stackTemplate.dump)
    if (stackTemplate.seeded) Object.assign(stack, stackTemplate.seeded)
    stack.browser = browser
    await stack.attach(context)
    await use(stack)
    await stack.close()
  },
})
// tests/corpus (the realistic Ziggy catalog, built by another QA pass): its settings (PB1 10%, service 5%, no station
// tablets, three EDCs, packaging, saved discounts), ~250 bahan and ~100 menus, and its staff names on the role holders
// (the other staff in stack.extra). Imported only when asked for, so the default seed never depends on it.
async function corpus(): Promise<SeedOptions> {
  const c = await import('../../corpus/catalog')
  const day = (d: number) => new Date(Date.now() + 3 * 3600_000 + d * 86_400_000).toISOString().slice(0, 10) // Jakarta business day: UTC+7, turns at 04:00
  const holder = (role: Role) => c.ZIGGY_STAFF.find(p => p.role === role)
  return {
    name: 'Ziggy Lounge', settings: c.settings('Ziggy Lounge', day(0), [day(-1), day(30)]), menu: c.menu(), stock: c.stock(),
    people: Object.fromEntries(roles.flatMap(r => holder(r) ? [[r, { name: holder(r)!.name }]] : [])),
    extra: c.ZIGGY_STAFF.filter(p => holder(p.role) !== p).map((p, i) => ({ role: p.role, name: p.name, email: `${p.key}@ziggy-lounge.test`, password: String(620_000 + 1111 * i) })),
  }
}

/** Signs in on '/' with e-mail and password (what an owner does on a new device) and waits for the app shell. */
export async function signIn(page: Page, who: { email: string; password: string }) {
  if (!/^https?:/.test(page.url()) || new URL(page.url()).pathname !== '/') await page.goto('/')
  const email = page.getByLabel('Email staf'), other = page.getByRole('button', { name: /Masuk dengan email/ })
  await expect(email.or(other)).toBeVisible()
  // A device that already knows the team opens on the name picker.
  if (!await email.isVisible()) await other.click()
  await email.fill(who.email)
  await page.getByLabel('Kata sandi').fill(who.password)
  await page.getByRole('button', { name: /Masuk ke restoran/ }).click()
  await expect(page.locator('#main')).toBeVisible()
}

/** The owner makes this device the main till from Tim & perangkat, as on the tablet; the page reloads as the till. */
export async function makeTill(page: Page) {
  await page.goto('/team')
  await page.getByRole('button', { name: 'Jadikan perangkat ini kasir utama' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Pindahkan kasir utama ke sini' }).click()
  await expect(page.locator('.device-row').getByText('Kasir utama', { exact: true })).toBeVisible()
}

/** A cash payment of the cart where the store has no station tablets (the pilot): Bayar, then Catat pembayaran.
 *  Leaves the receipt dialog open, like sell() (which first sends the order to the stations). */
export async function pay(page: Page, { tendered }: { tendered?: string } = {}) {
  await cart(page).getByRole('button', { name: /^Bayar Rp/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Terima pembayaran' })
  if (tendered) await dialog.getByLabel(/Uang diterima/).fill(tendered)
  await dialog.getByRole('button', { name: /Catat pembayaran/ }).click()
  await expect(page.getByRole('dialog', { name: 'Pembayaran tercatat' })).toBeVisible()
}

/** Operations still on this device (pending or rejected), oldest first, read straight from its IndexedDB. */
export function outbox(page: Page) {
  return page.evaluate(async () => {
    const user = JSON.parse(localStorage.getItem('meja-identity') || 'null'); if (!user) return []
    const name = `meja-${user.demo ? 'demo' : 'live'}-${user.restaurantId}-${user.id}-${user.deviceId}`
    if (!(await indexedDB.databases()).some(d => d.name === name)) return []
    const db = await new Promise<IDBDatabase>((ok, ko) => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error) })
    try {
      const all = await new Promise<{ id: string; kind: string; state: string; error?: string; occurredAt: string }[]>((ok, ko) => { const r = db.transaction('outbox').objectStore('outbox').getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error) })
      return all.filter(o => o.state !== 'synced').sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).map(({ id, kind, state, error }) => ({ id, kind, state, error }))
    } finally { db.close() }
  })
}

/** Gives a context a known device id before the app first loads, so a test can pair it server-side:
 *  `const id = await useDevice(context); await stack.rpc(stack.users.owner, 'enroll_device', { device_id: id, mode: 'pos' })`. */
export async function useDevice(context: BrowserContext, id: string = crypto.randomUUID()) {
  await context.addInitScript(d => { if (!localStorage.getItem('meja-device')) localStorage.setItem('meja-device', d) }, id)
  return id
}
