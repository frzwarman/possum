import type { Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { test, expect, demo, go, openShift, addItem, sell } from './meja'
import { test as stackTest, signIn, makeTill } from './stack'
// QA 2026-11-25, cluster reports: Laporan, Penjualan, Hari ini, Pesanan and Tutup sif read every order they need, not the
// app's newest 500 (RPT-1, CAT-3, TILL-07, PERF-3, PERF-4); compliments are not sales (RPT-2, CAT-4); one Penjualan
// for a day (STN-12, RPT-6); an EDC no longer in settings still closes (RPT-4). Demo mode: the device holds everything.
const rp = (n: number) => 'Rp' + n.toLocaleString('id-ID')
async function db<T>(page: Page, fn: string, arg: unknown = null): Promise<T> {
  return page.evaluate(async ({ fn, arg }) => {
    const name = (await indexedDB.databases()).map((d) => d.name!).find((n) => n.startsWith('meja-demo-'))!
    const handle: IDBDatabase = await new Promise((ok, no) => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error) })
    try { return await (new Function('db', 'arg', 'return (' + fn + ')(db,arg)'))(handle, arg) } finally { handle.close() }
  }, { fn, arg }) as Promise<T>
}
const rows = (page: Page, table: string) => db<any[]>(page, `(db,t)=>new Promise((ok,no)=>{const r=db.transaction(t).objectStore(t).getAll();r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)})`, table)
const put = (page: Page, table: string, items: unknown[]) => db<void>(page, `(db,a)=>new Promise((ok,no)=>{const tx=db.transaction(a.t,'readwrite');for(const i of a.items)tx.objectStore(a.t).put(i);tx.oncomplete=()=>ok();tx.onerror=()=>no(tx.error)})`, { t: table, items })
// One real cash sale through the till; the shift it opened and the sale, to copy.
async function oneSale(page: Page) {
  await demo(page)
  await openShift(page)
  await addItem(page, 'Es teh manis')
  await sell(page)
  await page.keyboard.press('Escape')
  const [order] = await rows(page, 'orders'), [shift] = await rows(page, 'shifts')
  return { order, shift }
}
const copy = (o: any, i: number, edit: Record<string, unknown> = {}) => {
  const at = new Date(Date.now() - (i + 1) * 2000).toISOString(), id = crypto.randomUUID()
  return { ...o, id, receiptId: 'MJ-' + id.toUpperCase(), label: `Pager ${i + 2}`, createdAt: at, updatedAt: at, payment: { ...o.payment, at }, lines: o.lines.map((l: any) => ({ ...l, id: crypto.randomUUID() })), ...edit }
}
const metric = (page: Page, label: string | RegExp) => page.locator('.metric').filter({ hasText: label }).first()

test('RPT-1, CAT-3, PERF-4, RPT-2, CAT-4, STN-12: 600 more orders in one day show in full on Laporan, Penjualan, Hari ini and Pesanan, and compliments are not sales', async ({ page }) => {
  const { order, shift } = await oneSale(page), price = order.totals.total, N = 600
  const extra = Array.from({ length: N }, (_, i) => copy(order, i))
  // A family compliment (free) and a refund of one sale the same day: the refund is listed apart from Penjualan.
  const gift = copy(order, N, { mode: 'compliment', compliment: { kind: 'family', who: 'Rino' }, discount: price, totals: { ...order.totals, discount: price, total: 0 }, payment: { ...order.payment, method: 'none', at: new Date(Date.now() - 5000).toISOString() } })
  const refunded = { ...extra[1], status: 'refunded', refund: { reason: 'Salah pesan', at: new Date().toISOString(), actor: 'demo-owner' } }
  await put(page, 'orders', [...extra.filter((_, i) => i !== 1), refunded, gift])
  await put(page, 'shifts', [{ ...shift, status: 'closed', closedAt: new Date().toISOString(), counted: 0, expected: 0, variance: 0 }])
  const sales = (N + 1) * price // the one real sale, the 600 copies and the refunded one (gross), not the compliment
  await page.goto('/reports')
  await expect(metric(page, 'Penjualan').first()).toContainText(rp(sales))
  await expect(metric(page, 'Penjualan').first()).toContainText(`${N + 1} pesanan lunas`)
  // The export has every order, a Jenis column and the refund time.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Ekspor' }).click()])
  const lines = (await readFile((await download.path())!, 'utf8')).trim().split('\n')
  expect(lines[0]).toContain('Jenis')
  expect(lines[0]).toContain('Waktu refund')
  expect(lines.length).toBe(1 + N + 2)
  expect(lines.filter((l) => l.includes('Keluarga pemilik')).length).toBe(1)
  // Penjualan: the refund and the compliment are out of the net, the compliment is out of the count and the discount.
  await go(page, 'Penjualan')
  await expect(metric(page, 'Penjualan bersih')).toContainText(rp(N * price))
  await expect(metric(page, 'Transaksi')).toContainText(String(N))
  await expect(metric(page, 'Diskon')).toContainText(rp(0))
  // Hari ini counts the same sales (refund apart), not 500 of them.
  await go(page, 'Hari ini')
  await expect(metric(page, 'Penjualan')).toContainText(rp(sales))
  await expect(metric(page, 'Penjualan')).toContainText(`refund ${rp(price)}`)
  // Pesanan: today's line counts every order, and the oldest one is found by its number as printed on the receipt.
  await go(page, 'Pesanan')
  await expect(page.locator('.page-heading .muted')).toContainText(rp(sales))
  const oldest = extra.at(-1)!, no = oldest.receiptId.slice(-6).toUpperCase()
  await page.getByLabel('Cari pesanan').fill('#' + no)
  await expect(page.locator('.orders-table tbody tr')).toHaveCount(1)
  await expect(page.locator('.orders-table .col-no button')).toHaveText(no)
})

test('TILL-07, PERF-3: the close shift screen counts every order of a shift of 511, and an exact slip says Cocok', async ({ page }) => {
  const { order, shift } = await oneSale(page), price = order.totals.total, N = 511
  const [s] = await rows(page, 'settings')
  await put(page, 'settings', [{ ...s, cashless: true, edcs: ['BCA'] }])
  const card = { method: 'card', edc: 'BCA', approvalCode: '123456', tendered: price, change: 0 }
  await put(page, 'orders', [{ ...order, payment: { ...order.payment, ...card } }, ...Array.from({ length: N - 1 }, (_, i) => copy({ ...order, payment: { ...order.payment, ...card } }, i))])
  await put(page, 'counts', [{ id: crypto.randomUUID(), area: 'Bar', status: 'submitted', lines: [], startedBy: 'demo-owner', startedAt: shift.openedAt, submittedAt: new Date().toISOString() }])
  await page.goto('/reports')
  const row = page.locator('.settle-row').filter({ hasText: 'EDC BCA' })
  await expect(row).toContainText(`Takar ${rp(N * price)}`)
  await row.getByLabel('Slip EDC BCA').fill(String(N * price))
  await expect(row).toContainText('Cocok')
  await expect(page.locator('.close-metrics .metric').first()).toContainText(rp(N * price))
})

test('RPT-4: an EDC that took payments but is no longer in settings keeps a working slip field, and the shift closes on it', async ({ page }) => {
  const { order, shift } = await oneSale(page), price = order.totals.total
  const [s] = await rows(page, 'settings')
  await put(page, 'settings', [{ ...s, cashless: true, edcs: ['BCA'] }])
  const card = (edc: string) => ({ ...order.payment, method: 'card', edc, approvalCode: '654321', tendered: price, change: 0 })
  await put(page, 'shifts', [{ ...shift, opening: 0 }]) // a cashless shift has no float
  await put(page, 'orders', [{ ...order, payment: card('BCA') }, copy({ ...order, payment: card('Mandiri') }, 0)])
  await put(page, 'counts', [{ id: crypto.randomUUID(), area: 'Bar', status: 'submitted', lines: [], startedBy: 'demo-owner', startedAt: shift.openedAt, submittedAt: new Date().toISOString() }])
  await page.goto('/reports')
  const mandiri = page.locator('.settle-row').filter({ hasText: 'EDC Mandiri' })
  await mandiri.getByLabel('Slip EDC Mandiri').fill(String(price))
  await expect(mandiri).toContainText('Cocok')
  await page.locator('.settle-row').filter({ hasText: 'EDC BCA' }).getByLabel('Slip EDC BCA').fill(String(price))
  await page.getByRole('button', { name: 'Tutup sif', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Perlu persetujuan manajer' })).toBeHidden()
  await expect.poll(async () => (await rows(page, 'shifts'))[0].status).toBe('closed')
  const closed = (await rows(page, 'shifts'))[0]
  expect(closed.variance).toBe(0)
  expect(closed.settlements.find((x: any) => x.edc === 'Mandiri')).toMatchObject({ slip: price, expected: price })
})

test('RPT-9, RPT-7: an item void shows in Hari ini and in Laporan, and a staff meal paid by card is in Kartu di EDC', async ({ page }) => {
  const { order, shift } = await oneSale(page), price = order.totals.total
  const [s] = await rows(page, 'settings')
  await put(page, 'settings', [{ ...s, cashless: true, edcs: ['BCA'] }])
  const line = { ...order.lines[0], id: crypto.randomUUID(), cancelled: true, voidReason: 'Tumpah', voidApprovedBy: 'Manajer Demo' }
  const withVoid = { ...order, lines: [...order.lines, line], updatedAt: new Date().toISOString() }
  const meal = copy(order, 0, { mode: 'compliment', compliment: { kind: 'staff', who: 'Raka' }, payment: { ...order.payment, method: 'card', edc: 'BCA', tendered: price, change: 0 } })
  await put(page, 'orders', [withVoid, meal])
  await put(page, 'shifts', [{ ...shift, status: 'closed', closedAt: new Date().toISOString(), counted: 0, expected: 0, variance: 0 }])
  await page.goto('/today')
  await expect(page.locator('.need-list')).toContainText('Batal item')
  await page.goto('/reports')
  await expect(page.locator('.audit-list')).toContainText('Batal item')
  await expect(page.locator('.payment-row').filter({ hasText: 'Kartu' })).toContainText(rp(price))
})

test('CAT-7: a delivered catering order\'s ingredients are not counter food cost on Hari ini or Laporan', async ({ page }) => {
  const { order, shift } = await oneSale(page)
  const [item] = await rows(page, 'stock')
  await put(page, 'meta', [{ id: 'costs', value: JSON.stringify({ [item.id]: 10 }) }])
  await put(page, 'shifts', [{ ...shift, status: 'closed', closedAt: new Date().toISOString(), counted: 0, expected: 0, variance: 0 }])
  // One counter sale's ingredients (1.000 at Rp10 = Rp10.000) and a catering delivery's, a thousand times as much.
  await put(page, 'salesOrders', [{ id: 'so-1', number: 'PO-1', status: 'delivered', deliverAt: new Date().toISOString(), payments: [], lines: [], customer: { name: 'Kantor' }, totals: { total: 0 } }])
  const move = (id: string, qty: number, recordId: string) => ({ id, stockId: item.id, qty, kind: 'preparation', reason: 'Uji', actor: 'demo-owner', at: new Date().toISOString(), recordId, cost: 0 })
  await put(page, 'movements', [move('m-counter', -1000, order.id), move('m-so-1', -1_000_000, 'so-1')])
  await page.goto('/today')
  await expect(metric(page, 'Food cost')).toContainText('bahan terpakai Rp10.000')
  await page.goto('/reports')
  await expect(metric(page, 'Food cost')).toContainText('bahan terpakai Rp10.000')
})

// The real app against the real SQL: a signed-in laptop holds only what sign-in gave it (the newest 500 orders), so Laporan
// and the audit log must ask the server for the range.
const tick = { timeout: 20_000 }
stackTest('RPT-1 signed in: a laptop whose sign-in brought 500 of 1.101 orders shows all of them on Laporan and Penjualan', async ({ page, stack }) => {
  const { owner } = stack.users
  await signIn(page, owner)
  await makeTill(page)
  await page.goto('/pos')
  await openShift(page)
  await addItem(page, 'Nasi goreng kampung')
  await sell(page)
  await expect.poll(() => stack.sql('select count(*)::int as n from public.payments'), tick).toEqual([{ n: 1 }])
  await stack.sql(`with g as (select n, gen_random_uuid() as id from generate_series(1,1100) n),
   o as (insert into public.orders(restaurant_id,id,shift_id,actor,revision,status,created_at,updated_at,snapshot)
    select s.restaurant_id,g.id,s.shift_id,s.actor,s.revision,s.status,s.created_at-(g.n||' seconds')::interval,s.updated_at,
     jsonb_set(jsonb_set(s.snapshot,'{id}',to_jsonb(g.id::text)),'{receiptId}',to_jsonb('MJ-'||upper(g.id::text))) from public.orders s cross join g where s.created_at=(select max(created_at) from public.orders) returning id,restaurant_id,actor)
   insert into public.payments(restaurant_id,order_id,operation_id,method,total,tendered,change,verified,occurred_at,received_at,actor)
    select o.restaurant_id,o.id,gen_random_uuid(),p.method,p.total,p.tendered,p.change,p.verified,p.occurred_at,p.received_at,p.actor from o cross join (select * from public.payments limit 1) p`)
  const laptop = await stack.newPage()
  await signIn(laptop, owner)
  await laptop.goto('/reports')
  await expect(metric(laptop, 'Penjualan').first()).toContainText(rp(1101 * 25000), tick)
  await expect(metric(laptop, 'Penjualan').first()).toContainText('1101 pesanan lunas')
  await laptop.goto('/sales')
  await expect(metric(laptop, 'Penjualan bersih')).toContainText(rp(1101 * 25000), tick)
  await expect(metric(laptop, 'Transaksi')).toContainText('1101')
})

stackTest('RPT-5, SQL-06, RPT-11: the audit log loads every entry of a busy range, says how many, and a range over 94 days is refused in words', async ({ page, stack }) => {
  const { owner, cashier } = stack.users
  await stack.sql(`insert into public.sync_operations(id,restaurant_id,actor,device_id,kind,payload,occurred_at,result)
   select gen_random_uuid(),$1,$2,$3,'shift.cash',jsonb_build_object('payload',jsonb_build_object('amount',-1000,'reason','kas '||g)),now()-(g||' seconds')::interval,'{}' from generate_series(1,1200) g`, [stack.restaurantId, cashier.id, stack.office])
  await signIn(page, owner)
  await page.goto('/audit')
  await expect(page.locator('.audit-note')).toContainText(/^12\d\d entri\./, tick) // more than the 1.000 a call returns (the seed adds a few entries of its own)
  await expect(page.locator('.pill-tabs button').first()).toContainText(/Semua\s*12\d\d/)
  await page.getByRole('combobox', { name: 'Periode' }).click()
  await page.getByRole('option', { name: 'Rentang lain' }).click()
  await page.getByLabel('Dari tanggal').fill('2026-01-01')
  await expect(page.locator('p.callout[role=alert]')).toHaveText('Rentang log audit paling lama 94 hari.')
})
