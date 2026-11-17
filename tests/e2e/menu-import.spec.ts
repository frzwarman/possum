import { readFileSync } from 'node:fs'
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
  const dialog = page.getByRole('region', { name: 'Edit menu' })
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

test('a bahan CSV picked while "Menu" is selected is read as bahan, with its opening stock', async ({ page }) => {
  await demo(page)
  await go(page, 'Lainnya')
  await page.getByRole('button', { name: 'Impor CSV' }).click()
  await page.locator('.upload-label input[type=file]').setInputFiles({ name: 'bahan.csv', mimeType: 'text/csv', buffer: Buffer.from('name,unit,quantity,threshold,area,pack_name,pack_qty\nSirup hazelnut,ml,1500,750,Bar,botol,750\nRoti burger,pcs,0,12,Kulkas dapur,pak,6\n') })
  await expect(page.getByRole('combobox', { name: /Jenis data/ })).toContainText('Bahan & saldo awal')
  await expect(page.getByText('2 baris diperiksa')).toBeVisible()
  await page.getByRole('button', { name: 'Konfirmasi impor 2 baris' }).click()
  await page.goto('/inventory')
  await expect(page.locator('main').getByText('Sirup hazelnut').first()).toBeVisible()
})

// docs/samples/sheet-import: Ziggy's own tabs (MARKET LIST BAR, COGS BEVERAGE) downloaded as CSV, imported as they are.
test("the owner's market list becomes bahan and a COGS tab becomes menus with recipes", async ({ page }) => {
  await demo(page)
  await go(page, 'Lainnya')
  await page.getByRole('button', { name: 'Impor CSV' }).click()
  const file = page.locator('.upload-label input[type=file]')
  await file.setInputFiles('docs/samples/sheet-import/market-list-bar.csv')
  await expect(page.getByText('10 baris diperiksa')).toBeVisible()
  await expect(page.getByText(/Satuan ditebak/)).toBeVisible()
  // The guess reads HydroCoco as grams; it is coconut water, so the unit is changed before importing.
  const hydro = page.getByRole('group', { name: 'Satuan HydroCoco' })
  await expect(hydro.getByRole('button', { name: 'g', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await hydro.getByRole('button', { name: 'ml', exact: true }).click()
  await expect(hydro.getByRole('button', { name: 'ml', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Konfirmasi impor 10 baris' }).click()
  await expect(page.getByText(/Impor tersimpan/)).toBeVisible()

  // "Oat Milk" finds the demo's Susu oat by its nama lain; the five names that match no bahan are linked here once.
  await file.setInputFiles('docs/samples/sheet-import/cogs-beverage.csv')
  await expect(page.getByText('4 baris diperiksa')).toBeVisible()
  await expect(page.getByText(/Tanpa harga jual, dilewati: Cold Brew Bottle/)).toBeVisible()
  await expect(page.getByText('5 nama bahan di resep belum ada di Stok')).toBeVisible()
  const link = (name: string) => page.getByRole('combobox', { name: new RegExp(`^${name} ·`) })
  await link('espresso blend').fill('Custome Blend Selective')
  await link('chocolate powder').fill('Chocolate')
  await link('milk').fill('Fresh Milk Diary 1L')
  await link('steam milk').fill('Fresh Milk Diary 1L')
  await link('gula aren').fill('Gula XYZ')
  await expect(page.getByText('Tidak ada di Stok: Gula XYZ. Pilih dari daftar atau kosongkan.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Konfirmasi impor 4 baris' })).toBeDisabled()
  await link('gula aren').fill('')
  await page.getByRole('button', { name: 'Konfirmasi impor 4 baris' }).click()
  await expect(page.getByText(/Impor tersimpan/)).toBeVisible()

  await page.getByRole('button', { name: 'Menu & resep' }).click()
  const row = (name: string) => page.locator('.admin-row').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name.replace(/[()]/g, '\\$&')}$`) }) })
  await expect(row('Americano')).toContainText('COFFEE')
  await expect(row('Americano')).not.toContainText('Belum ada resep')
  // Milk and Steam Milk both went to Fresh Milk: one recipe line of 112,5 + 20 ml.
  await row('Chocolate (Milkshake)').getByRole('button', { name: 'Edit' }).click()
  await expect(page.getByRole('region', { name: 'Edit menu' }).locator('tr').filter({ hasText: 'Fresh Milk Diary 1L' })).toContainText('132,5 ml')
  await page.getByRole('region', { name: 'Edit menu' }).getByRole('button', { name: 'Buang perubahan' }).click()

  // The links were saved as nama lain: picking the file again leaves only the name that was skipped.
  await page.getByRole('button', { name: 'Impor CSV' }).click()
  await file.setInputFiles('docs/samples/sheet-import/cogs-beverage.csv')
  await expect(page.getByText('1 nama bahan di resep belum ada di Stok')).toBeVisible()
  await expect(page.getByText(/Nama sudah ada: Americano, Vegan Latte/)).toBeVisible()
})

test('a CSV dropped on the import field is read like a picked one; another kind of file is turned away', async ({ page }) => {
  await demo(page)
  await go(page, 'Lainnya')
  await page.getByRole('button', { name: 'Impor CSV' }).click()
  const drop = async (name: string, type: string, text: string) => {
    const data = await page.evaluateHandle(([n, t, x]) => { const d = new DataTransfer(); d.items.add(new File([x], n, { type: t })); return d }, [name, type, text])
    await page.locator('.upload-label').dispatchEvent('dragover', { dataTransfer: data })
    await expect(page.locator('.upload-label')).toContainText('Lepas untuk membaca berkas')
    await page.locator('.upload-label').dispatchEvent('drop', { dataTransfer: data })
  }
  await drop('Ziggy.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'PK')
  await expect(page.getByText(/Pilih berkas CSV\. Di Google Sheets/)).toBeVisible()
  await drop('COGS Ziggy Lounge - MARKET LIST BAR.csv', 'text/csv', readFileSync('docs/samples/sheet-import/market-list-bar.csv', 'utf8'))
  await expect(page.getByText('10 baris diperiksa')).toBeVisible()
  await expect(page.locator('.upload-label')).toContainText('Pilih atau seret berkas CSV ke sini')
})
