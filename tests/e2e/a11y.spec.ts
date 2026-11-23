import { pbkdf2Sync } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { test, expect, demo, go, openShift, addItem, cart, manualDiscount } from './meja'

// CTL-4 on a staff till (not the demo, which never locks): a cashier on the primary device, PIN 123456 kept as
// the hash sign-in leaves (Login.tsx pinHash: PBKDF2-SHA256, 200,000 rounds, salted with the user id).
const cashier = { id: 'a11y-cashier', name: 'Rina Kasir', role: 'cashier', restaurantId: 'a11y-resto', deviceId: 'a11y-till', primary: true, demo: false, mode: 'pos' }
async function staffTill(page: Page) {
  await page.route(/127\.0\.0\.1:54321/, route => route.abort()) // no server: the till runs offline
  await page.goto('/')
  const hash = pbkdf2Sync('123456', `takar:${cashier.id}`, 200000, 32, 'sha256').toString('hex')
  await page.evaluate(([me, hash]) => { localStorage.setItem('meja-identity', me); localStorage.setItem('takar-pin-hash', hash) }, [JSON.stringify(cashier), hash])
  await page.goto('/pos')
  await expect(page.getByRole('heading', { name: 'Kasir', level: 1 })).toBeVisible()
}
const inLock = (page: Page) => page.evaluate(() => Boolean(document.activeElement?.closest('.lock-screen')))

test('the lock comes up over an open dialog and takes the PIN; the dialog is still there afterwards', async ({ page }) => {
  await staffTill(page)
  await cart(page).getByRole('button', { name: 'Diskon', exact: true }).click()
  const discount = page.getByRole('dialog', { name: 'Diskon' })
  await expect(discount).toBeVisible()
  // The idle timer fires while the dialog is open; the rail's lock button runs the same setLocked(true).
  await page.locator('.rail-lock').dispatchEvent('click')
  const lock = page.getByRole('dialog', { name: 'Layar terkunci' })
  await expect(lock).toBeVisible()
  await expect(lock.getByLabel('PIN', { exact: true })).toBeFocused()
  for (const d of '123456') await lock.getByRole('button', { name: `Angka ${d}` }).click()
  await expect(lock).toBeHidden()
  await expect(discount).toBeVisible()
  await discount.getByRole('button', { name: 'Tutup' }).click()
  await expect(discount).toBeHidden()
})

test('behind the lock the till takes no keys and is hidden from screen readers', async ({ page }) => {
  await staffTill(page)
  await page.getByRole('button', { name: 'Kunci layar sekarang' }).click()
  const lock = page.getByRole('dialog', { name: 'Layar terkunci' })
  await expect(lock).toBeVisible()
  await expect(page.getByRole('link', { name: 'Pesanan' })).toHaveCount(0)
  for (let i = 0; i < 16; i++) { await page.keyboard.press('Tab'); expect(await inLock(page)).toBe(true) }
  await lock.getByLabel('PIN', { exact: true }).fill('123456')
  await expect(lock).toBeHidden()
  // Unlocked, the till takes taps again: the lock handed body its pointer events back.
  await page.getByRole('link', { name: 'Pesanan' }).click()
  await expect(page).toHaveURL(/\/orders/)
})

test('closing a dialog puts focus back on the button that opened it', async ({ page }) => {
  await demo(page)
  await addItem(page, 'Es teh manis')
  const opener = cart(page).getByRole('button', { name: 'Diskon', exact: true })
  await opener.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Diskon' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(opener).toBeFocused()
})

test("the manager's approval over the discount dialog reads out its own request", async ({ page }) => {
  await page.goto('/')
  await page.getByRole('combobox', { name: 'Coba sebagai' }).click()
  await page.getByRole('option', { name: 'Kasir' }).click()
  await page.getByRole('button', { name: 'Jelajahi demo lokal' }).click()
  await go(page, 'Kasir')
  await openShift(page)
  await addItem(page, 'Es teh manis')
  await manualDiscount(page, '1000', 'Langganan')
  // Both dialogs are open; the approval must not point at the discount dialog's description.
  await expect(page.getByRole('dialog', { name: 'Persetujuan manajer' })).toHaveAccessibleDescription(/^Kasir Demo meminta: Diskon Rp1\.000/)
})

// WCAG 1.4.3: secondary text on tinted surfaces, the change chip, the Rp prefix, the receipt id and the teal
// call-to-action card all need 4.5:1. axe lists every text node that falls short.
test('text keeps 4.5:1 contrast at the till, in the payment dialog, on the receipt and on Stok', async ({ page }) => {
  const shortfalls = async () => (await new AxeBuilder({ page }).withRules(['color-contrast']).analyze()).violations.flatMap(v => v.nodes.map(n => n.target.join(' ')))
  await demo(page)
  await openShift(page)
  await addItem(page, 'Es teh manis')
  await cart(page).getByRole('button', { name: 'Diskon', exact: true }).click()
  const discount = page.getByRole('dialog', { name: 'Diskon' })
  await expect(discount).toBeVisible()
  expect(await shortfalls()).toEqual([])
  // The manual rupiah amount puts the Rp prefix on screen.
  await discount.getByRole('button', { name: 'Manual' }).click()
  await discount.getByRole('button', { name: /^Rupiah/ }).click()
  await expect(discount.locator('.money-prefix')).toBeVisible()
  expect(await shortfalls()).toEqual([])
  await page.keyboard.press('Escape')
  await cart(page).getByRole('button', { name: /Ke stasiun/ }).click()
  await cart(page).getByRole('button', { name: /^Bayar Rp/ }).click()
  const pay = page.getByRole('dialog', { name: 'Terima pembayaran' })
  await pay.getByLabel(/Uang diterima/).fill('100000')
  await expect(pay.getByText('Kembalian')).toBeVisible()
  expect(await shortfalls()).toEqual([])
  await pay.getByRole('button', { name: /Catat pembayaran/ }).click()
  await expect(page.getByRole('dialog', { name: 'Pembayaran tercatat' })).toBeVisible()
  expect(await shortfalls()).toEqual([])
  await page.keyboard.press('Escape')
  await go(page, 'Stok')
  await expect(page.locator('.cta-card')).toBeVisible()
  expect(await shortfalls()).toEqual([])
})

test('the shared tablet lists staff as buttons, and the hidden PIN field shows its focus on the dots', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.setItem('takar-team', JSON.stringify([{ id: 'a11y-1', name: 'Rina Kasir', role: 'cashier', login: 'rina@example.com' }, { id: 'a11y-2', name: 'Budi Manajer', role: 'manager', login: 'budi@example.com' }])))
  await page.reload()
  await page.getByRole('button', { name: /Rina Kasir/ }).click()
  await expect(page.getByLabel('Masukkan PIN', { exact: true })).toBeFocused()
  await expect(page.locator('.pin-dots')).toHaveCSS('outline-style', 'solid')
})
