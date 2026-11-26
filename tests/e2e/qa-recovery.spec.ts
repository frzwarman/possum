import { test, expect, signIn, outbox, openShift, addItem, useDevice, cart } from './stack'
import type { Page } from '@playwright/test'
import { demo, openShift as demoShift, addItem as demoAdd } from './meja'
// QA 2026-11-25, cluster recovery. The real app against the real SQL (./stack) for the refused operation; the demo for two windows.
const tick = { timeout: 20_000 }
// Ke stasiun, Bayar, Catat pembayaran: sell() of the helpers, with the wait the pay sheet needs (it ignores a tap in its first 600 ms).
async function sell(page: Page) {
  await cart(page).getByRole('button', { name: /Ke stasiun/ }).click()
  await expect(cart(page).getByText(/Dikirim/)).toBeVisible()
  await cart(page).getByRole('button', { name: /^Bayar Rp/ }).click()
  await page.waitForTimeout(700)
  await page.getByRole('dialog', { name: 'Terima pembayaran' }).getByRole('button', { name: /Catat pembayaran/ }).click()
  await expect(page.getByRole('dialog', { name: 'Pembayaran tercatat' })).toBeVisible()
}

test('AUTH-01, SYNC-01, SYNC-10: a cashier releases a refused operation on the till with the recovery file and a manager PIN', async ({ page, context, stack }) => {
  const { owner, cashier, manager } = stack.users
  const till = await useDevice(context)
  await stack.rpc(owner, 'enroll_device', { device_id: till, mode: 'pos' })
  await signIn(page, cashier)
  await page.goto('/pos')
  await openShift(page)
  await expect.poll(() => outbox(page), tick).toEqual([])
  // The server refuses the payment once (any final answer would do): the order is saved and sent, but not paid.
  stack.fail(c => c.key === 'apply_operation' && (c.args as { operation: { kind: string } }).operation.kind === 'payment.record', { status: 400, code: 'P0001', message: 'EDC required' }, { times: 1 })
  await addItem(page, 'Nasi goreng kampung')
  await sell(page)
  await expect.poll(async () => (await outbox(page)).map(o => o.state), tick).toContain('rejected')
  // The refusal shows on the till itself, in Indonesian.
  await page.goto('/pos')
  await expect(page.getByRole('alert').filter({ hasText: 'Server menolak satu operasi' })).toBeVisible()
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Sinkron & backup' }).click()
  const refused = page.locator('.sync-list > div').filter({ hasText: 'Perlu diperiksa' })
  const [file] = await Promise.all([page.waitForEvent('download'), refused.getByRole('button', { name: 'Buang operasi ini' }).click()])
  expect(file.suggestedFilename()).toBe('takar-pemulihan.json')
  // A cashier needs a manager's PIN.
  const d = page.getByRole('dialog', { name: 'Perlu persetujuan manajer' })
  await d.getByRole('combobox', { name: 'Disetujui oleh' }).click()
  await page.getByRole('option', { name: manager.name }).click()
  await d.getByLabel('PIN persetujuan').fill(manager.approvalPin!)
  await d.getByRole('button', { name: /^Setujui/ }).click()
  await expect.poll(async () => (await outbox(page)).filter(o => o.state === 'rejected').length, tick).toBe(0)
  // The queue is free again and the order, which the server holds unpaid, no longer blocks the till (its local copy is checked in qa-recovery.test.ts).
  await expect.poll(async () => (await outbox(page)).length, tick).toBe(0)
  expect(await stack.sql('select status from public.orders')).toEqual([{ status: 'open' }])
  await page.goto('/pos')
  await expect(page.getByRole('alert').filter({ hasText: 'Server menolak satu operasi' })).toBeHidden()

})

test('TILL-09, SYNC-15: a second window of the same till follows the one cart and cannot sell it twice', async ({ page, context }) => {
  await demo(page)
  await demoShift(page)
  await demoAdd(page, 'Nasi goreng kampung')
  const b = await context.newPage()
  await b.goto('/')
  await expect(cart(b).locator('.cart-line')).toHaveCount(1)
  // A line added in one window shows in the other.
  await demoAdd(page, 'Nasi goreng kampung')
  const total = await cart(page).getByRole('button', { name: /^Bayar Rp/ }).innerText()
  await expect(cart(b).getByRole('button', { name: /^Bayar Rp/ })).toHaveText(total)
  await sell(page)
  // Window A took the money; window B's cart is empty, not payable a second time.
  await expect(cart(b).locator('.cart-line')).toHaveCount(0)
  const paid = await page.evaluate(() => new Promise<number>(res => { const r = indexedDB.databases().then(dbs => { const name = dbs.find(x => x.name?.startsWith('meja-demo'))!.name!; const q = indexedDB.open(name); q.onsuccess = () => { const g = q.result.transaction('orders').objectStore('orders').getAll(); g.onsuccess = () => res(g.result.filter((o: { status: string }) => o.status === 'paid').length) } }); void r }))
  expect(paid).toBe(1)
})
