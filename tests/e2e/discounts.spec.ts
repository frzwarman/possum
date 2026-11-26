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
  // Saved, then reopened from Pesanan for the next round: the discount still follows the cart, not a frozen amount.
  await cart(page).getByRole('button', { name: 'Opsi pesanan' }).click()
  await cart(page).getByRole('button', { name: 'Simpan pesanan' }).click()
  await expect(cart(page).getByText('Pesanan tersimpan')).toBeVisible()
  await cart(page).getByRole('button', { name: 'Opsi pesanan' }).click()
  await cart(page).getByRole('button', { name: 'Mulai pesanan baru' }).click()
  await expect(cart(page).getByText('Pesanan baru')).toBeVisible()
  await go(page, 'Pesanan')
  await page.locator('.order-row').filter({ hasText: 'Belum dibayar' }).click()
  await page.locator('.order-detail').getByRole('button', { name: /Buka pesanan/ }).click()
  await expect(cart(page)).toContainText(/Diskon · Hari Guru\s*−Rp\s*1\.800/)
  await addItem(page, 'Es teh manis')
  await expect(cart(page)).toContainText(/Diskon · Hari Guru\s*−Rp\s*2\.700/)
  // Deleted under Diskon while the tab is open: the saved order keeps it until the cashier takes it off or picks another,
  // never dropped without the reason the server asks for when a saved order's discount changes.
  await cart(page).getByRole('button', { name: 'Opsi pesanan' }).click()
  await cart(page).getByRole('button', { name: 'Simpan pesanan' }).click()
  await expect(page.getByText('Pesanan tersimpan di perangkat')).toBeVisible()
  // The message of the first save may still be on screen: leave only once the cart is back in storage (a save drops it and writes it again).
  await expect.poll(() => page.evaluate(async () => {
    const name = (await indexedDB.databases()).find((d) => d.name?.startsWith('meja-'))?.name
    const db = await new Promise<IDBDatabase>((r) => { const q = indexedDB.open(name!); q.onsuccess = () => r(q.result) })
    const n = await new Promise<number>((r) => { const q = db.transaction('drafts').objectStore('drafts').count(); q.onsuccess = () => r(q.result) })
    db.close(); return n
  })).toBe(1)
  // As on the manager's laptop: a till with its shift open shows no back office in its menu.
  await page.goto('/discounts')
  await page.getByRole('button', { name: 'Aksi Hari Guru' }).click()
  // The row menu opens above the table's scroll box (a popover), so its last item is on screen and on top, not clipped.
  const remove = page.getByRole('button', { name: 'Hapus' })
  await expect(remove).toBeInViewport()
  expect(await remove.evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) })).toBe(true)
  await remove.click()
  await page.getByRole('dialog', { name: /Hapus Hari Guru/ }).getByRole('button', { name: 'Hapus' }).click()
  await expect(page.getByText('Hari Guru dihapus')).toBeVisible()
  await page.goto('/pos')
  await expect(cart(page)).toContainText(/Diskon · Hari Guru\s*−Rp\s*2\.700/)
  await addItem(page, 'Es teh manis')
  await expect(cart(page)).toContainText(/Diskon · Hari Guru\s*−Rp\s*2\.700/)
  await cart(page).getByRole('button', { name: 'Opsi pesanan' }).click()
  await cart(page).getByRole('button', { name: 'Simpan pesanan' }).click()
  await expect(page.getByText('Diskon tersimpan ini sudah dihapus. Pilih diskon lain.')).toBeVisible()
  await cart(page).getByRole('button', { name: 'Diskon', exact: true }).click()
  await page.getByRole('dialog', { name: 'Diskon' }).getByRole('button', { name: 'Lepas diskon Hari Guru' }).click()
  await expect(cart(page)).not.toContainText('Hari Guru')
  await cart(page).getByRole('button', { name: 'Opsi pesanan' }).click()
  await cart(page).getByRole('button', { name: 'Simpan pesanan' }).click()
  await expect(page.getByText('Pesanan tersimpan di perangkat')).toBeVisible()
})
