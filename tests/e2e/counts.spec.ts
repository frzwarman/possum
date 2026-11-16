import { test, expect, demo, go, balance } from './meja'
// F6: count one area blind, review the gap in units and rupiah, approve it into stock.
test('a count short by 6% is flagged, needs a reason, and becomes the new stock once approved', async ({ page }) => {
  await demo(page)
  await go(page, 'Hitung stok')
  await page.getByRole('combobox', { name: /^Area simpan/ }).click()
  await page.getByRole('option', { name: 'Dry store' }).click()
  await page.getByRole('button', { name: 'Mulai menghitung' }).click()
  const counting = page.getByRole('region', { name: 'Hitung: Dry store' })
  await expect(counting).not.toContainText(/10\.000|10 kg/) // the system figure stays hidden while counting
  await counting.getByRole('button', { name: /^Beras/ }).click()
  await counting.getByLabel('Karung terbuka').fill('9400')
  await counting.getByRole('button', { name: 'Kirim untuk ditinjau' }).click()
  await page.getByRole('button', { name: 'Tinjau' }).click()
  const review = page.getByRole('region', { name: /^Dry store,/ })
  const row = review.locator('tr').filter({ hasText: 'Beras' })
  await expect(row).toContainText('10 kg')
  await expect(row).toContainText('−600') // a true minus sign, as on the Figma
  await review.getByRole('button', { name: 'Setujui hitungan' }).click()
  await expect(page.getByRole('alert')).toContainText('Isi alasan')
  await row.getByPlaceholder('Pilih alasan').fill('tumpah')
  await review.getByRole('button', { name: 'Setujui hitungan' }).click()
  await expect(page.getByText('Hitungan disetujui; stok mengikuti hasil hitung')).toBeVisible()
  await go(page, 'Stok')
  await expect(balance(page, 'Beras')).toHaveText('9.400')
  await page.getByRole('button', { name: 'Riwayat Beras' }).click()
  await expect(page.getByText('Hitung Dry store: tumpah')).toBeVisible() // the ingredient's history (dialog or detail page)
})
