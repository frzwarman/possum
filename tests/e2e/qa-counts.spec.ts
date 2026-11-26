import type { Page } from '@playwright/test'
import { test, expect, demo, go, openShift, addItem, sell, balance } from './meja'
// QA 2026-11-25, cluster counts: the Hitung stok and Stok screens in demo mode (Commands run the same checks as live).
async function demoAs(page: Page, role: string) {
  await page.goto('/')
  await page.getByRole('combobox', { name: 'Coba sebagai' }).click()
  await page.getByRole('option', { name: role }).click()
  await page.getByRole('button', { name: 'Jelajahi demo lokal' }).click()
  await expect(page.locator('main')).toBeVisible()
}
async function countRice(page: Page, typed: string) {
  await go(page, 'Hitung stok')
  await page.getByRole('combobox', { name: /^Area simpan/ }).click()
  await page.getByRole('option', { name: 'Dry store' }).click()
  await page.getByRole('button', { name: 'Mulai menghitung' }).click()
  const counting = page.getByRole('region', { name: 'Hitung: Dry store' })
  await counting.getByRole('button', { name: /^Beras/ }).click()
  await counting.getByLabel('Karung terbuka').fill(typed)
  return counting
}

test('STN-01: a count taken before a sale is reviewed and approved against the stock at the count, so the sale stays', async ({ page }) => {
  await demo(page)
  const counting = await countRice(page, '10000') // exactly the books: 10 kg
  await counting.getByRole('button', { name: 'Kirim untuk ditinjau' }).click()
  await go(page, 'Kasir')
  await openShift(page)
  await addItem(page, 'Nasi goreng kampung') // 100 g of rice, after the count
  await sell(page)
  await page.keyboard.press('Escape')
  await go(page, 'Hitung stok')
  await page.getByRole('button', { name: 'Tinjau' }).click()
  const review = page.getByRole('region', { name: /^Dry store,/ })
  const row = review.locator('tr').filter({ hasText: 'Beras' })
  await expect(row).toContainText('Dalam 5%')
  await expect(row.locator('[data-label="Seharusnya"]')).toHaveText('10 kg')
  await expect(row.locator('[data-label="Selisih"]')).toHaveText('0 g')
  await review.getByRole('button', { name: 'Setujui hitungan' }).click()
  await expect(page.getByText('Hitungan disetujui; stok mengikuti hasil hitung')).toBeVisible()
  await go(page, 'Stok')
  await expect(balance(page, 'Beras')).toHaveText('9.900')
})

test('STOK-10: switching g to kg converts what was typed only when the count stays the same', async ({ page }) => {
  await demo(page)
  const counting = await countRice(page, '1234')
  await expect(counting.locator('.count-total')).toHaveText('= 1.234 g')
  await counting.getByRole('button', { name: /^Satuan g, ganti/ }).click()
  await expect(counting.getByLabel('Karung terbuka')).toHaveValue('1,234')
  await expect(counting.locator('.count-total')).toHaveText('= 1.234 g')
  await counting.getByRole('button', { name: /^Satuan kg, ganti/ }).click()
  await counting.getByLabel('Karung terbuka').fill('1234,5')
  await expect(counting.locator('.count-total')).toHaveText('= 1.234,5 g')
  await counting.getByRole('button', { name: /^Satuan g, ganti/ }).click()
  await expect(page.getByRole('alert')).toContainText('Ketik dalam g')
  await expect(counting.getByLabel('Karung terbuka')).toHaveValue('1234,5')
  await expect(counting.locator('.count-total')).toHaveText('= 1.234,5 g')
})

test('STK-14: a cashier\'s waste entry starts in the base unit, so 200 is 200 ml', async ({ page }) => {
  await demoAs(page, 'Kasir')
  await go(page, 'Stok')
  await page.locator('.stock-row').filter({ hasText: 'Susu segar' }).getByRole('button', { name: 'Catat stok' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('combobox', { name: 'Satuan' })).toHaveText('ml')
  await dialog.getByLabel(/^Jumlah/).fill('200')
  await expect(dialog.locator('p.small.muted').first()).toHaveText('= 200 ml')
  await dialog.getByRole('button', { name: 'Rusak' }).click()
  await dialog.getByRole('button', { name: 'Simpan pergerakan' }).click()
  await expect(dialog).toBeHidden()
  await expect(balance(page, 'Susu segar')).toHaveText('9.800')
})

test('STK-08: Admin stok is offered only the kinds the server lets an admin book', async ({ page }) => {
  await demoAs(page, 'Admin stok · bahan, hitung & persetujuan')
  await go(page, 'Stok')
  await page.locator('.stock-row').filter({ hasText: 'Garam' }).getByRole('button', { name: 'Catat stok' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox', { name: 'Jenis pencatatan' }).click()
  expect((await page.getByRole('option').allInnerTexts()).map((s) => s.trim())).toEqual(['Kiriman / pembelian', 'Terbuang / rusak'])
})
