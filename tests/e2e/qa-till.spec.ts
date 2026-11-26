// QA 2026-11-25, cluster till, in demo mode: the pay sheet does not accept the tap that opened it (TILL-01), a cart tap during a
// send is not lost (STN-02), the pilot's Bayar does not send the lines until the cashier confirms (TILL-04), a free kitchen option
// stays on the line (STN-07), + stops at 999 (TILL-11), a 10,5% rate reads with a comma (TILL-15).
import type { Page } from '@playwright/test'
import { test, expect, demo, cart, openShift } from './meja'

const db = (page: Page, fn: string, arg?: unknown) => page.evaluate(async ({ fn, arg }) => {
  const name = (await indexedDB.databases()).map((d) => d.name!).find((n) => n.startsWith('meja-demo-'))!
  const d: IDBDatabase = await new Promise((ok, no) => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error) })
  try { return await (new Function('db', 'arg', 'return (' + fn + ')(db,arg)'))(d, arg) } finally { d.close() }
}, { fn, arg })
const rows = (page: Page, table: string) => db(page, `(d,t)=>new Promise((ok,no)=>{const r=d.transaction(t).objectStore(t).getAll();r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)})`, table) as Promise<any[]>
const put = (page: Page, table: string, items: unknown[]) => db(page, `(d,a)=>new Promise((ok,no)=>{const tx=d.transaction(a.t,'readwrite');for(const i of a.items)tx.objectStore(a.t).put(i);tx.oncomplete=()=>ok();tx.onerror=()=>no(tx.error)})`, { t: table, items })
// The demo with settings changed (a pilot store, a tax rate) and its shift open.
async function till(page: Page, patch: Record<string, unknown> = {}) {
  await demo(page)
  const [s] = await rows(page, 'settings')
  await put(page, 'settings', [{ ...s, stationTablets: false, ...patch }])
  await page.reload()
  await expect(page.locator('.menu-grid')).toBeVisible()
  await openShift(page)
}
const tea = (page: Page) => page.locator('.menu-card').filter({ has: page.getByRole('heading', { name: 'Es teh manis', exact: true }) })
const bayar = (page: Page) => cart(page).getByRole('button', { name: /^Bayar Rp/ })

test.describe('TILL-01', () => {
  test.use({ viewport: { width: 800, height: 1280 }, isMobile: true, hasTouch: true })
  test('the second tap of a double tap on Bayar does not pay or close the sheet', async ({ page }) => {
    await demo(page)
    const [s] = await rows(page, 'settings')
    await put(page, 'settings', [{ ...s, stationTablets: false }])
    await page.reload()
    const summary = page.locator('.mobile-cart-summary'), side = cart(page)
    if (!(await side.isVisible())) await summary.tap()
    await page.getByRole('button', { name: /Buka sif untuk melayani/ }).locator('visible=true').first().tap()
    await page.getByRole('button', { name: 'Buka sif sekarang' }).tap()
    await tea(page).tap()
    if (!(await side.isVisible())) await summary.tap()
    const pay = page.getByRole('button', { name: /^Bayar Rp/ }).locator('visible=true').first()
    await expect(pay).toBeEnabled()
    const box = (await pay.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2
    await pay.tap()
    const sheet = page.getByRole('dialog', { name: 'Terima pembayaran' })
    await expect(sheet).toBeVisible()
    await page.touchscreen.tap(x, y) // the second tap of the double tap, on whatever sits under the finger now
    await page.waitForTimeout(300)
    await expect(sheet).toBeVisible()
    expect((await rows(page, 'orders'))[0].status).toBe('open')
    // A real confirmation, after the sheet has been up a moment, still pays.
    await page.waitForTimeout(500)
    await sheet.getByRole('button', { name: /Catat pembayaran/ }).tap()
    await expect(page.getByRole('dialog', { name: 'Pembayaran tercatat' })).toBeVisible()
    expect((await rows(page, 'orders'))[0].status).toBe('paid')
  })
})

test('STN-02: a menu tap while the cart is being saved stays in the cart', async ({ page }) => {
  await till(page)
  await tea(page).click()
  await cart(page).getByRole('button', { name: 'Opsi pesanan' }).click()
  // Save and, in the same moment, tap another item: the save finishes after the tap and must not write the old cart back over it.
  await page.evaluate(() => {
    const save = [...document.querySelectorAll('.desktop-cart .cart-menu button')].find((b) => /Simpan pesanan/.test(b.textContent ?? '')) as HTMLElement
    const card = [...document.querySelectorAll('.menu-card')].find((c) => /Es jeruk/.test(c.textContent ?? '')) as HTMLElement
    save.click(); card.click()
  })
  await expect(cart(page).locator('.cart-line')).toHaveCount(2)
  await page.waitForTimeout(500)
  await expect(cart(page).locator('.cart-line')).toHaveCount(2)
  expect((await rows(page, 'orders')).length).toBe(1)
})

test('TILL-04: in the pilot Bayar sends nothing until the payment is confirmed; closing the sheet leaves the cart editable', async ({ page }) => {
  await till(page)
  await tea(page).click()
  await bayar(page).click()
  await expect(page.getByRole('dialog', { name: 'Terima pembayaran' })).toBeVisible()
  await page.waitForTimeout(700)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Terima pembayaran' })).toBeHidden()
  const [o] = await rows(page, 'orders')
  expect(o.lines.every((l: any) => !l.prepared)).toBe(true)
  expect((await rows(page, 'movements')).filter((m: any) => m.kind === 'preparation')).toHaveLength(0)
  await expect(cart(page).getByRole('button', { name: /^Tambah Es teh manis/ })).toBeVisible()
  await bayar(page).click()
  await page.waitForTimeout(700)
  await page.getByRole('dialog', { name: 'Terima pembayaran' }).getByRole('button', { name: /Catat pembayaran/ }).click()
  await expect(page.getByRole('dialog', { name: 'Pembayaran tercatat' })).toBeVisible()
  const [paid] = await rows(page, 'orders')
  expect([paid.status, paid.lines.every((l: any) => l.prepared)]).toEqual(['paid', true])
  expect((await rows(page, 'movements')).filter((m: any) => m.kind === 'preparation').length).toBeGreaterThan(0)
})

test('STN-07: a free option that changes no recipe ("Tidak pedas") stays on the line', async ({ page }) => {
  await till(page)
  const menu = await rows(page, 'menu')
  await put(page, 'menu', menu.map((m: any) => (m.id === 'es-teh' ? { ...m, modifiers: [{ id: 'tidak-pedas', name: 'Tidak pedas', price: 0, recipe: [] }] } : m)))
  await page.reload()
  await tea(page).click()
  const dialog = page.getByRole('dialog', { name: 'Es teh manis' })
  await dialog.getByText('Tidak pedas').click()
  await dialog.getByRole('button', { name: /Tambah ke pesanan/ }).click()
  await expect(cart(page).locator('.line-options')).toHaveText('Tidak pedas')
  await bayar(page).click()
  await page.waitForTimeout(700)
  await page.getByRole('dialog', { name: 'Terima pembayaran' }).getByRole('button', { name: /Catat pembayaran/ }).click()
  await expect(page.locator('.receipt-name small').first()).toHaveText('Tidak pedas')
  expect((await rows(page, 'orders'))[0].lines[0].modifiers.map((m: any) => m.name)).toEqual(['Tidak pedas'])
})

test('TILL-11: + stops at 999', async ({ page }) => {
  await till(page)
  await tea(page).click()
  const [d] = await rows(page, 'drafts')
  await put(page, 'drafts', [{ ...d, lines: d.lines.map((l: any) => ({ ...l, qty: 999 })) }])
  await page.reload()
  await expect(cart(page).locator('.quantity-control span')).toHaveText('999')
  await expect(cart(page).getByRole('button', { name: 'Tambah Es teh manis' })).toBeDisabled()
})

test('TILL-15: a 10,5% tax reads with the decimal comma in the cart', async ({ page }) => {
  await till(page, { taxBps: 1050 })
  await tea(page).click()
  await expect(cart(page).locator('.bill-row').filter({ hasText: 'Pajak' })).toContainText('10,5%')
})
