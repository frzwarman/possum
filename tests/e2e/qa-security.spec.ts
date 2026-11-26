// QA 2026-11-25, cluster security: sign-in, the idle lock, sign-out, /admin and the role menus, in the real app against
// the real SQL (tests/e2e/stack).
import { test, expect, signIn, useDevice } from './stack'
import type { Locator, Page } from '@playwright/test'
const tick = { timeout: 20_000 }
const tapPin = async (scope: Page | Locator, pin: string) => { for (const d of pin) await scope.getByRole('button', { name: 'Angka ' + d, exact: true }).click() }
async function signOut(page: Page) {
  await page.goto('/settings')
  await page.locator('.account-footer').getByRole('button', { name: /Keluar akun/ }).click()
  await page.getByRole('dialog', { name: 'Keluar akun?' }).getByRole('button', { name: 'Keluar akun' }).click()
  await expect(page.getByRole('heading', { name: 'Siapa yang bertugas hari ini?' })).toBeVisible()
}
const PAUSED = 'Terlalu banyak PIN salah. Coba lagi dalam 5 menit.'

test('AUTH-03, SEC-3, AUTH-11: three wrong PINs pause that person for five minutes across a reload; no answer from the server is not a wrong PIN', async ({ page, stack }) => {
  const { owner, manager, cashier } = stack.users
  await signIn(page, owner)
  await signOut(page)
  await page.getByRole('button', { name: /Dedi Manajer/ }).click()
  const alert = page.getByRole('alert'), before = () => stack.calls('auth:password').length
  for (const [i, guess] of ['111222', '333444', '555666'].entries()) {
    const n = before()
    await tapPin(page, guess)
    await expect(alert).toHaveText(i < 2 ? 'PIN salah atau akun tidak aktif' : PAUSED, tick)
    expect(before()).toBe(n + 1)
  }
  // The right PIN is not even sent while paused, and a reload keeps the pause.
  const n = before()
  await tapPin(page, manager.password)
  await expect(alert).toHaveText(PAUSED)
  expect(before()).toBe(n)
  await page.reload()
  await page.getByRole('button', { name: /Dedi Manajer/ }).click()
  await expect(page.locator('.signin-pin')).toContainText(PAUSED)
  expect(before()).toBe(n)
  // Only the manager is paused: the cashier's pad still works, and with the internet down the right PIN is reported as
  // an outage, which counts for nothing against her.
  await page.getByRole('button', { name: /Bukan Anda/ }).click()
  await page.getByRole('button', { name: /Budi Kasir/ }).click()
  stack.offline(true)
  await tapPin(page, cashier.password)
  await expect(alert).toHaveText('Server tidak terjangkau. Periksa internet, lalu coba lagi.', tick)
  stack.offline(false)
  await tapPin(page, cashier.password)
  await expect(page.locator('#main')).toBeVisible(tick)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('takar-pin-tries') || '{}'))).toEqual({ [manager.id]: { n: 3, at: expect.any(Number) } })
})

test('AUTH-02, SYNC-07, SEC-4: a manager signed in by e-mail unlocks offline with the PIN, three wrong ones pause the lock, and a lock without a hash reports the outage', async ({ page, context, stack }) => {
  const { owner, manager } = stack.users
  const till = await useDevice(context)
  await stack.rpc(owner, 'enroll_device', { device_id: till, mode: 'pos' })
  await signIn(page, manager)
  expect(await page.evaluate(() => Boolean(localStorage.getItem('takar-pin-hash')))).toBe(true)
  stack.offline(true)
  // The manager's view has no rail button: the idle lock is what locks it (its flag survives a reload).
  const lockNow = async () => { await page.evaluate(id => localStorage.setItem('takar-locked', id), manager.id); await page.reload() }
  await lockNow()
  const lock = page.getByRole('dialog', { name: 'Layar terkunci' })
  await expect(lock).toBeVisible()
  await expect(lock).toContainText('masukkan PIN untuk lanjut')
  for (const guess of ['111222', '333444']) { await tapPin(lock, guess); await expect(lock.getByRole('alert')).toHaveText('PIN salah') }
  await tapPin(lock, '555666')
  await expect(lock.getByRole('alert')).toHaveText(PAUSED)
  await tapPin(lock, manager.password)
  await expect(lock.getByRole('alert')).toHaveText(PAUSED)
  await expect(lock).toBeVisible()
  await page.reload()
  await expect(lock).toBeVisible()
  await tapPin(lock, manager.password)
  await expect(lock.getByRole('alert')).toHaveText(PAUSED)
  // The pause over (storage cleared as time would), the right PIN opens the till with the internet still down.
  await page.evaluate(() => localStorage.removeItem('takar-pin-tries'))
  await tapPin(lock, manager.password)
  await expect(lock).toBeHidden()
  expect(stack.calls('auth:password').length).toBe(1) // the sign-in only: every PIN was checked on the device
  // A session from before this build kept no hash: the lock asks the server, and an outage is named, not called wrong.
  await page.evaluate(() => localStorage.removeItem('takar-pin-hash'))
  await lockNow()
  await lock.getByLabel('PIN atau kata sandi').fill(manager.password)
  await lock.getByRole('button', { name: 'Buka' }).click()
  await expect(lock.getByRole('alert')).toHaveText('Server tidak terjangkau. Periksa internet, lalu coba lagi.', tick)
  stack.offline(false)
  await lock.getByLabel('PIN atau kata sandi').fill(manager.password)
  await lock.getByRole('button', { name: 'Buka' }).click()
  await expect(lock).toBeHidden(tick)
})

test('SEC-5, AUTH-10: signing out deletes that person\'s database on the till; the approval-PIN dialog states the server\'s rule', async ({ page, context, stack }) => {
  const { owner, manager } = stack.users
  const till = await useDevice(context)
  await stack.rpc(owner, 'enroll_device', { device_id: till, mode: 'pos' })
  await signIn(page, manager)
  await page.goto('/settings')
  await page.getByRole('button', { name: /PIN persetujuan/ }).first().click()
  await expect(page.getByRole('dialog', { name: 'PIN persetujuan' })).toContainText('tiga PIN salah dalam 5 menit menghentikan persetujuan untuk kasir itu sementara')
  await page.keyboard.press('Escape')
  const name = `meja-live-${stack.restaurantId}-${manager.id}-${till}`
  expect((await page.evaluate(async () => (await indexedDB.databases()).map(d => d.name)))).toContain(name)
  await signOut(page)
  await expect.poll(() => page.evaluate(async () => (await indexedDB.databases()).map(d => d.name)), tick).not.toContain(name)
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => ['meja-identity', 'takar-pin-hash', 'takar-locked'].includes(k)))).toEqual([])
})

test('SEC-7, AUTH-08, LB-03, AUTH-14: /admin takes the 6-digit PIN and offers a manager only what manage_staff allows', async ({ page, stack }) => {
  const { manager, owner, cashier } = stack.users
  await page.goto('/admin')
  await page.getByLabel('Email pemilik').fill(manager.email)
  await page.getByLabel('Kata sandi').fill(manager.password) // the 6-digit PIN
  await page.getByRole('button', { name: /Masuk sebagai pemilik/ }).click()
  await expect(page.getByRole('heading', { name: 'Akun staf' })).toBeVisible(tick)
  const row = (who: { name: string }) => page.locator('.staff-row').filter({ hasText: who.name })
  await expect(row(owner).getByRole('button', { name: /Nonaktifkan/ })).toHaveCount(0)
  await expect(row(owner).getByText('Hanya pemilik')).toBeVisible()
  await expect(row(owner).getByRole('combobox', { name: `Peran ${owner.name}` })).toBeDisabled()
  await row(cashier).getByRole('combobox', { name: `Peran ${cashier.name}` }).click()
  const options = page.getByRole('listbox', { name: `Peran ${cashier.name}` }).getByRole('option')
  await expect(options).toHaveCount(7)
  await expect(options.filter({ hasText: 'Pemilik' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(row(cashier).getByRole('button', { name: 'Nonaktifkan' })).toBeEnabled()
  // A wrong password is said in Indonesian.
  await page.getByRole('button', { name: /Keluar/ }).click()
  await page.getByLabel('Email pemilik').fill(manager.email)
  await page.getByLabel('Kata sandi').fill('000000')
  await page.getByRole('button', { name: /Masuk sebagai pemilik/ }).click()
  await expect(page.getByRole('alert')).toHaveText('Email atau kata sandi salah, atau akun tidak aktif', tick)
})

test('AUTH-12: a chef\'s and an admin\'s menus list only pages they can open; Hari ini is for owner and manager', async ({ page, stack }) => {
  const { chef, admin } = stack.users
  await signIn(page, chef)
  await expect(page).toHaveURL(/\/menu$/)
  const nav = page.locator('aside nav')
  await expect(nav.getByText('Menu & resep')).toBeVisible()
  for (const label of ['Hari ini', 'Laporan', 'Penjualan', 'Pembelian', 'Katering', 'Transfer']) await expect(nav.getByText(label, { exact: true })).toHaveCount(0)
  await page.goto('/today')
  await expect(page).toHaveURL(/\/menu$/)
  const laptop = await stack.newPage()
  await signIn(laptop, admin)
  const nav2 = laptop.locator('aside nav')
  await expect(nav2.getByText('Pembelian', { exact: true })).toBeVisible()
  for (const label of ['Hari ini', 'Laporan', 'Penjualan']) await expect(nav2.getByText(label, { exact: true })).toHaveCount(0)
})

test('AUTH-13: a member of another restaurant signing in on the till does not replace its staff picker or store name', async ({ page, context, stack }) => {
  const { owner, cashier } = stack.users
  const till = await useDevice(context)
  await stack.rpc(owner, 'enroll_device', { device_id: till, mode: 'pos' })
  await signIn(page, owner)
  await signOut(page)
  await expect(page.getByRole('button', { name: new RegExp(cashier.name) })).toBeVisible()
  const dago = await stack.seed({ name: 'Cabang Dago', people: { manager: { name: 'Rina Dago' }, cashier: { name: 'Toni Dago' } } })
  await signIn(page, dago.users.manager)
  await signOut(page)
  await expect(page.getByRole('button', { name: new RegExp(cashier.name) })).toBeVisible()
  await expect(page.getByRole('button', { name: new RegExp(dago.users.cashier.name) })).toHaveCount(0)
  await expect(page.locator('.signin-top')).toContainText('Ziggy Lounge')
  await expect(page.locator('.signin-top')).not.toContainText('Cabang Dago')
})
