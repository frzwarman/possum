import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { test, expect, demo, go, addItem, cart } from './meja'

// QA 26 Nov #14: the controls QA found without a name for a screen reader: the shift-open EDC ticks, the payment
// dialog (its checkbox included) and the cash in/out form. The whole axe rule set except contrast (the a11y spec has
// that), on the screens named: axe found nothing unnamed there on 26 Nov, so this keeps it that way.
async function named(page: Page, scope?: string) {
  let axe = new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice']).disableRules(['color-contrast','region','page-has-heading-one'])
  if (scope) axe = axe.include(scope)
  const { violations } = await axe.analyze()
  expect(violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(' | ')}`)).toEqual([])
}

test('EDC ticks, the payment dialog and the cash in/out form all have names', async ({ page }) => {
  await demo(page)
  await go(page, 'Lainnya')
  await page.getByRole('button', { name: 'Restoran' }).click()
  await page.getByLabel(/Mesin EDC/).fill('BCA, BRI')
  await page.getByRole('button', { name: 'Simpan pengaturan' }).click()
  await expect(page.getByText('Pengaturan tersimpan')).toBeVisible()
  await go(page, 'Kasir')
  await page.getByRole('button', { name: /Buka sif untuk melayani/ }).click()
  await named(page)
  await page.getByRole('button', { name: /^EDC BCA/ }).click()
  await page.getByLabel(/Modal kas awal/).fill('200000')
  await page.getByRole('button', { name: 'Buka sif sekarang' }).click()
  await expect(page.getByText('Sif terbuka', { exact: true })).toBeVisible()
  await addItem(page, 'Es teh manis')
  await cart(page).getByRole('button', { name: /Ke stasiun/ }).click()
  await cart(page).getByRole('button', { name: /^Bayar Rp/ }).click()
  const pay = page.getByRole('dialog', { name: 'Terima pembayaran' })
  await expect(pay).toBeVisible()
  await named(page)
  for (const m of ['QRIS', 'Kartu']) { await pay.getByRole('button', { name: m, exact: true }).click(); await named(page) }
  await pay.getByRole('button', { name: 'Tutup' }).click()
  await go(page, 'Sif')
  await page.getByRole('button', { name: 'Catat kas masuk / keluar' }).click()
  await expect(page.getByRole('dialog', { name: 'Mutasi laci kas' })).toBeVisible()
  await named(page)
})

test('the manual QRIS check box in the payment dialog has a name (store without EDC)', async ({ page }) => {
  await demo(page)
  await go(page, 'Kasir')
  await page.getByRole('button', { name: /Buka sif untuk melayani/ }).click()
  await page.getByLabel(/Modal kas awal/).fill('200000')
  await page.getByRole('button', { name: 'Buka sif sekarang' }).click()
  await expect(page.getByText('Sif terbuka', { exact: true })).toBeVisible()
  await addItem(page, 'Es teh manis')
  await cart(page).getByRole('button', { name: /Ke stasiun/ }).click()
  await cart(page).getByRole('button', { name: /^Bayar Rp/ }).click()
  const pay = page.getByRole('dialog', { name: 'Terima pembayaran' })
  await pay.getByRole('button', { name: 'QRIS', exact: true }).click()
  await expect(pay.getByRole('checkbox', { name: /sudah memeriksa/ })).toBeVisible()
  await named(page)
})
