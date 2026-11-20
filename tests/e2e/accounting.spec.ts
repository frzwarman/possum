import { test, expect, demo, openShift, addItem, cart, sell, go } from './meja'

test('Akuntansi turns a day of sales into statements, a cash book, a balanced journal and files to take away', async ({ page }) => {
  await demo(page)
  await openShift(page)
  await addItem(page, 'Es teh manis')
  await cart(page).getByRole('button', { name: 'Tambah Es teh manis' }).click()
  await sell(page)
  await page.keyboard.press('Escape')
  // Pilot rule: the back office opens on the till only once the shift is closed.
  await go(page, 'Sif')
  await page.getByRole('button', { name: 'Tutup sif' }).click()
  await page.getByRole('dialog', { name: 'Tutup sif' }).getByLabel(/Uang tunai yang dihitung/).fill('211000')
  await page.getByRole('dialog', { name: 'Tutup sif' }).getByRole('button', { name: 'Konfirmasi tutup sif' }).click()
  await go(page, 'Akuntansi')
  await expect(page.getByRole('heading', { name: 'Akuntansi', level: 1 })).toBeVisible()
  await expect(page.locator('.metric').filter({ hasText: 'Penjualan bersih' })).toContainText('Rp12.000')
  const table = page.locator('.books-table'), tab = (name: string) => page.getByRole('button', { name, exact: true }).click()
  const line = (text: string) => table.locator('tr').filter({ hasText: text })
  await expect(line('Penjualan bersih')).toContainText('Rp12.000')
  // The drawer counted Rp1.000 short: a loss in the statement and in the shift's row.
  await expect(line('Selisih kas')).toContainText('-Rp1.000')

  // Rent never passes the till: the cash book takes it, and the profit follows.
  await tab('Biaya & kas')
  await page.getByRole('button', { name: 'Catat biaya' }).click()
  const form = page.getByRole('dialog', { name: 'Catat biaya' })
  await form.getByLabel('Jumlah').fill('500000')
  await form.getByLabel('Catatan').fill('Sewa November')
  await form.getByRole('button', { name: 'Simpan catatan' }).click()
  await expect(line('Sewa November')).toContainText('Rp500.000')
  await tab('Laba rugi')
  await expect(line('Laba bersih')).toContainText('-Rp489.000')
  await expect(page.locator('.metric').filter({ hasText: 'Laba bersih' })).toContainText('-Rp489.000')

  // The balance sheet balances: the float came from outside the drawer, the rent left from there.
  await tab('Neraca')
  await expect(line('Kas laci kasir')).toContainText('Rp211.000')
  const assets = (await line('Jumlah aset').locator('td').last().textContent())!
  expect(assets).toMatch(/Rp/)
  await expect(line('Jumlah kewajiban & ekuitas').locator('td').last()).toHaveText(assets)

  await tab('Rekap harian')
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await expect(table.locator('tbody tr')).toContainText('Rp12.000')
  await tab('Per menu')
  await expect(table.locator('tbody tr').filter({ hasText: 'Es teh manis' })).toContainText('Rp12.000')
  await tab('Persediaan')
  await expect(table.locator('tbody tr').first()).toBeVisible()
  await tab('Sif & kas')
  await expect(table.locator('tbody tr')).toContainText('Pemilik Demo')
  await expect(table.locator('tbody tr')).toContainText('-Rp1.000')
  await tab('Buku besar')
  await expect(line('Saldo akhir').filter({ hasText: 'Kas laci kasir' })).toContainText('Rp211.000')
  await tab('Jurnal')
  await expect(table.locator('tbody tr').filter({ hasText: 'Kas laci kasir' }).filter({ hasText: 'Penjualan kasir' })).toContainText('Rp12.000')
  const sums = await table.locator('tfoot td.num').allTextContents()
  expect(sums.at(-1)).toMatch(/^Rp/)
  expect(sums.at(-1)).toBe(sums.at(-2))
  // The accounting team's own account code replaces the starting one, and stays after a reload.
  await page.getByRole('button', { name: 'Kode akun' }).click()
  const dialog = page.getByRole('dialog', { name: 'Kode akun' })
  await dialog.getByLabel('Kode Kas laci kasir').fill('111.01')
  await dialog.getByRole('button', { name: 'Simpan kode akun' }).click()
  await expect(table.locator('tbody tr').filter({ hasText: 'Kas laci kasir' }).first()).toContainText('111.01')

  // One tab as CSV, every tab in one Excel workbook, and the tab on paper.
  const csv = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV', exact: true }).click()
  expect((await csv).suggestedFilename()).toMatch(/^takar-jurnal-\d{4}-\d\d-\d\d-\d{4}-\d\d-\d\d\.csv$/)
  const excel = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Unduh Excel' }).click()
  const file = await excel
  expect(file.suggestedFilename()).toMatch(/^takar-akuntansi-\d{4}-\d\d-\d\d-\d{4}-\d\d-\d\d\.xlsx$/)
  await file.saveAs('test-results/akuntansi.xlsx')
  await page.context().addInitScript(() => { window.print = () => {} })
  const paper = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Cetak / PDF' }).click()
  const printed = await paper
  await expect(printed.locator('h1')).toContainText('Jurnal')
  await expect(printed.locator('tbody tr').first()).toContainText('111.01')
  await printed.close()

  // Taking the rent back out puts the profit back.
  await tab('Biaya & kas')
  await page.getByRole('button', { name: /^Hapus Sewa/ }).click()
  await page.getByRole('dialog', { name: 'Hapus catatan ini?' }).getByRole('button', { name: 'Hapus' }).click()
  await expect(page.getByText('Belum ada biaya yang dicatat di rentang ini.')).toBeVisible()
  await page.reload()
  await expect(line('Laba bersih')).toContainText('Rp11.000')
  await tab('Jurnal')
  await expect(table).toContainText('111.01')
})

test('an accountant lands on Akuntansi with the books, the cash book and the audit log, and nothing else', async ({ page }) => {
  await page.addInitScript((value) => localStorage.setItem('meja-identity', value as string), JSON.stringify({ id: 'demo-accountant', name: 'Akuntan Demo', role: 'accountant', restaurantId: 'local-demo', deviceId: '11111111-1111-1111-1111-111111111111', primary: false, demo: true }))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Akuntansi', level: 1 })).toBeVisible()
  const sidebar = page.locator('.sidebar')
  await expect(sidebar.getByRole('link', { name: 'Log audit' })).toBeVisible()
  await expect(sidebar.getByRole('link', { name: /Kasir|Stok|Menu|Laporan|Pesanan/ })).toHaveCount(0)
  // Nothing sold yet: the statement still stands, at zero.
  await expect(page.locator('.books-table tr').filter({ hasText: 'Penjualan bersih' })).toContainText('Rp0')
  await page.getByRole('button', { name: 'Biaya & kas', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Catat biaya' })).toBeVisible()
  await page.goto('/pos')
  await expect(page.getByRole('heading', { name: 'Akuntansi', level: 1 })).toBeVisible()
})
