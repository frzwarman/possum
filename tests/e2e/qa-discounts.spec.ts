// QA 2026-11-25, cluster discounts, on the demo till: a manual discount follows the cart by its rule (TILL-02), the
// manager's approval covers it up to the approved amount and the till asks again past it (DSC-2, TILL-05), a reopened
// compliment switched to dine-in carries no discount (TILL-06), and Diskon's Aktif tab lists what runs today (DSC-5).
import type { Page } from '@playwright/test'
import { test, expect, demo, cart, openShift, addItem } from './meja'

const VIP = { id: 'vip', name: 'Tamu VIP', note: '', kind: 'percent', value: 20, scope: 'order', from: '2026-01-01', to: '2099-12-31', approval: true }
const day = () => new Date(Date.now() + 7 * 3600e3 - 4 * 3600e3).toISOString().slice(0, 10)

// The demo keeps one IndexedDB per role; settings are patched the way pull() writes them.
async function withDb<T>(page: Page, fn: string, arg: unknown): Promise<T> {
  return page.evaluate(async ({ fn, arg }) => {
    const name = (await indexedDB.databases()).map((d) => d.name!).find((n) => n.startsWith('meja-demo-'))!
    const db: IDBDatabase = await new Promise((ok, no) => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error) })
    try { return await (new Function('db', 'arg', 'return (' + fn + ')(db,arg)'))(db, arg) } finally { db.close() }
  }, { fn, arg }) as Promise<T>
}
const rows = <T = any>(page: Page, table: string) => withDb<T[]>(page, `(db,t)=>new Promise((ok,no)=>{const r=db.transaction(t).objectStore(t).getAll();r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)})`, table)
const put = (page: Page, table: string, items: unknown[]) => withDb<void>(page, `(db,a)=>new Promise((ok,no)=>{const tx=db.transaction(a.t,'readwrite');for(const i of a.items)tx.objectStore(a.t).put(i);tx.oncomplete=()=>ok();tx.onerror=()=>no(tx.error)})`, { t: table, items })
async function settings(page: Page, patch: Record<string, unknown>) {
  const [s] = await rows(page, 'settings')
  await put(page, 'settings', [{ ...s, ...patch }])
  await page.reload()
  await expect(page.locator('.menu-grid, .page-content').first()).toBeVisible()
}
async function cashier(page: Page, patch: Record<string, unknown> = {}) {
  await page.goto('/')
  await page.getByRole('combobox', { name: 'Coba sebagai' }).click()
  await page.getByRole('option', { name: 'Kasir', exact: true }).click()
  await page.getByRole('button', { name: 'Jelajahi demo lokal' }).click()
  await expect(page.getByRole('button', { name: 'Buka sif sekarang' })).toBeVisible()
  await settings(page, { stationTablets: false, ...patch })
  await page.getByRole('button', { name: 'Buka sif sekarang' }).click()
  await expect(page.locator('.menu-grid')).toBeVisible()
}
async function owner(page: Page) {
  await demo(page)
  await settings(page, { stationTablets: false })
  await openShift(page)
}
// Items with an option sheet need a tap more; the cart must have taken the line before the next tap.
const SHEET = ['Nasi goreng kampung', 'Ayam bakar', 'Ayam penyet sambal ijo', 'Mie goreng Jawa', 'Ice Matcha Latte', 'Ziggy Fried Rice']
async function add(page: Page, name: string, times = 1) {
  for (let i = 0; i < times; i++) {
    const before = await cart(page).locator('.cart-line').count()
    await page.locator('.menu-card').filter({ has: page.getByRole('heading', { name, exact: true }) }).first().click()
    if (SHEET.includes(name)) { const sheet = page.getByRole('dialog', { name }); await sheet.getByRole('button', { name: /Tambah ke pesanan/ }).click(); await expect(sheet).toBeHidden() }
    await expect.poll(async () => (await cart(page).locator('.cart-line').count()) > before || (await cart(page).getByText(name).count()) > 0).toBe(true)
  }
}
async function removeAll(page: Page, name: string) {
  const btn = cart(page).getByRole('button', { name: new RegExp(`^(Kurangi|Hapus) ${name}$`) })
  while (await btn.count()) await btn.first().click()
}
const pinDialog = (page: Page) => page.getByRole('dialog', { name: 'Perlu persetujuan manajer' })
async function approve(page: Page) {
  const d = pinDialog(page)
  await expect(d).toBeVisible()
  await d.getByRole('combobox', { name: 'Disetujui oleh' }).click()
  await page.getByRole('option', { name: 'Manajer Demo' }).click()
  await d.getByLabel('PIN persetujuan').fill('123456')
  await d.getByRole('button', { name: /^Setujui/ }).click()
  await expect(d).toBeHidden()
}
const bill = (page: Page, label: string) => cart(page).locator('.bill-row').filter({ hasText: label })
async function manualPercent(page: Page, { percent, scope }: { percent?: string; scope?: string } = {}) {
  await cart(page).getByRole('button', { name: 'Diskon', exact: true }).click()
  const d = page.getByRole('dialog', { name: 'Diskon' })
  await d.getByRole('button', { name: 'Manual' }).click()
  if (percent) await d.getByLabel('Diskon (%)').fill(percent)
  if (scope) await d.getByRole('button', { name: scope, exact: true }).click()
  await d.getByRole('button', { name: /^(Terapkan diskon|Minta persetujuan manajer)$/ }).click()
}
async function payCash(page: Page) {
  await cart(page).getByRole('button', { name: /^Bayar Rp/ }).click()
  const pay = page.getByRole('dialog', { name: 'Terima pembayaran' })
  await expect(pay).toBeVisible()
  await pay.getByRole('button', { name: /Catat pembayaran/ }).click()
  await expect(page.getByRole('dialog', { name: 'Pembayaran tercatat' })).toBeVisible()
}
async function menuButton(page: Page, label: string) {
  await cart(page).getByRole('button', { name: 'Opsi pesanan' }).click()
  await cart(page).getByRole('button', { name: label }).click()
}

test('TILL-02: a manager approves 10% on 234.000; lines come off; the order is charged 10% of what is left', async ({ page }) => {
  await cashier(page)
  await add(page, 'Ziggy Fried Rice')
  await add(page, 'Iced Americano', 4)
  await add(page, 'Hot Americano', 3)
  await add(page, 'Es jeruk peras', 3)
  await expect(bill(page, 'Subtotal')).toContainText('Rp234.000')
  await manualPercent(page)
  await expect(pinDialog(page)).toContainText('Diskon Rp23.400')
  await approve(page)
  await expect(bill(page, 'Diskon')).toContainText('Rp23.400')
  for (const n of ['Iced Americano', 'Hot Americano', 'Es jeruk peras']) await removeAll(page, n)
  await expect(bill(page, 'Diskon')).toContainText('Rp3.800')
  await expect(pinDialog(page)).toBeHidden()
  await payCash(page)
  const [o] = await rows(page, 'orders')
  expect([o.totals.subtotal, o.totals.discount, o.discountApprovedBy, o.discountRule]).toEqual([38000, 3800, 'Manajer Demo', { kind: 'percent', value: 10, scope: 'order' }])
})

test('TILL-02: a 50% drinks-only discount is gone once the drink is; 10% follows the cart as it grows', async ({ page }) => {
  await owner(page)
  await add(page, 'Nasi goreng kampung')
  await add(page, 'Es teh manis')
  await manualPercent(page, { percent: '50', scope: 'Minuman' })
  await expect(bill(page, 'Diskon')).toContainText('Rp3.000')
  await removeAll(page, 'Es teh manis')
  await expect(bill(page, 'Diskon')).toHaveCount(0)
  await manualPercent(page)
  await expect(bill(page, 'Diskon')).toContainText('Rp2.500')
  await add(page, 'Ziggy Fried Rice')
  await expect(bill(page, 'Diskon')).toContainText('Rp6.300')
})

test('TILL-05, DSC-2: a saved discount approved with a PIN follows the cart, and asks again only above the approved amount', async ({ page }) => {
  await cashier(page, { discounts: [VIP] })
  await add(page, 'Nasi goreng kampung')
  await add(page, 'Es teh manis')
  await cart(page).getByRole('button', { name: 'Diskon', exact: true }).click()
  await page.getByRole('dialog', { name: 'Diskon' }).locator('.discount-card').filter({ hasText: 'Tamu VIP' }).click()
  await approve(page) // Rp6.200 on 31.000
  await expect(bill(page, 'Tamu VIP')).toContainText('Rp6.200')
  // Less: covered. More: the PIN dialog opens by itself, and paying works once the manager approved.
  await removeAll(page, 'Es teh manis')
  await expect(bill(page, 'Tamu VIP')).toContainText('Rp5.000')
  await expect(pinDialog(page)).toBeHidden()
  await add(page, 'Es teh manis')
  await expect(pinDialog(page)).toBeHidden()
  await add(page, 'Ziggy Fried Rice')
  await expect(pinDialog(page)).toContainText('Diskon Rp13.800')
  await approve(page)
  await payCash(page)
  const [o] = await rows(page, 'orders')
  expect([o.totals.discount, o.discountApprovedBy, o.discountApproved]).toEqual([13800, 'Manajer Demo', 13800])
})

for (const role of ['owner', 'cashier'] as const) test(`TILL-06 ${role}: a reopened staff meal switched to dine-in is priced in full, with no PIN`, async ({ page }) => {
  if (role === 'owner') await owner(page); else await cashier(page)
  await cart(page).getByRole('button', { name: 'Compliment', exact: true }).click()
  await cart(page).getByLabel('Nama penerima compliment').fill('Budi')
  await add(page, 'Nasi goreng kampung')
  await add(page, 'Es teh manis')
  await menuButton(page, 'Simpan pesanan')
  await expect(cart(page).getByText('Pesanan tersimpan')).toBeVisible()
  await menuButton(page, 'Mulai pesanan baru')
  await expect(cart(page).getByText('Pesanan baru')).toBeVisible()
  await page.locator('.sidebar').getByRole('link', { name: /^Pesanan/ }).first().click()
  await page.locator('.order-row').filter({ hasText: 'Budi' }).first().click()
  await page.getByRole('button', { name: /Buka pesanan/ }).click()
  await expect(cart(page).getByText('Pesanan tersimpan')).toBeVisible()
  await cart(page).getByRole('button', { name: 'Makan di sini' }).click()
  await expect(bill(page, 'Diskon')).toHaveCount(0)
  await menuButton(page, 'Simpan pesanan')
  await expect(page.locator('.error-toast')).toHaveCount(0)
  await expect.poll(async () => (await rows(page, 'orders'))[0]?.mode).toBe('dinein')
  const [o] = await rows(page, 'orders')
  expect([o.totals.discount, o.discountReason, o.totals.total]).toEqual([0, '', o.totals.total])
  expect(o.totals.total).toBeGreaterThanOrEqual(31000)
})

test('DSC-5: the Aktif tab lists only discounts running today', async ({ page }) => {
  await demo(page)
  const tomorrow = new Date(Date.parse(day() + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10)
  await settings(page, { discounts: [
    { id: 'happy', name: 'Happy Hour', note: '', kind: 'percent', value: 20, scope: 'order', from: day(), to: day() },
    { id: 'besok', name: 'Promo Besok', note: '', kind: 'percent', value: 15, scope: 'order', from: tomorrow, to: tomorrow },
    { id: 'lama', name: 'Promo Lama', note: '', kind: 'percent', value: 15, scope: 'order', from: '2026-11-01', to: '2026-11-02' },
  ] })
  await page.goto('/discounts')
  await page.getByRole('button', { name: /^Aktif/ }).click()
  await expect(page.locator('.discounts-table tbody tr td:first-child strong')).toHaveText(['Happy Hour'])
  await expect(page.getByRole('button', { name: /^Aktif/ })).toContainText('1')
})
