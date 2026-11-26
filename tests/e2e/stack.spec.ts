import { test, expect, signIn, makeTill, outbox, openShift, addItem, sell, cart } from './stack'
// The real app against the real SQL (./stack): what a device sends, what the server keeps, what another device sees.
// A sync that finds another one running skips (Web Lock, ifAvailable), so what a tap queued may wait for the till's
// next 10-second tick: server-side checks wait one tick.
const tick = { timeout: 20_000 }

test('the owner pairs the till and sells for cash; the server keeps it and a cashier tablet pulls it', async ({ page, stack }) => {
  const { owner, cashier } = stack.users
  // The cashier's tablet is signed in before the sale, so the order can only reach it through a pull.
  const tablet = await stack.newPage()
  await signIn(tablet, cashier)
  await signIn(page, owner)
  await makeTill(page)
  const till = await page.evaluate(() => localStorage.getItem('meja-device'))
  expect(await stack.sql('select primary_device_id as till from public.restaurants where id = $1', [stack.restaurantId])).toEqual([{ till }])

  await page.goto('/pos')
  await openShift(page)
  await addItem(page, 'Nasi goreng kampung')
  await sell(page)
  await expect.poll(() => stack.sql(`select o.status, (o.snapshot->'totals'->>'total')::int as total, p.method, p.total::int as paid, o.shift_id = s.id as in_shift
    from public.orders o join public.payments p on p.order_id = o.id join public.shifts s on s.closed_at is null`), tick).toEqual([{ status: 'paid', total: 25000, method: 'cash', paid: 25000, in_shift: true }])
  // The rice went out of stock on the server: 100 g per plate.
  expect(await stack.sql(`select sum(qty)::int as qty from public.stock_movements where stock_id = 'rice' and kind <> 'opening'`)).toEqual([{ qty: -100000 }])
  await expect.poll(() => outbox(page), tick).toEqual([])

  const sold = Date.now(), [{ no }] = await stack.sql<{ no: string }>(`select upper(right(snapshot->>'receiptId', 6)) as no from public.orders`)
  await tablet.goto('/orders')
  await expect(tablet.locator('.order-row').filter({ hasText: no })).toBeVisible(tick)
  expect(stack.calls('pull').some(c => c.user === cashier.id && c.at > sold && c.status === 200)).toBe(true)
  expect(stack.calls('bootstrap').filter(c => c.user === cashier.id).every(c => c.at < sold)).toBe(true)
})

test('a wrong password shows the app\'s error; signing out ends the session on this device', async ({ page, stack }) => {
  const { cashier } = stack.users
  await page.goto('/')
  await page.getByLabel('Email staf').fill(cashier.email)
  await page.getByLabel('Kata sandi').fill('000000')
  await page.getByRole('button', { name: /Masuk ke restoran/ }).click()
  await expect(page.getByRole('alert')).toHaveText('Email atau kata sandi salah, atau akun tidak aktif') // AUTH-11: in Indonesian
  expect(stack.calls('auth:password').map(c => c.status)).toEqual([400])
  await expect(page.getByLabel('Email staf')).toBeVisible()

  await signIn(page, cashier)
  await page.goto('/settings')
  await page.locator('.account-footer').getByRole('button', { name: /Keluar akun/ }).click()
  await page.getByRole('dialog', { name: 'Keluar akun?' }).getByRole('button', { name: 'Keluar akun' }).click()
  // The device keeps the team, so the next person picks their name.
  await expect(page.getByRole('heading', { name: 'Siapa yang bertugas hari ini?' })).toBeVisible()
  expect(stack.calls('auth:logout').map(c => [new URL(c.url).searchParams.get('scope'), c.status])).toEqual([['local', 204]])
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.endsWith('-auth-token') || k === 'meja-identity'))).toEqual([])
})

test('an order the server refuses stays on the till, holds back what follows it, and is shown for the owner to resolve', async ({ page, stack }) => {
  const { owner, manager } = stack.users
  await signIn(page, owner)
  await makeTill(page)
  await page.goto('/pos')
  // The manager's laptop turns on 10% tax while the till cannot pull, and only then does the till open its shift: the server
  // accepts a copy replaced during a shift (HARNESS-F2) but not one replaced before it, so the till rings the order with its old copy.
  stack.fail('pull', 'network', { times: Infinity })
  await stack.apply(manager, stack.office, 'settings.update', { settings: { ...stack.settings, taxBps: 1000 } })
  await openShift(page)
  await expect.poll(() => outbox(page), tick).toEqual([])
  const sent = stack.calls('apply_operation').length
  await addItem(page, 'Nasi goreng kampung')
  // sell(), with the cashier closing the refusal notice the first send raises (it sits over the Bayar button).
  await cart(page).getByRole('button', { name: /Ke stasiun/ }).click()
  await page.getByRole('button', { name: 'Tutup pesan kesalahan' }).click()
  await cart(page).getByRole('button', { name: /^Bayar Rp/ }).click()
  await page.getByRole('dialog', { name: 'Terima pembayaran' }).getByRole('button', { name: /Catat pembayaran/ }).click()
  await expect(page.getByRole('dialog', { name: 'Pembayaran tercatat' })).toBeVisible()
  // The first order.save is refused; the station ticket and the payment behind it wait (the pay sheet sends the ticket and the payment, no second save).
  await expect.poll(async () => (await outbox(page)).map(o => [o.kind, o.state]), tick).toEqual([['order.save', 'rejected'], ['order.prepare', 'pending'], ['payment.record', 'pending']])
  stack.heal()

  await page.goto('/settings')
  await page.getByRole('button', { name: 'Sinkron & backup' }).click()
  const queue = page.locator('.sync-list > div'), refused = queue.filter({ hasText: 'Perlu diperiksa' })
  await expect(refused).toHaveCount(1)
  await expect(refused).toContainText('order.save')
  await expect(refused).toContainText('Invalid initial snapshot')
  await expect(refused.getByRole('button', { name: 'Buang operasi ini' })).toBeVisible()
  await expect(queue.filter({ hasText: 'Belum tersinkron' })).toHaveCount(2)
  // One try for the refused order; nothing queued after it went out, before or after the reload.
  expect(stack.calls('apply_operation').slice(sent).map(c => [(c.args as { operation: { kind: string } }).operation.kind, c.status])).toEqual([['order.save', 400]])
  expect(await stack.sql('select count(*)::int as n from public.orders')).toEqual([{ n: 0 }])
})
