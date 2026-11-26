// QA 2026-11-25, cluster stock, in demo mode: CAT-5 (a delivery time is the restaurant's wall clock), CAT-8 (the next delivery
// leads), CAT-9 (the document of a cancelled order), STK-11 (a PO received in parts adds up), CT-03/STK-05/CAT-6 (the drawer is
// offered only to the person whose shift is open).
import type { Page } from '@playwright/test'
import { test, expect, demo, go, openShift } from './meja'

const asLaptop = async (page: Page) => {
  await page.evaluate(() => { const u = JSON.parse(localStorage.getItem('meja-identity')!); localStorage.setItem('meja-identity', JSON.stringify({ ...u, primary: false, mode: 'office' })) })
  await page.reload()
  await expect(page.locator('.sidebar')).toBeVisible()
}
// Raw IndexedDB of the demo database of the signed-in role.
async function idb<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate(async (fn) => {
    const u = JSON.parse(localStorage.getItem('meja-identity')!)
    const db: IDBDatabase = await new Promise((ok, no) => { const r = indexedDB.open(`meja-demo-${u.restaurantId}-${u.id}-${u.deviceId}`); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error) })
    const all = (store: string): Promise<any[]> => new Promise((ok) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => ok(r.result) })
    const put = async (store: string, rows: unknown[]) => { const tx = db.transaction(store, 'readwrite'); for (const x of rows) tx.objectStore(store).put(x); await new Promise((ok) => (tx.oncomplete = ok)) }
    try { return await new Function('all', 'put', `return (async () => { ${fn} })()`)(all, put) } finally { db.close() }
  }, fn) as Promise<T>
}
async function newCatering(page: Page, o: { name: string; deliverAt?: string; qty: string; price?: string }) {
  await page.getByRole('button', { name: 'Pesanan baru' }).click()
  const d = page.getByRole('dialog', { name: 'Pesanan katering baru' })
  await d.getByLabel('Pelanggan / perusahaan').fill(o.name)
  if (o.deliverAt) await d.getByLabel('Dikirim pada').fill(o.deliverAt)
  await d.getByRole('combobox', { name: 'Menu' }).click()
  await page.getByRole('option', { name: /Nasi goreng kampung/ }).click()
  await d.getByLabel('Jumlah porsi').fill(o.qty)
  if (o.price) await d.getByLabel('Harga per porsi').fill(o.price)
  await d.getByRole('button', { name: /Tambah menu/ }).click()
  await d.getByRole('button', { name: 'Simpan pesanan' }).click()
}

test.describe('CAT-5 device zone', () => {
  test.use({ timezoneId: 'Asia/Makassar' }) // the owner's laptop is in Bali, the restaurant in Jakarta
  test('a delivery time typed as 11:30 is shown, printed and edited as 11:30', async ({ page }) => {
    await demo(page)
    await page.goto('/catering')
    await newCatering(page, { name: 'Bu Made', deliverAt: '2026-11-28T11:30', qty: '20' })
    const card = page.locator('.order-card').filter({ hasText: 'Bu Made' })
    expect(await card.locator('p.muted.small').first().innerText()).toContain('11.30')
    await card.getByRole('button', { name: /Cetak atau kirim/ }).click()
    expect(await page.locator('#print-area pre').innerText()).toContain('Dikirim: 28 Nov 2026, 11.30')
    await page.keyboard.press('Escape')
    await card.getByRole('button', { name: 'Ubah' }).click()
    expect(await page.getByRole('dialog', { name: 'Ubah pesanan' }).getByLabel('Dikirim pada').inputValue()).toBe('2026-11-28T11:30')
    expect(await idb<string>(page, "return (await all('salesOrders'))[0].deliverAt")).toBe('2026-11-28T04:30:00.000Z')
  })
})

test('CAT-8: Akan dikirim lists the next delivery first', async ({ page }) => {
  await demo(page)
  await idb(page, `const day = 864e5, base = { customer: { phone: '', address: '' }, lines: [{ id: 'l', itemId: 'nasi-goreng', name: 'Nasi goreng kampung', qty: 10, price: 20000, catalogVersion: 1 }], discount: 0, note: '', totals: { subtotal: 200000, discount: 0, service: 0, tax: 0, total: 200000 }, payments: [], status: 'confirmed', revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    await put('salesOrders', [['Rapat besok pagi', 1], ['Pesta minggu depan', 7], ['Arisan lusa', 2]].map(([n, d], i) => ({ ...base, id: 'so-' + i, number: 'SO-ORDER00' + i, customer: { ...base.customer, name: n }, deliverAt: new Date(Date.now() + d * day).toISOString() })))`)
  await page.goto('/catering')
  await expect(page.locator('.order-card')).toHaveCount(3)
  expect(await page.locator('.order-card h2').allInnerTexts()).toEqual(['Rapat besok pagi', 'Arisan lusa', 'Pesta minggu depan'])
})

test('CAT-9: the document of a cancelled order says it was cancelled, with the reason', async ({ page }) => {
  await demo(page)
  await page.goto('/catering')
  await newCatering(page, { name: 'PT Sentosa', qty: '8', price: '25000' })
  await page.locator('.order-card').filter({ hasText: 'PT Sentosa' }).getByRole('button', { name: 'Batalkan' }).click()
  const d = page.getByRole('dialog', { name: 'Batalkan pesanan' })
  await d.getByLabel('Alasan wajib').fill('Acara diundur tanpa tanggal')
  await d.getByRole('button', { name: 'Konfirmasi pembatalan' }).click()
  await expect(page.getByText('Pesanan dibatalkan')).toBeVisible()
  await page.getByRole('button', { name: 'Semua' }).click()
  await page.locator('.order-card').filter({ hasText: 'PT Sentosa' }).getByRole('button', { name: /Cetak atau kirim/ }).click()
  const text = await page.locator('#print-area pre').innerText()
  expect(text).toContain('DIBATALKAN: Acara diundur tanpa tanggal')
  expect(text).not.toContain('Sisa:')
})

test('STK-11: a PO line received in three parts at the PO price adds up to the PO', async ({ page }) => {
  await demo(page)
  await go(page, 'Pembelian')
  await page.getByRole('button', { name: 'Buat PO' }).click()
  const d = page.getByRole('dialog')
  await d.getByLabel('Pemasok').fill('CV Garam QA')
  await d.getByRole('combobox', { name: /^Bahan / }).first().click()
  await page.getByRole('option', { name: 'Garam (g)' }).click()
  await d.getByLabel('Jumlah').fill('3')
  await d.getByRole('combobox', { name: /^Satuan / }).first().click()
  await page.getByRole('option', { name: 'kg (1.000 g)' }).click()
  await d.getByLabel('Harga total baris').fill('100000')
  await d.getByRole('button', { name: 'Tambah ke PO' }).click()
  await d.getByRole('button', { name: 'Simpan PO' }).click()
  await expect(d).toBeHidden()
  const totals: number[] = []
  for (let i = 0; i < 3; i++) {
    await page.locator('article, .panel, tr').filter({ hasText: 'CV Garam QA' }).getByRole('button', { name: 'Terima kiriman' }).first().click()
    await page.getByLabel('Garam (kg)').fill('1')
    totals.push(Number((await page.locator('.receive-table tbody tr').first().locator('td.num strong').innerText()).replace(/\D/g, '')))
    await page.getByRole('button', { name: /Konfirmasi dan masukkan ke stok/ }).click()
    await expect(page.getByRole('heading', { name: /Terima kiriman dari/ })).toBeHidden()
  }
  expect(totals.reduce((n, t) => n + t, 0)).toBe(100000)
})

test('CT-03/CAT-6: the drawer is offered only to the person whose own shift is open', async ({ page }) => {
  await demo(page)
  await openShift(page)
  await asLaptop(page) // the same person on a paired laptop while his till shift is open
  const source = async () => {
    await page.goto('/catering')
    await page.getByRole('button', { name: 'Pesanan baru' }).click()
    await page.getByRole('dialog', { name: 'Pesanan katering baru' }).getByLabel('Uang muka (DP)').fill('1000')
    await page.getByRole('combobox', { name: 'DP diterima sebagai' }).click()
    return page.getByRole('option', { name: /Tunai ke laci/ })
  }
  await expect(await source()).toBeEnabled()
  await expect(await source()).toHaveText('Tunai ke laci kas sif aktif')
  // The shift belongs to somebody else: not offered.
  await idb(page, "const s = (await all('shifts')).filter((x) => x.status === 'open'); await put('shifts', s.map((x) => ({ ...x, actor: 'orang-lain' })))")
  await page.reload()
  const other = await source()
  await expect(other).toBeDisabled()
  await expect(other).toHaveText('Tunai ke laci (buka sif Anda dulu)')
})
