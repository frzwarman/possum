// QA import: F3 (thousands dot), F6/STK-07 (opening stock needs a manager, refused before anything is saved), F12 (Windows-1252).
import { test, expect, go } from './meja'
import type { Page } from '@playwright/test'
const ADMIN = 'Admin stok · bahan, hitung & persetujuan'
const BAHAN = 'name,unit,quantity,threshold,area,pack_name,pack_qty\n'
async function demoAs(page: Page, role?: string) {
  await page.goto('/')
  if (role) { await page.getByRole('combobox', { name: 'Coba sebagai' }).click(); await page.getByRole('option', { name: role }).click() }
  await page.getByRole('button', { name: 'Jelajahi demo lokal' }).click()
  await expect(page.locator('.sidebar')).toBeVisible()
  await go(page, 'Lainnya'); await page.getByRole('button', { name: 'Impor CSV' }).click()
}
const pick = (page: Page, name: string, body: Buffer | string) => page.locator('.upload-label input[type=file]').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(body as never, typeof body === 'string' ? 'utf8' : undefined) })
const names = (page: Page, store: string) => page.evaluate(async (store) => {
  const n = (await indexedDB.databases()).map((d) => d.name!).find((n) => n.startsWith('meja-demo-'))!
  const db: IDBDatabase = await new Promise((ok, no) => { const r = indexedDB.open(n); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error) })
  const all = await new Promise<{ name: string }[]>((ok, no) => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error) })
  db.close(); return all.map((x) => x.name)
}, store)

test('F3: "1.500" opening stock and a "25.000" pack show as written in Indonesian and save as 1.500 and 25.000', async ({ page }) => {
  await demoAs(page); await pick(page, 'bahan.csv', BAHAN + 'Beras QA,g,1.500,0,Dry store,karung,25.000\nGula QA,g,"1,5",0,,,\n')
  await expect(page.getByText('2 baris diperiksa')).toBeVisible()
  await expect(page.locator('.import-preview > div').first()).toHaveText('Beras QA · g · 1.500 · 0 · Dry store · karung · 25.000')
  await expect(page.locator('.import-preview > div').nth(1)).toContainText('Gula QA · g · 1,5 · 0')
  await page.getByRole('button', { name: /^Konfirmasi impor/ }).click()
  await expect(page.getByText('Impor tersimpan')).toBeVisible()
})

test('F6: an admin importing opening quantities is told up front and nothing is saved', async ({ page }) => {
  await demoAs(page, ADMIN); await pick(page, 'bahan.csv', BAHAN + 'Gula QA,g,2000,0,Dry store,,\nKopi QA,g,0,0,Rak bar,,\n')
  await expect(page.getByText(/Baris 2: saldo awal hanya bisa dicatat pemilik atau manajer/)).toBeVisible()
  await expect(page.getByRole('button', { name: /^Konfirmasi impor/ })).toBeDisabled()
  expect((await names(page, 'stock')).filter((n) => n.endsWith(' QA'))).toEqual([])
  await pick(page, 'bahan.csv', BAHAN + 'Gula QA,g,0,0,Dry store,,\n')
  await page.getByRole('button', { name: /^Konfirmasi impor/ }).click()
  await expect(page.getByText('Impor tersimpan')).toBeVisible()
})

test('F12: a menu CSV saved as Windows-1252 keeps its accents', async ({ page }) => {
  await demoAs(page); await pick(page, 'menu.csv', Buffer.from('name,type,price\r\nCaf\xe9 Cr\xe8me Br\xfbl\xe9e,snack,30000\r\n', 'latin1'))
  await expect(page.locator('.import-preview > div').first()).toHaveText('Café Crème Brûlée · snack · 30000')
})
