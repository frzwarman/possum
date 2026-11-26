import { test, expect, signIn, useDevice } from './stack'
// QA 2026-11-25, cluster station, on the real SQL: AUTH-05 / STN-05 (the old till learns it is no longer the till),
// AUTH-06 (the till has no one-tap re-pair), STN-17 (the server's reason is shown).
test('AUTH-05: after the owner moves the till, the old device becomes view-only on its next pull', async ({ page, context, stack }) => {
  const { owner, cashier } = stack.users
  const till = await useDevice(context)
  await stack.rpc(owner, 'enroll_device', { device_id: till, mode: 'pos' })
  await signIn(page, cashier)
  await page.goto('/pos')
  await expect(page.getByRole('button', { name: /Buka sif/ }).first()).toBeVisible()
  await stack.rpc(owner, 'enroll_device', { device_id: crypto.randomUUID(), mode: 'pos' })
  await expect(page.locator('.till-only')).toBeVisible({ timeout: 25_000 })
  await expect(page.getByRole('alert').filter({ hasText: 'penjualan' })).toBeVisible()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('meja-identity')!).primary)).toBe(false)
})
test('AUTH-06: a manager on the till is not offered to un-pair it', async ({ page, context, stack }) => {
  const { owner, manager } = stack.users
  const till = await useDevice(context)
  await stack.rpc(owner, 'enroll_device', { device_id: till, mode: 'pos' })
  await signIn(page, manager)
  await page.goto('/team')
  await expect(page.locator('.device-row').getByText('Kasir utama', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /Pasangkan sebagai/ })).toHaveCount(0)
})
test('AUTH-06 / STN-17: the owner on the till is asked before it stops being the till, and the server\'s reason is shown', async ({ page, context, stack }) => {
  const { owner } = stack.users
  const till = await useDevice(context)
  await stack.rpc(owner, 'enroll_device', { device_id: till, mode: 'pos' })
  await signIn(page, owner)
  await page.goto('/team')
  await expect(page.getByRole('button', { name: /Pasangkan sebagai/ })).toHaveCount(0) // nothing preselected
  await page.getByRole('combobox', { name: /Pasangkan perangkat ini sebagai/ }).click()
  await page.getByRole('option', { name: /Stasiun/ }).click()
  await page.getByRole('button', { name: 'Pasangkan sebagai stasiun' }).click()
  const ask = page.getByRole('dialog', { name: /Pasangkan kasir utama sebagai stasiun/ })
  await expect(ask).toContainText('tidak ada kasir utama')
  // A shift opened meanwhile (by the cashier, elsewhere): the server refuses, and the reason is the one told.
  await stack.apply(stack.users.cashier, till, 'shift.open', { id: crypto.randomUUID(), opening: 0 })
  await ask.getByRole('button', { name: /Ya, pasangkan/ }).click()
  await expect(page.getByText('Tutup sif dulu sebelum memasangkan ulang kasir utama')).toBeVisible()
  expect(await stack.sql('select primary_device_id as till from public.restaurants where id = $1', [stack.restaurantId])).toEqual([{ till }])
})
test('STN-08: a station cut off from the server says so', async ({ page, context, stack }) => {
  const { owner, kitchen } = stack.users
  const tablet = await useDevice(context)
  await stack.rpc(owner, 'enroll_device', { device_id: tablet, mode: 'station' }) // as a manager: this is a station tablet
  await signIn(page, kitchen)
  await page.goto('/station')
  await expect(page.getByRole('heading', { name: 'Dapur' })).toBeVisible()
  await expect(page.getByText(/Tidak tersambung ke server/)).toHaveCount(0)
  await stack.offline(true)
  await expect(page.getByText(/Tidak tersambung ke server/)).toBeVisible({ timeout: 25_000 })
  await stack.offline(false)
  await expect(page.getByText(/Tidak tersambung ke server/)).toHaveCount(0, { timeout: 25_000 })
})
