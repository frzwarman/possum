import { test, expect, demo, go, openShift, addItem, sell } from './meja'
// The sample files in docs/samples/menu-import: import five TEST items, give one a photo, then remove them again.
// An item that was sold can only be switched off; the rest are removed for good.
const dir = 'docs/samples/menu-import'
test('a CSV import with photos can be removed again, except an item that was sold', async ({ page }) => {
  await demo(page)
  await go(page, 'Lainnya')
  await page.getByRole('button', { name: 'Impor CSV' }).click()
  await page.locator('.upload-label input[type=file]').setInputFiles(`${dir}/menu-import-test.csv`)
  await expect(page.getByText('5 baris diperiksa')).toBeVisible()
  await page.getByRole('button', { name: 'Konfirmasi impor 5 baris' }).click()
  await page.getByRole('button', { name: 'Menu & resep' }).click()
  const row = (name: string) => page.locator('.admin-row').filter({ hasText: name })
  await expect(page.locator('.admin-row').filter({ hasText: 'TEST ' })).toHaveCount(5)
  // A photo for one item, from the matching file.
  await row('TEST Matcha Latte Dingin').getByRole('button', { name: 'Edit' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit menu' })
  await dialog.locator('input[type=file]').setInputFiles(`${dir}/TEST Matcha Latte Dingin.jpg`)
  await expect(dialog.locator('img[alt="Pratinjau foto menu"]')).toHaveAttribute('src', /^data:image\/webp;base64,/)
  await dialog.getByRole('button', { name: 'Simpan versi menu' }).click()
  await expect(row('TEST Matcha Latte Dingin')).toContainText('Dengan foto')
  // Sell one TEST item: from now on it can only be switched off.
  await go(page, 'Kasir')
  await openShift(page)
  await addItem(page, 'TEST Kentang Truffle')
  await sell(page)
  await page.keyboard.press('Escape')
  await go(page, 'Sif')
  await page.getByRole('button', { name: 'Tutup sif' }).click()
  await page.getByRole('dialog', { name: 'Tutup sif' }).getByLabel(/Uang tunai yang dihitung/).fill('227000')
  await page.getByRole('dialog', { name: 'Tutup sif' }).getByRole('button', { name: 'Konfirmasi tutup sif' }).click()
  await go(page, 'Lainnya')
  await page.getByRole('button', { name: 'Menu & resep' }).click()
  await expect(row('TEST Kentang Truffle').getByRole('button', { name: 'Hapus TEST Kentang Truffle' })).toBeDisabled()
  for (const name of ['TEST Es Kopi Susu Aren', 'TEST Matcha Latte Dingin', 'TEST Nasi Ayam Sambal Matah', 'TEST Roti Bakar Cokelat Keju']) {
    await row(name).getByRole('button', { name: `Hapus ${name}` }).click()
    await page.getByRole('dialog', { name: `Hapus ${name}?` }).getByRole('button', { name: 'Hapus menu' }).click()
    await expect(row(name)).toHaveCount(0)
  }
  await expect(page.locator('.admin-row').filter({ hasText: 'TEST ' })).toHaveCount(1)
  // The same file is refused again while the sold item still exists (import only adds new names).
  await page.getByRole('button', { name: 'Impor CSV' }).click()
  await page.locator('.upload-label input[type=file]').setInputFiles(`${dir}/menu-import-test.csv`)
  await expect(page.getByText(/Nama sudah ada/)).toBeVisible()
})
