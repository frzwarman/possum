import { test, expect, signIn, makeTill, outbox, openShift, addItem, sell, cart } from './stack'
// QA 2026-11-25, cluster outbox, through the real app against the real SQL: the till never waits for the network, its
// clock is not trusted, and an expired token is refreshed. Timeouts: a sync waits for the till's 10 s tick at worst.
const tick = { timeout: 30_000 }
const till = async (page: import('@playwright/test').Page, stack: { users: { owner: { email: string; password: string } } }) => { await signIn(page, stack.users.owner); await makeTill(page); await page.goto('/pos'); await openShift(page); await expect.poll(() => outbox(page), tick).toEqual([]) }

test('HARNESS-F1, SYNC-05, STN-10, PERF-1: with the internet down every tap is usable at once, and the sale goes out later', async ({ page, stack }) => {
  test.setTimeout(180_000)
  await till(page, stack)
  stack.offline()
  const bayar = cart(page).getByRole('button', { name: /^Bayar Rp/ }), waits: number[] = []
  for (let i = 0; i < 2; i++) {
    await addItem(page, 'Es teh manis')
    for (const step of ['send', 'bayar', 'catat'] as const) {
      const t = Date.now()
      if (step === 'send') { await cart(page).getByRole('button', { name: /Ke stasiun/ }).click(); await expect(bayar).toBeEnabled({ timeout: 10_000 }) }
      else if (step === 'bayar') { await bayar.click(); await expect(page.getByRole('dialog', { name: 'Terima pembayaran' })).toBeVisible({ timeout: 10_000 }) }
      else { await page.getByRole('dialog', { name: 'Terima pembayaran' }).getByRole('button', { name: /Catat pembayaran/ }).click(); await expect(page.getByRole('dialog', { name: 'Pembayaran tercatat' })).toBeVisible({ timeout: 10_000 }) }
      waits.push(Date.now() - t)
    }
    await page.keyboard.press('Escape')
  }
  expect(Math.max(...waits), `ms per tap: ${waits.join(', ')}`).toBeLessThan(2500)
  stack.heal()
  await expect.poll(() => outbox(page), { timeout: 60_000 }).toEqual([])
  expect(await stack.sql('select count(*)::int as n from public.payments')).toEqual([{ n: 2 }])
})

test('SYNC-02, CT-10, TILL-10: a till whose clock is 10 minutes fast still reaches the server, and says its clock is off', async ({ page, stack }) => {
  test.setTimeout(180_000)
  await page.clock.install({ time: new Date(Date.now() + 600_000) })
  await till(page, stack)
  await addItem(page, 'Es teh manis'); await sell(page)
  await expect.poll(() => outbox(page), tick).toEqual([])
  expect(await stack.sql('select count(*)::int as n from public.payments')).toEqual([{ n: 1 }])
  const [{ ahead }] = await stack.sql<{ ahead: number }>(`select round(extract(epoch from (max(occurred_at) - now())))::int as ahead from public.payments`)
  expect(ahead, 'the payment is dated by the server clock, not the till clock').toBeLessThan(30)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('alert').filter({ hasText: /Jam perangkat ini terlalu cepat/ })).toBeVisible()
})

test('SYNC-03, AUTH-09: a token the server calls expired is refreshed, and the queue goes out', async ({ page, stack }) => {
  test.setTimeout(180_000)
  await till(page, stack)
  stack.expireTokens()
  await addItem(page, 'Es teh manis'); await sell(page)
  await expect.poll(() => outbox(page), tick).toEqual([])
  expect(await stack.sql('select count(*)::int as n from public.payments')).toEqual([{ n: 1 }])
  expect(stack.calls('auth:refresh_token').length).toBeGreaterThan(0)
})

test('HARNESS-01: context.setOffline(true) takes the emulated Supabase offline too', async ({ page, context, stack }) => {
  await signIn(page, stack.users.owner)
  const reach = () => page.evaluate(() => fetch('http://127.0.0.1:54321/auth/v1/health').then(() => 'answered', () => 'failed'))
  await context.setOffline(true)
  expect(await reach()).toBe('failed')
  await context.setOffline(false)
  expect(await reach()).toBe('answered')
})
