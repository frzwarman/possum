// QA 2026-11-25, cluster voids, on the demo till: after a line is voided in Pesanan the cart follows it (STN-04), and a
// cashier's line void asks the manager's PIN for that line (SEC-1: the approval is bound to the line and its value).
import type { Page } from '@playwright/test'
import { test, expect, demo, cart, openShift, addItem, go } from './meja'

async function withDb<T>(page: Page, fn: string, arg: unknown): Promise<T> {
  return page.evaluate(async ({ fn, arg }) => {
    const name = (await indexedDB.databases()).map((d) => d.name!).find((n) => n.startsWith('meja-demo-'))!
    const db: IDBDatabase = await new Promise((ok, no) => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error) })
    try { return await (new Function('db', 'arg', 'return (' + fn + ')(db,arg)'))(db, arg) } finally { db.close() }
  }, { fn, arg }) as Promise<T>
}
const rows = <T = any>(page: Page, table: string) => withDb<T[]>(page, `(db,t)=>new Promise((ok,no)=>{const r=db.transaction(t).objectStore(t).getAll();r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)})`, table)

// Nasi goreng and Es teh, sent to the station (stationTablets on in the demo), then Pesanan → Batalkan item → Es teh → reason.
async function sendAndStartVoid(page: Page) {
  await addItem(page, 'Nasi goreng kampung')
  await page.getByRole('button', { name: /Es teh manis/ }).click()
  await cart(page).getByRole('button', { name: /Ke stasiun/ }).click()
  await expect(cart(page).getByText(/Dikirim/)).toHaveCount(2)
  await go(page, 'Pesanan')
  const detail = page.locator('.order-detail')
  await detail.getByRole('button', { name: 'Batalkan item' }).first().click()
  await detail.locator('label.detail-line').filter({ hasText: 'Es teh manis' }).click()
  await detail.getByLabel('Alasan wajib').fill('Tamu tidak jadi')
  await detail.getByRole('button', { name: /Konfirmasi pembatalan item/ }).click()
  return detail
}
async function payFromCart(page: Page) {
  await go(page, 'Kasir')
  const bayar = cart(page).getByRole('button', { name: /^Bayar Rp/ })
  await expect(bayar).toHaveText('Bayar Rp25.000')
  await bayar.click()
  await expect(page.getByRole('dialog', { name: 'Terima pembayaran' })).toBeVisible()
}

test('STN-04: after a sent item is voided the cart bills what is left, and Bayar opens the payment', async ({ page }) => {
  await demo(page); await openShift(page)
  const detail = await sendAndStartVoid(page)
  await expect(detail.getByText(/Dibatalkan: Tamu tidak jadi/)).toBeVisible()
  await payFromCart(page)
  // A reload keeps what the cart shows.
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(cart(page).getByRole('button', { name: /^Bayar Rp/ })).toHaveText('Bayar Rp25.000')
})

test('SEC-1: a cashier voids a line with the manager\'s PIN, and the request is for that line and its value', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('combobox', { name: 'Coba sebagai' }).click()
  await page.getByRole('option', { name: 'Kasir', exact: true }).click()
  await page.getByRole('button', { name: 'Jelajahi demo lokal' }).click()
  await page.getByRole('button', { name: 'Buka sif sekarang' }).click()
  await expect(page.locator('.menu-grid')).toBeVisible()
  await sendAndStartVoid(page)
  const d = page.getByRole('dialog', { name: 'Perlu persetujuan manajer' })
  await expect(d).toContainText('ingin membatalkan 1× Es teh manis')
  await d.getByRole('combobox', { name: 'Disetujui oleh' }).click()
  await page.getByRole('option', { name: 'Manajer Demo' }).click()
  await d.getByLabel('PIN persetujuan').fill('123456')
  await d.getByRole('button', { name: /^Setujui/ }).click()
  await expect(page.getByText(/Item dibatalkan/)).toBeVisible()
  const op = (await rows(page, 'outbox')).find((o) => o.kind === 'order.voidline')
  expect(op.payload).toMatchObject({ reason: 'Tamu tidak jadi' })
  expect(op.payload.approval).toBeTruthy()
  await payFromCart(page)
})
