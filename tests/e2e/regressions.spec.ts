import { test, expect, demo, openShift, addItem, cart, go } from './meja'
import type { Page } from '@playwright/test'
import { defaultSettings, sampleMenu, stock } from '../../src/domain/sample'

const discount = async (page: Page, amount: string) => {
  await cart(page).getByRole('button', { name: 'Tambah diskon' }).click()
  const dialog = page.getByRole('dialog', { name: 'Diskon manajer' })
  await dialog.getByLabel('Potongan').fill(amount)
  await dialog.getByLabel('Alasan').fill('Langganan')
  await dialog.getByRole('button', { name: 'Terapkan diskon' }).click()
}

test('a discount that no longer fits the cart is reported, not a crash that survives reloads', async ({ page }) => {
  await demo(page)
  await addItem(page, 'Es teh manis') // 6.000
  await addItem(page, 'Air mineral') // 5.000
  await discount(page, '8000')
  await cart(page).getByRole('button', { name: 'Hapus Es teh manis' }).click()
  await expect(cart(page).getByRole('alert')).toContainText('Diskon melebihi subtotal')
  await page.reload()
  await expect(cart(page).getByRole('alert')).toContainText('Diskon melebihi subtotal')
  await addItem(page, 'Es teh manis')
  await expect(cart(page).getByRole('alert')).toHaveCount(0)
  await expect(cart(page).locator('.bill-total')).toContainText(/Rp\s*3\.000/)
  // An emptied new cart drops its discount, so it cannot slide onto the next customer.
  await cart(page).getByRole('button', { name: 'Hapus Es teh manis' }).click()
  await cart(page).getByRole('button', { name: 'Hapus Air mineral' }).click()
  await addItem(page, 'Es teh manis')
  await expect(cart(page).locator('.bill-total')).toContainText(/Rp\s*6\.000/)
})

test('two quick taps on + add two portions', async ({ page }) => {
  await demo(page)
  await addItem(page, 'Es teh manis')
  // The second tap must see the first one even before IndexedDB has answered.
  await cart(page).getByRole('button', { name: 'Tambah Es teh manis' }).evaluate((b: HTMLButtonElement) => {
    b.click()
    setTimeout(() => b.click(), 0)
  })
  await expect(cart(page).locator('.quantity-control > span')).toHaveText('3')
})

test('the next table can be rung up while the first is still eating, without overwriting it', async ({ page }) => {
  await demo(page)
  await openShift(page)
  await cart(page).getByLabel(/Meja \/ nama pesanan/).fill('Meja 1')
  await addItem(page, 'Es teh manis')
  await cart(page).getByRole('button', { name: /Ke dapur/ }).click()
  await expect(cart(page).getByText(/Dikirim ke dapur/)).toBeVisible()
  await cart(page).getByRole('button', { name: 'Mulai pesanan baru' }).click()
  await expect(cart(page).getByText('Pesanan baru · 0 item')).toBeVisible()
  await cart(page).getByLabel(/Meja \/ nama pesanan/).fill('Meja 2')
  await addItem(page, 'Air mineral')
  await cart(page).getByRole('button', { name: /Simpan/ }).click()
  await expect(cart(page).getByText('Pesanan tersimpan')).toBeVisible()
  await go(page, 'Pesanan')
  await expect(page.locator('.order-card').filter({ hasText: 'Meja 1' })).toContainText('Es teh manis')
  await expect(page.locator('.order-card').filter({ hasText: 'Meja 2' })).toContainText('Air mineral')
})

test('a cart whose order was voided from Pesanan can still start a new order', async ({ page }) => {
  await demo(page)
  await openShift(page)
  await cart(page).getByLabel(/Meja \/ nama pesanan/).fill('Meja 9')
  await addItem(page, 'Es teh manis')
  await cart(page).getByRole('button', { name: /Ke dapur/ }).click()
  await expect(cart(page).getByText(/Dikirim ke dapur/)).toBeVisible()
  await go(page, 'Pesanan')
  await page.locator('.order-card').filter({ hasText: 'Meja 9' }).getByRole('button', { name: 'Detail' }).click()
  await page.getByRole('button', { name: 'Batalkan pesanan' }).click()
  await page.getByLabel('Alasan wajib').fill('Pelanggan pergi')
  await page.getByRole('button', { name: /Konfirmasi pembatalan/ }).click()
  await expect(page.getByText('Koreksi tersimpan di perangkat')).toBeVisible()
  await go(page, 'Kasir')
  await cart(page).getByRole('button', { name: 'Mulai pesanan baru' }).click()
  await expect(cart(page).getByText('Pesanan baru · 0 item')).toBeVisible()
})

test('a half-typed void on one order does not carry over to the next order opened', async ({ page }) => {
  await demo(page)
  await openShift(page)
  for (const table of ['Meja A', 'Meja B']) {
    await cart(page).getByLabel(/Meja \/ nama pesanan/).fill(table)
    await addItem(page, 'Es teh manis')
    await cart(page).getByRole('button', { name: /Simpan/ }).click()
    await cart(page).getByRole('button', { name: 'Mulai pesanan baru' }).click()
    await expect(cart(page).getByText('Pesanan baru · 0 item')).toBeVisible()
  }
  await go(page, 'Pesanan')
  await page.locator('.order-card').filter({ hasText: 'Meja A' }).getByRole('button', { name: 'Detail' }).click()
  await page.getByRole('button', { name: 'Batalkan pesanan' }).click()
  await page.getByLabel('Alasan wajib').fill('Salah input meja')
  await page.getByRole('dialog', { name: 'Meja A' }).getByRole('button', { name: 'Tutup' }).click()
  await page.locator('.order-card').filter({ hasText: 'Meja B' }).getByRole('button', { name: 'Detail' }).click()
  const other = page.getByRole('dialog', { name: 'Meja B' })
  await expect(other.getByRole('button', { name: 'Batalkan pesanan' })).toBeVisible()
  await expect(other.getByRole('button', { name: /Konfirmasi pembatalan/ })).toHaveCount(0)
})

test('closed shift history shows the latest three, newest first', async ({ page }) => {
  await demo(page)
  for (let i = 1; i <= 5; i++) {
    await go(page, 'Kasir')
    await openShift(page, '0')
    await go(page, 'Laporan')
    await page.getByRole('button', { name: 'Tutup sif' }).click()
    const closing = page.getByRole('dialog', { name: 'Tutup sif' })
    await closing.getByLabel(/Uang tunai yang dihitung/).fill(`${i}000`)
    await closing.getByRole('button', { name: 'Konfirmasi tutup sif' }).click()
    await expect(closing).toBeHidden()
  }
  await expect(page.locator('.history-list > div')).toContainText([/Dihitung Rp5\.000/, /Dihitung Rp4\.000/, /Dihitung Rp3\.000/])
})

test('the first kitchen ticket is not marked as a copy; printing it again is', async ({ page }) => {
  await demo(page)
  await openShift(page)
  await addItem(page, 'Es teh manis')
  await cart(page).getByRole('button', { name: /Ke dapur/ }).click()
  await expect(cart(page).getByText(/Dikirim ke dapur/)).toBeVisible()
  await go(page, 'Pesanan')
  await page.getByRole('button', { name: 'Persiapan dapur' }).click()
  await page.getByRole('button', { name: 'Cetak tiket dapur' }).click()
  const ticket = page.getByRole('dialog', { name: 'Tiket dapur' })
  const heading = ticket.locator('#print-area h2').first()
  await ticket.getByRole('button', { name: /Cetak tiket/ }).click()
  await expect(ticket.getByText('[BARU]')).toBeVisible()
  await expect(heading).toHaveText(/^DAPUR\s*$/)
  await ticket.getByRole('button', { name: /Cetak tiket/ }).click()
  await expect(heading).toContainText('SALINAN')
  await expect(ticket.getByText('[BARU]')).toHaveCount(0)
})

test('a menu the server would reject is refused in the editor, and the reason is announced', async ({ page }) => {
  await demo(page)
  await go(page, 'Lainnya')
  await page.getByRole('button', { name: 'Menu & resep' }).click()
  await page.getByRole('button', { name: 'Edit' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Edit menu' })
  await dialog.getByRole('button', { name: 'Tambah pilihan' }).click()
  await dialog.locator('.modifier-editor').last().getByLabel('Harga tambahan').fill('3000') // priced, but no name
  await dialog.getByRole('button', { name: 'Simpan versi menu' }).click()
  await expect(page.getByRole('alert')).toContainText('beri nama setiap tambahan')
  await expect(dialog).toBeVisible() // the editor closes only after a successful publish
})

test('an option can be added although an older build left a blank one on another item', async ({ page }) => {
  await demo(page)
  // Older builds saved an untouched "Tambah pilihan" row; one of those blocked every later menu save.
  await page.evaluate(async () => {
    const name = (await indexedDB.databases()).map(d => d.name!).find(n => n.startsWith('meja-demo'))!
    const db: IDBDatabase = await new Promise((ok, no) => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); r.onerror = no })
    const tx = db.transaction('menu', 'readwrite'), menu = tx.objectStore('menu')
    const item = await new Promise<{ modifiers: object[] }>(ok => { const r = menu.get('gado'); r.onsuccess = () => ok(r.result) })
    item.modifiers.push({ id: 'legacy-blank', name: '', price: 0, recipe: [] })
    menu.put(item)
    await new Promise(ok => { tx.oncomplete = ok })
    db.close()
  })
  await page.reload()
  await go(page, 'Lainnya')
  await page.getByRole('button', { name: 'Menu & resep' }).click()
  await page.locator('.admin-row').filter({ hasText: 'Air mineral' }).getByRole('button', { name: 'Edit' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit menu' })
  await dialog.getByRole('button', { name: 'Tambah pilihan' }).click()
  const row = dialog.locator('.modifier-editor').last()
  await row.getByLabel('Nama tambahan').fill('Es batu ekstra')
  await row.getByLabel('Harga tambahan').fill('1000')
  await dialog.getByRole('button', { name: 'Tambah pilihan' }).click() // and one left untouched
  await dialog.getByRole('button', { name: 'Simpan versi menu' }).click()
  await expect(page.getByText('Versi menu tersimpan; struk lama tidak berubah')).toBeVisible()
  await go(page, 'Kasir')
  await page.getByRole('button', { name: /Air mineral/ }).first().click()
  const pick = page.getByRole('dialog')
  await expect(pick.getByRole('checkbox')).toHaveCount(1)
  await pick.getByRole('checkbox', { name: /Es batu ekstra/ }).check()
  await pick.getByRole('button', { name: /Tambah ke pesanan/ }).click()
  await expect(cart(page)).toContainText('Es batu ekstra')
  await expect(cart(page).locator('.bill-total')).toContainText(/Rp\s*6\.000/)
})

test('a lower-case time zone is saved under the exact name the server checks', async ({ page }) => {
  await demo(page)
  await go(page, 'Lainnya')
  await page.getByRole('button', { name: 'Restoran' }).click()
  await page.getByLabel('Zona waktu').fill('asia/jakarta')
  await page.getByRole('button', { name: 'Simpan pengaturan' }).click()
  await expect(page.getByText('Pengaturan tersimpan')).toBeVisible()
  await page.reload() // the form keeps what was typed; check what was stored
  await page.getByRole('button', { name: 'Restoran' }).click()
  await expect(page.getByLabel('Zona waktu')).toHaveValue('Asia/Jakarta')
})

test('moving the primary till to this device works at once, without signing out and in again', async ({ page }) => {
  // A stand-in Supabase: the server reports "not primary" until enroll_device has been called.
  const owner = '33333333-3333-3333-3333-333333333333'
  let primary = false
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: owner, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
  await page.route('**/auth/v1/token**', route => route.fulfill({ json: { access_token: token, token_type: 'bearer', expires_in: 3600, refresh_token: 'refresh', user: { id: owner, aud: 'authenticated', role: 'authenticated', email: 'pemilik@example.com', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } } }))
  await page.route('**/rest/v1/rpc/*', route => {
    const rpc = new URL(route.request().url()).pathname.split('/').pop()
    if (rpc === 'enroll_device') { primary = true; return route.fulfill({ status: 204 }) }
    if (rpc === 'bootstrap') return route.fulfill({ json: { restaurantId: 'resto-e2e', name: 'Pemilik', role: 'owner', primary, settings: defaultSettings, menu: sampleMenu, stock, orders: [], shifts: [], cash: [], movements: [] } })
    return route.fulfill({ json: { id: 'op', receivedAt: new Date().toISOString() } }) // apply_operation
  })
  await page.goto('/')
  await page.getByLabel('Email staf').fill('pemilik@example.com')
  await page.getByLabel('Kata sandi').fill('rahasia-uji')
  await page.getByRole('button', { name: /Masuk ke restoran/ }).click()
  await expect(page.getByText(/Perangkat dashboard/)).toBeVisible()
  await go(page, 'Lainnya')
  await page.getByRole('button', { name: 'Printer & perangkat' }).click()
  await page.getByRole('button', { name: 'Jadikan perangkat ini kasir utama' }).click()
  await page.getByRole('button', { name: 'Pindahkan kasir utama ke sini' }).click()
  await expect(page.getByText(/Perangkat dashboard/)).toHaveCount(0)
  await page.getByRole('button', { name: 'Menu & resep' }).click()
  await page.getByRole('button', { name: 'Edit' }).first().click()
  await page.getByRole('dialog', { name: 'Edit menu' }).getByRole('button', { name: 'Simpan versi menu' }).click()
  await expect(page.getByText('Versi menu tersimpan; struk lama tidak berubah')).toBeVisible()
})
