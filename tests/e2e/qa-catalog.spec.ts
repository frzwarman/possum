// QA 2026-11-25, cluster catalog: the menu editor and the bahan editor in demo mode (menu/F2 F4 F5 F7 F10 F11 F16,
// till/TILL-16). F7 is about WebKit: run this file on webkit too (browserName 'webkit') to see the JPEG path.
import { readFileSync } from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import { test, expect, go, openShift, cart } from './meja'
import type { MenuItem, Operation, StockItem } from '../../src/domain/types'

const SAVED = 'Versi menu tersimpan; struk lama tidak berubah'
const CHEF = 'Kepala dapur · resep'
async function demoAs(page: Page, role?: string) {
  await page.goto('/')
  if (role) { await page.getByRole('combobox', { name: 'Coba sebagai' }).click(); await page.getByRole('option', { name: role }).click() }
  await page.getByRole('button', { name: 'Jelajahi demo lokal' }).click()
  await expect(page.locator('.sidebar')).toBeVisible()
}
async function tab(page: Page, name: 'Menu & resep' | 'Daftar bahan' | 'Impor CSV') { await go(page, 'Lainnya'); await page.getByRole('button', { name }).click() }
const choose = async (page: Page, scope: Locator, label: string, option: string) => { await scope.getByRole('combobox', { name: new RegExp(`^${label}`) }).click(); await page.getByRole('option', { name: option }).click() }
const rowOf = (page: Page, name: string) => page.locator('.admin-row').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name.replace(/[()+.*?]/g, '\\$&')}$`) }) })
const price = (e: Locator) => e.getByLabel(/^Harga(?! tambahan)/)
const askPin = (page: Page) => page.getByRole('dialog', { name: 'Persetujuan manajer' })
// Every record in one store of the demo's Dexie database, read with the raw IndexedDB API.
function idb<T>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(async (store) => {
    const name = (await indexedDB.databases()).map((d) => d.name!).find((n) => n.startsWith('meja-demo-'))!
    const db: IDBDatabase = await new Promise((ok, no) => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error) })
    const all = await new Promise((ok, no) => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error) })
    db.close(); return all
  }, store) as Promise<T[]>
}
const publishes = async (page: Page) => (await idb<Operation>(page, 'outbox')).filter((o) => o.kind === 'catalog.publish').sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).map((o) => o.payload as { menu: MenuItem[]; stock: StockItem[] })

test('F2: when another writer saved the open menu meanwhile, the editor refuses instead of overwriting their version', async ({ page, context }) => {
  await demoAs(page); await tab(page, 'Menu & resep')
  await rowOf(page, 'Es teh manis').getByRole('button', { name: 'Edit' }).click()
  const e = page.getByRole('region', { name: 'Edit menu' })
  await expect(e.getByText('Mengedit v2')).toBeVisible()
  // A second tab on the same device database saves first: what a pull of another laptop's save does.
  const p2 = await context.newPage(); await p2.goto('/'); await tab(p2, 'Menu & resep')
  await rowOf(p2, 'Es teh manis').getByRole('button', { name: 'Edit' }).click()
  await price(p2.getByRole('region', { name: 'Edit menu' })).fill('12000')
  await p2.getByRole('region', { name: 'Edit menu' }).getByRole('button', { name: 'Simpan versi menu' }).click()
  await expect(p2.getByText(SAVED)).toBeVisible(); await p2.close()
  await expect(e.getByText('Mengedit v3')).toBeVisible()
  await price(e).fill('5500')
  await e.getByRole('button', { name: 'Simpan versi menu' }).click()
  await expect(page.getByText(/Es teh manis.*diubah di perangkat lain/)).toBeVisible()
  // Nothing was queued or overwritten: the other writer's v2 is what the device holds, and only their save was sent.
  const local = (await idb<MenuItem>(page, 'menu')).find((m) => m.id === 'es-teh')!
  expect([local.version, local.price]).toEqual([2, 12000])
  expect((await publishes(page)).map((p) => p.menu.map((m) => `${m.id} v${m.version} Rp${m.price}`))).toEqual([['es-teh v2 Rp12000']])
})

test('F1/F9: a menu save carries the one edited menu and no bahan', async ({ page }) => {
  await demoAs(page); await tab(page, 'Menu & resep')
  await rowOf(page, 'Es teh manis').getByRole('button', { name: 'Edit' }).click()
  const e = page.getByRole('region', { name: 'Edit menu' })
  await price(e).fill('7000')
  await e.getByRole('button', { name: 'Simpan versi menu' }).click()
  await expect(page.getByText(SAVED)).toBeVisible()
  expect((await publishes(page)).map((p) => [p.menu.map((m) => m.id), p.stock.length])).toEqual([[['es-teh'], 0]])
  expect((await idb<MenuItem>(page, 'menu')).length).toBeGreaterThan(1)
})

test('F4: an option made default while its group was "pilih satu" is not pre-ticked once the group is "Tambahan"', async ({ page }) => {
  await demoAs(page); await tab(page, 'Menu & resep')
  await page.getByRole('button', { name: 'Tambah menu' }).click()
  const e = page.getByRole('region', { name: 'Tambah menu' })
  await e.getByLabel('Nama menu').fill('QA Kopi Topping')
  await e.getByRole('radio', { name: 'Minuman' }).check()
  await price(e).fill('20000')
  await e.getByRole('button', { name: 'Tambah grup pilihan' }).click()
  await e.getByLabel('Nama grup').fill('Ukuran')
  await choose(page, e, 'Jenis grup', 'Ukuran (pilih satu)')
  await e.getByRole('button', { name: 'Tambah pilihan' }).click()
  const opt = e.locator('.modifier-editor').last()
  await opt.getByLabel('Nama tambahan').fill('Extra shot')
  await opt.getByLabel('Harga tambahan').fill('6000')
  await choose(page, opt, 'Grup', 'Ukuran')
  await opt.getByRole('checkbox', { name: 'Pilihan bawaan' }).check()
  await choose(page, e, 'Jenis grup', 'Tambahan (boleh beberapa)')
  await e.getByRole('button', { name: 'Simpan versi menu' }).click()
  await expect(page.getByText(SAVED)).toBeVisible()
  const saved = (await idb<MenuItem>(page, 'menu')).find((m) => m.name === 'QA Kopi Topping')!
  expect(saved.modifiers.map((m) => Boolean(m.default))).toEqual([false])
  await go(page, 'Kasir'); await openShift(page)
  await page.getByRole('button', { name: /QA Kopi Topping/ }).first().click()
  const sheet = page.getByRole('dialog', { name: 'QA Kopi Topping' })
  await expect(sheet.getByRole('checkbox', { name: /Extra shot/ })).not.toBeChecked()
  await sheet.getByRole('button', { name: /Tambah ke pesanan/ }).click()
  await expect(cart(page).locator('.bill-total')).toContainText(/Rp\s*20\.000/)
})

test('F4 (till): a menu saved by an older build with a default in an add group still starts unticked', async ({ page }) => {
  await demoAs(page); await tab(page, 'Menu & resep')
  await page.getByRole('button', { name: 'Tambah menu' }).click()
  const e = page.getByRole('region', { name: 'Tambah menu' })
  await e.getByLabel('Nama menu').fill('QA Kopi Lama')
  await e.getByRole('radio', { name: 'Minuman' }).check()
  await price(e).fill('20000')
  await e.getByRole('button', { name: 'Tambah grup pilihan' }).click()
  await e.getByLabel('Nama grup').fill('Topping')
  await choose(page, e, 'Jenis grup', 'Tambahan (boleh beberapa)')
  await e.getByRole('button', { name: 'Tambah pilihan' }).click()
  const opt = e.locator('.modifier-editor').last()
  await opt.getByLabel('Nama tambahan').fill('Extra shot')
  await opt.getByLabel('Harga tambahan').fill('6000')
  await choose(page, opt, 'Grup', 'Topping')
  await e.getByRole('button', { name: 'Simpan versi menu' }).click()
  await expect(page.getByText(SAVED)).toBeVisible()
  // Plant the old shape straight into the device database: default true inside an add group.
  await page.evaluate(async () => {
    const name = (await indexedDB.databases()).map((d) => d.name!).find((n) => n.startsWith('meja-demo-'))!
    const db: IDBDatabase = await new Promise((ok, no) => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error) })
    const tx = db.transaction('menu', 'readwrite'), store = tx.objectStore('menu')
    const all: MenuItem[] = await new Promise((ok) => { const q = store.getAll(); q.onsuccess = () => ok(q.result) })
    const m = all.find((x) => x.name === 'QA Kopi Lama')!
    m.modifiers = m.modifiers.map((x) => ({ ...x, default: true })); store.put(m)
    await new Promise((ok) => { tx.oncomplete = () => ok(undefined) }); db.close()
  })
  await page.reload(); await expect(page.locator('.sidebar')).toBeVisible()
  await go(page, 'Kasir'); await openShift(page)
  await page.getByRole('button', { name: /QA Kopi Lama/ }).first().click()
  const sheet = page.getByRole('dialog', { name: 'QA Kopi Lama' })
  await expect(sheet.getByRole('checkbox', { name: /Extra shot/ })).not.toBeChecked()
})

test.describe('F5: a chef saves without a PIN unless the saved menu itself is active without a recipe (MENU-7)', () => {
  test('price change on a menu with a recipe, while other active menus lack one', async ({ page }) => {
    await demoAs(page, CHEF); await tab(page, 'Menu & resep')
    expect((await idb<MenuItem>(page, 'menu')).some((m) => m.active && !m.recipe.length)).toBe(true)
    await rowOf(page, 'Es teh manis').getByRole('button', { name: 'Edit' }).click()
    const e = page.getByRole('region', { name: 'Edit menu' })
    await price(e).fill('7000')
    await e.getByRole('button', { name: 'Simpan versi menu' }).click()
    await expect(page.getByText(SAVED)).toBeVisible()
    await expect(askPin(page)).toHaveCount(0)
  })
  test('first recipe line on a bare menu', async ({ page }) => {
    await demoAs(page, CHEF); await tab(page, 'Menu & resep')
    await rowOf(page, 'Gado-gado').getByRole('button', { name: 'Edit' }).click()
    const e = page.getByRole('region', { name: 'Edit menu' })
    await e.getByRole('combobox', { name: /^Bahan/ }).fill('Garam')
    await page.getByRole('option', { name: /^Garam/ }).first().click()
    await e.getByLabel('Jumlah', { exact: true }).fill('2')
    await e.getByRole('button', { name: 'Tambah bahan resep' }).click()
    await e.getByRole('button', { name: 'Simpan versi menu' }).click()
    await expect(page.getByText(SAVED)).toBeVisible()
    await expect(askPin(page)).toHaveCount(0)
  })
  test('switching a bare menu off', async ({ page }) => {
    await demoAs(page, CHEF); await tab(page, 'Menu & resep')
    await rowOf(page, 'Gado-gado').getByRole('button', { name: 'Edit' }).click()
    const e = page.getByRole('region', { name: 'Edit menu' })
    await e.getByRole('checkbox', { name: 'Aktif' }).uncheck()
    await e.getByRole('button', { name: 'Simpan versi menu' }).click()
    await expect(page.getByText(SAVED)).toBeVisible()
    await expect(askPin(page)).toHaveCount(0)
  })
  test('a price change on a bare active menu still asks', async ({ page }) => {
    await demoAs(page, CHEF); await tab(page, 'Menu & resep')
    await rowOf(page, 'Gado-gado').getByRole('button', { name: 'Edit' }).click()
    const e = page.getByRole('region', { name: 'Edit menu' })
    await price(e).fill('21000')
    await e.getByRole('button', { name: 'Simpan versi menu' }).click()
    await expect(askPin(page)).toBeVisible()
  })
})

test('F7: a sample product photo becomes a small WebP, or a JPEG where the browser cannot encode WebP (WebKit)', async ({ page, browserName }) => {
  await demoAs(page); await tab(page, 'Menu & resep')
  await rowOf(page, 'Es teh manis').getByRole('button', { name: 'Edit' }).click()
  const e = page.getByRole('region', { name: 'Edit menu' })
  const path = 'docs/samples/menu-import/TEST Es Kopi Susu Aren.jpg'
  await e.locator('input[type=file]').setInputFiles({ name: 'aren.jpg', mimeType: 'image/jpeg', buffer: readFileSync(path) })
  const img = e.locator('img[alt="Pratinjau foto menu"]')
  await expect(img).toHaveAttribute('src', /^data:image\/(webp|jpeg);base64,/)
  const src = (await img.getAttribute('src'))!
  expect(src.startsWith(browserName === 'webkit' ? 'data:image/jpeg' : 'data:image/webp')).toBe(true)
  expect(src.length).toBeLessThanOrEqual(70_000)
  await e.getByRole('button', { name: 'Simpan versi menu' }).click()
  await expect(page.getByText(SAVED)).toBeVisible()
  expect((await idb<MenuItem>(page, 'menu')).find((m) => m.id === 'es-teh')!.photo).toBe(src)
})

test('F10: typing "fresh milk, susu cair" into a bahan\'s "Nama lain untuk pencarian" keeps two aliases', async ({ page }) => {
  await demoAs(page); await tab(page, 'Daftar bahan')
  await rowOf(page, 'Susu segar').getByRole('button', { name: 'Edit' }).click()
  const field = page.getByLabel('Nama lain untuk pencarian')
  await field.fill('')
  await field.pressSequentially('fresh milk, susu cair')
  await expect(field).toHaveValue('fresh milk, susu cair')
  await page.getByRole('button', { name: 'Simpan bahan' }).click()
  await expect(page.getByText('Bahan tersimpan')).toBeVisible()
  const s = (await idb<StockItem>(page, 'stock')).find((x) => x.name === 'Susu segar')!
  expect(s.aliases).toEqual(['fresh milk', 'susu cair'])
  // The save carried that one bahan and no menu.
  expect((await publishes(page)).map((p) => [p.menu.length, p.stock.map((b) => b.id)])).toEqual([[0, [s.id]]])
})

test('F11: menus and bahan are listed by name and the search field narrows them', async ({ page }) => {
  await demoAs(page); await tab(page, 'Menu & resep')
  const names = await page.locator('.admin-row strong').allInnerTexts()
  expect(names.length).toBeGreaterThan(3)
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'id')))
  await page.getByRole('searchbox', { name: 'Cari menu' }).fill('es teh')
  await expect(page.locator('.admin-row strong')).toHaveText(['Es teh manis'])
  await tab(page, 'Daftar bahan')
  const bahan = await page.locator('.admin-row strong').allInnerTexts()
  expect(bahan).toEqual([...bahan].sort((a, b) => a.localeCompare(b, 'id')))
  await page.getByRole('searchbox', { name: 'Cari bahan' }).fill('susu')
  await expect(page.locator('.admin-row strong').first()).toHaveText(/Susu/)
  for (const n of await page.locator('.admin-row strong').allInnerTexts()) expect(n.toLowerCase()).toContain('susu')
})

test('F16: a menu name typed with a trailing space is saved trimmed, so the import sees it as taken', async ({ page }) => {
  await demoAs(page); await tab(page, 'Menu & resep')
  await page.getByRole('button', { name: 'Tambah menu' }).click()
  const e = page.getByRole('region', { name: 'Tambah menu' })
  await e.getByLabel('Nama menu').pressSequentially('Kopi  Susu QA ')
  await price(e).fill('20000')
  await e.getByRole('button', { name: 'Simpan versi menu' }).click()
  await expect(page.getByText(SAVED)).toBeVisible()
  const m = (await idb<MenuItem>(page, 'menu')).find((x) => x.name.startsWith('Kopi'))!
  expect(m.name).toBe('Kopi Susu QA')
  await tab(page, 'Impor CSV')
  await page.locator('.upload-label input[type=file]').setInputFiles({ name: 'menu.csv', mimeType: 'text/csv', buffer: Buffer.from('name,type,price\nKopi Susu QA,beverage,20000\n') })
  await expect(page.getByText(/Nama sudah ada/)).toBeVisible()
})

test('TILL-16: the menu editor no longer offers "Favorit" (the till does not read it)', async ({ page }) => {
  await demoAs(page); await tab(page, 'Menu & resep')
  await rowOf(page, 'Es teh manis').getByRole('button', { name: 'Edit' }).click()
  const e = page.getByRole('region', { name: 'Edit menu' })
  await expect(e.getByRole('checkbox', { name: 'Aktif' })).toBeVisible()
  await expect(e.getByRole('checkbox', { name: 'Favorit' })).toHaveCount(0)
})
