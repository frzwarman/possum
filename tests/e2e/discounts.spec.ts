import { test, expect, demo, go, openShift, addItem, cart } from './meja'

// Figma Manager 7 "Discounts" + Cashier 2 "Discount: one tap for a saved one": the manager saves Hari Guru (15% off
// drinks); at the till it goes on in one tap, without a PIN, and follows the drinks in the cart.
test('a saved discount is made under Diskon and goes on at the till in one tap, following the cart', async ({ page }) => {
  await demo(page)
  await go(page, 'Diskon')
  await page.getByRole('button', { name: 'Diskon baru' }).click()
  await page.getByLabel('Nama', { exact: true }).fill('Hari Guru')
  await page.getByLabel('Jumlah (%)').fill('15')
  await page.getByRole('button', { name: 'Satu jenis' }).click()
  await expect(page.getByRole('button', { name: 'Minuman' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Simpan diskon' }).click()
  await expect(page.getByText(/Hari Guru tersimpan/)).toBeVisible()
  const row = page.locator('.discounts-table tr').filter({ hasText: 'Hari Guru' })
  await expect(row).toContainText('15%')
  await expect(row).toContainText('Minuman')
  await expect(row).toContainText('Aktif')

  await go(page, 'Kasir')
  await openShift(page)
  await addItem(page, 'Es teh manis') // a drink, Rp6.000
  await addItem(page, 'Ziggy Fried Rice') // food: no discount
  await cart(page).getByRole('button', { name: 'Diskon', exact: true }).click()
  await page.getByRole('dialog', { name: 'Diskon' }).getByRole('button', { name: /Hari Guru/ }).click()
  await expect(page.getByRole('dialog', { name: 'Persetujuan manajer' })).toHaveCount(0)
  await expect(cart(page)).toContainText(/Diskon · Hari Guru\s*−Rp\s*900/)
  await addItem(page, 'Es teh manis')
  await expect(cart(page)).toContainText(/Diskon · Hari Guru\s*−Rp\s*1\.800/)
})
