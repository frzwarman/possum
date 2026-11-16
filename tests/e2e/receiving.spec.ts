import { test, expect, demo, go, balance } from './meja'
import type { Page } from '@playwright/test'
// F5: deliveries are typed in packs; a delivery far outside the usual size needs a second tap.
async function receive(page: Page, amount: string) {
  await page.locator('.stock-row').filter({ hasText: 'Susu segar' }).getByRole('button', { name: 'Catat stok' }).click()
  const dialog = page.getByRole('dialog', { name: 'Susu segar' })
  await expect(dialog.getByRole('combobox', { name: /^Satuan/ })).toContainText('karton')
  await dialog.getByLabel('Jumlah', { exact: true }).fill(amount)
  await dialog.getByLabel(/Pemasok/).fill('CV Susu Segar')
  await dialog.getByRole('button', { name: 'Simpan pergerakan' }).click()
  return dialog
}
test('a delivery in cartons enters stock in millilitres, and an outsized one asks twice', async ({ page }) => {
  await demo(page)
  await go(page, 'Stok')
  for (let i = 0; i < 3; i++) {
    await receive(page, '2')
    await expect(page.getByText('Pergerakan stok tersimpan')).toBeVisible()
    await page.keyboard.press('Escape')
  }
  await expect(balance(page, 'Susu segar')).toHaveText('82.000') // 10 L + 3 × 2 cartons of 12 L
  const dialog = await receive(page, '20')
  await expect(page.getByRole('alert')).toContainText('jauh di atas kiriman biasanya')
  await expect(dialog).toContainText('Lebih dari 5× kiriman biasanya')
  await dialog.getByRole('button', { name: 'Ya, jumlahnya benar' }).click()
  await expect(balance(page, 'Susu segar')).toHaveText('322.000')
})
test('a PO delivery is typed in cartons, and an outsized line holds the stock until it is checked', async ({ page }) => {
  await demo(page)
  await go(page, 'Stok')
  for (let i = 0; i < 3; i++) {
    await receive(page, '2')
    await expect(page.getByText('Pergerakan stok tersimpan')).toBeVisible()
    await page.keyboard.press('Escape')
  }
  await go(page, 'Pembelian')
  await page.getByRole('button', { name: 'Buat PO' }).click()
  const po = page.getByRole('dialog', { name: 'PO baru' })
  await po.getByLabel('Pemasok').fill('CV Susu Segar')
  await po.getByRole('combobox', { name: /^Bahan/ }).click()
  await page.getByRole('option', { name: 'Susu segar (ml)' }).click()
  await po.getByLabel('Jumlah').fill('24')
  await po.getByRole('combobox', { name: /^Satuan/ }).click()
  await page.getByRole('option', { name: 'liter (1.000 ml)' }).click()
  await po.getByLabel('Harga total baris').fill('504000')
  await po.getByRole('button', { name: 'Tambah ke PO' }).click()
  await po.getByRole('button', { name: 'Simpan PO' }).click()
  await page.locator('.order-card').filter({ hasText: 'CV Susu Segar' }).getByRole('button', { name: 'Terima kiriman' }).click()
  // Figma M5: 24 L is 2 cartons of 12 L, priced per carton; 20 cartons is 10× the usual 2 and must be checked first.
  const screen = page.getByRole('region', { name: /^Terima kiriman/ })
  const milk = screen.getByLabel('Susu segar (karton)')
  await expect(milk).toHaveValue('2')
  await expect(screen).toContainText('= 24.000 ml')
  await milk.fill('20')
  await expect(screen).toContainText('20 karton itu 10× kiriman biasa 2 karton')
  const confirm = screen.getByRole('button', { name: 'Konfirmasi dan masukkan ke stok' })
  await expect(confirm).toBeDisabled()
  await screen.getByRole('button', { name: 'Ubah ke 2 karton' }).click()
  await expect(screen.locator('tbody')).toContainText('Rp504.000')
  await confirm.click()
  await expect(page.getByText('Kiriman diterima dan masuk stok')).toBeVisible()
  await go(page, 'Stok')
  await expect(balance(page, 'Susu segar')).toHaveText('106.000') // 82 L + 2 cartons
})
