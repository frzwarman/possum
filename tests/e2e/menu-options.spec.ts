import { test, expect, demo, openShift, cart, go, balance } from './meja'
import type { Page } from '@playwright/test'
const choose = async (page: Page, scope: ReturnType<Page['getByRole']>, label: string, option: string) => {
  await scope.getByRole('combobox', { name: new RegExp(`^${label}`) }).click()
  await page.getByRole('option', { name: option }).click()
}

// The bahan search: type the name, then pick it from the list.
const pickBahan = async (page: Page, scope: ReturnType<Page['getByRole']>, label: string, name: string) => {
  await scope.getByRole('combobox', { name: new RegExp(`^${label}`) }).fill(name)
  await page.getByRole('option', { name: new RegExp(`^${name}`) }).first().click()
}
// MENU-1 / MENU-5 / POS-4: one form publishes an item with a swap option; the sale moves the swapped ingredient.
test('a swap option is set up in one form and moves the right ingredient when sold', async ({ page }) => {
  await demo(page)
  await go(page, 'Lainnya')
  await page.getByRole('button', { name: 'Menu & resep' }).click()
  await page.getByRole('button', { name: 'Tambah menu' }).click()
  const dialog = page.getByRole('region', { name: 'Tambah menu' })
  await dialog.getByLabel('Nama menu').fill('Kopi Susu')
  await dialog.getByRole('radio', { name: 'Minuman' }).check()
  await dialog.getByLabel(/^Harga(?! tambahan)/).fill('20000')
  await pickBahan(page, dialog, 'Bahan', 'Susu segar')
  await dialog.getByLabel('Jumlah', { exact: true }).fill('150')
  await dialog.getByRole('button', { name: 'Tambah bahan resep' }).click()
  await expect(dialog.getByRole('row', { name: /Susu segar\s+150 ml/ })).toBeVisible()
  await dialog.getByRole('button', { name: 'Tambah grup pilihan' }).click()
  await dialog.getByLabel('Nama grup').fill('Susu')
  await choose(page, dialog, 'Jenis grup', 'Ganti (pilih satu)')
  await dialog.getByRole('button', { name: 'Tambah pilihan' }).click()
  const option = dialog.locator('.modifier-editor').last()
  await option.getByLabel('Nama tambahan').fill('Oat milk')
  await option.getByLabel('Harga tambahan').fill('5000')
  await choose(page, option, 'Grup', 'Susu')
  for (const [stock, effect] of [['Susu segar', 'kurangi / ganti'], ['Susu oat', 'tambah']]) {
    await option.getByRole('button', { name: 'Tambah efek bahan' }).click()
    await pickBahan(page, option, 'Bahan', stock)
    await choose(page, option, 'Efek', effect)
    await option.getByLabel('Jumlah', { exact: true }).fill('150')
    await option.getByRole('button', { name: 'Simpan efek' }).click()
  }
  await expect(option).toContainText('ganti Susu segar → Susu oat')
  await dialog.getByRole('button', { name: 'Simpan versi menu' }).click()
  await expect(page.getByText('Versi menu tersimpan; struk lama tidak berubah')).toBeVisible()
  await go(page, 'Kasir')
  await openShift(page)
  await page.getByRole('button', { name: /Kopi Susu/ }).click()
  const pick = page.getByRole('dialog', { name: 'Kopi Susu' })
  await pick.getByRole('radio', { name: /Oat milk/ }).check()
  await expect(pick).toContainText('ganti Susu segar → Susu oat')
  await pick.getByRole('button', { name: /Tambah ke pesanan/ }).click()
  await expect(cart(page)).toContainText('Oat milk')
  await expect(cart(page).locator('.bill-total')).toContainText(/Rp\s*25\.000/)
  await cart(page).getByRole('button', { name: /Ke stasiun/ }).click()
  await expect(cart(page).getByText(/Dikirim · bar/)).toBeVisible()
  await go(page, 'Stok')
  await expect(balance(page, 'Susu oat')).toHaveText('9.850')
  await expect(balance(page, 'Susu segar')).toHaveText('10.000')
})
test('a cashier opening Lainnya lands on a tab that exists', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('combobox', { name: 'Coba sebagai' }).click()
  await page.getByRole('option', { name: 'Kasir' }).click()
  await page.getByRole('button', { name: 'Jelajahi demo lokal' }).click()
  await go(page, 'Lainnya')
  await expect(page.getByRole('heading', { name: 'Antrean sinkronisasi' })).toBeVisible()
})

// Figma Manager 4 "Recipe: search an ingredient": find a bahan by its name or nama lain, keyboard all the way, and add a
// missing one without leaving the recipe.
test('the recipe finds a bahan by typing, adds it from the keyboard, and creates a missing one in place', async ({ page }) => {
  await demo(page)
  await go(page, 'Lainnya')
  await page.getByRole('button', { name: 'Menu & resep' }).click()
  await page.getByRole('button', { name: 'Tambah menu' }).click()
  const dialog = page.getByRole('region', { name: 'Tambah menu' })
  const search = dialog.getByRole('combobox', { name: /^Bahan/ })
  const amount = dialog.getByLabel('Jumlah', { exact: true })
  // "oat milk" is the nama lain of Susu oat.
  await search.fill('oat milk')
  await expect(dialog.getByRole('option')).toHaveCount(1)
  await expect(dialog.getByText('1 dari')).toBeVisible()
  await search.press('Enter')
  await expect(amount).toBeFocused()
  await amount.fill('150')
  await amount.press('Enter')
  await expect(dialog.getByRole('row', { name: /Susu oat\s+150 ml/ })).toBeVisible()
  await expect(search).toBeFocused()
  // Already in the recipe: still listed, but it can't be added twice.
  await search.fill('susu')
  await expect(dialog.getByRole('option', { name: /^Susu oat/ })).toHaveAttribute('aria-disabled', 'true')
  await expect(dialog.getByRole('option', { name: /^Susu oat/ })).toContainText('Sudah di resep')
  // Not there yet: the bahan form opens with the typed name, and once saved the search holds the new bahan.
  await search.fill('Sirup pandan')
  await expect(dialog.getByText('Tidak ada bahan yang cocok.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Belum ada? Tambah bahan baru' }).click()
  const form = page.getByRole('dialog', { name: 'Bahan stok' })
  await expect(form.getByLabel('Nama bahan')).toHaveValue('Sirup pandan')
  await form.getByRole('button', { name: 'Simpan bahan' }).click()
  await expect(form).toBeHidden()
  await expect(search).toHaveValue('Sirup pandan')
  await expect(amount).toBeVisible()
})
