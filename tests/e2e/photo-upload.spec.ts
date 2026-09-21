import { test, expect, demo, go } from './meja'

test('menu photo is optional, compressed on upload, and shown in the POS', async ({ page }) => {
  await demo(page)
  await go(page, 'Lainnya')
  await page.getByRole('button', { name: 'Menu & resep' }).click()
  const first = page.getByRole('button', { name: 'Edit' }).first()
  await first.click()
  const dialog = page.getByRole('dialog', { name: 'Edit menu' })
  const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
  await dialog.locator('input[type=file]').setInputFiles({
    name: 'menu.png',
    mimeType: 'image/png',
    buffer: tinyPng,
  })
  await expect(dialog.locator('img[alt="Pratinjau foto menu"]')).toHaveAttribute(
    'src',
    /^data:image\/webp;base64,/,
  )
  await dialog.getByRole('button', { name: 'Simpan versi menu' }).click()
  await expect(page.locator('.admin-row').first()).toContainText('Dengan foto')
  await page.getByRole('link', { name: 'Kasir' }).click()
  await expect(page.locator('.menu-card').first().locator('img')).toHaveAttribute(
    'src',
    /^data:image\/webp;base64,/,
  )
})
