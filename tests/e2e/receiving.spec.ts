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
