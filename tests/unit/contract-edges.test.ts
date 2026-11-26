// @vitest-environment node
// Contract edges the two weeks of tests/unit/contract.test.ts do not reach by chance: each scenario builds a small
// Ziggy (tests/corpus/small.ts) on the real migrations, drives the real Commands and syncs with the real synchronize().
// A test that fails here is an app defect: it stays in, failing, until the app is fixed.
import { afterEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ client: {} as Record<string, unknown> }))
vi.mock('../../src/lib/supabase', () => ({ configured: true, telegramBot: '', supabase: h.client }))
import { ADVERSARIAL } from '../corpus/catalog'
import { balance, draft, line, small } from '../corpus/small'
import type { Finding, World } from '../corpus/world'

afterEach(() => vi.useRealTimers())
const problems = (w: World) => w.findings.filter((f) => f.kind === 'rejected' || f.kind === 'stuck').map((f) => `${f.what}: ${f.detail}`)
const T = 60_000

describe('contract edges', () => {
  it('a count approved after later sales leaves the stock those sales used out', async () => {
    const { w, z, till, laptop } = await small(h.client, 101, ['susu-segar', 'kopi-house', 'es-batu', 'gelas-16', 'tutup-dome', 'sedotan'])
    await w.act(till, 'shift.open', (c) => c.openShift(500_000)); await w.sync(till)
    // 15:40 Siti counts the bar fridge before closing: exactly what the books say.
    const counted = await balance(w, z.id, 'susu-segar'), id = crypto.randomUUID()
    await w.act(till, 'count.submit', (c) => c.submitCount({ id, area: 'Kulkas bar', lines: [{ stockId: 'susu-segar', counted }] })); await w.sync(till)
    // An iced latte (150 ml fresh milk) sells after the count.
    const latte = (await till.session!.db.menu.get('latte-iced'))!, o = await w.act(till, 'order.save', (c) => c.save(draft([line(latte)])))
    await w.act(till, 'order.prepare', (c) => c.prepare(o!.id)); await w.act(till, 'payment.record', (c) => c.pay(o!.id, 'cash', 50_000, true)); await w.sync(till)
    // Next morning the manager approves the count on the laptop, as the pilot PRD has him review the day.
    w.advance(10 * 60 * T)
    await w.signIn(laptop, 'manager')
    const c = (await laptop.session!.db.counts.get(id))!
    await w.act(laptop, 'count.record', (x) => x.recordCount({ id, area: c.area, lines: c.lines })); await w.sync(laptop)
    expect(problems(w)).toEqual([])
    // The fridge held `counted` at the count; the latte took 150 ml after it.
    expect(await balance(w, z.id, 'susu-segar')).toBe(counted - 150_000)
  }, 60_000)

  it('a catering order delivered after its recipe changed moves the same stock on the laptop as on the server', async () => {
    const { w, z, laptop } = await small(h.client, 102, ['fries', 'minyak', 'saus-tomat', 'cup-saus', 'garam'])
    await w.signIn(laptop, 'manager')
    const fries = (await laptop.session!.db.menu.get('fries'))!
    const so = await w.act(laptop, 'salesorder.save', (c) => c.saveSalesOrder({ customer: { name: 'PT Uji', phone: '', address: '' }, deliverAt: '2026-11-03T05:00:00.000Z', lines: [{ id: crypto.randomUUID(), itemId: 'fries', name: fries.name, qty: 10, price: 25_000, catalogVersion: fries.version }], discount: 0, note: '' }))
    await w.sync(laptop)
    // The chef salts the fries from now on: version 2 adds 2 g of salt.
    await w.signIn(laptop, 'chef')
    const menu = await laptop.session!.db.menu.toArray(), stock = await laptop.session!.db.stock.toArray()
    await w.act(laptop, 'catalog.publish', (c) => c.publish(menu.map((m) => (m.id === 'fries' ? { ...m, version: 2, recipe: [...m.recipe, { stockId: 'garam', qty: 2000 }] } : m)), stock)); await w.sync(laptop)
    // The manager delivers the order the next day, from the laptop that now holds version 2.
    w.advance(20 * 60 * T)
    await w.signIn(laptop, 'manager')
    await w.act(laptop, 'salesorder.deliver', (c) => c.deliverSalesOrder(so!.id)); await w.sync(laptop)
    expect(problems(w)).toEqual([])
    const local = (await laptop.session!.db.movements.where('stockId').equals('garam').toArray()).reduce((n, m) => n + m.qty, 0)
    expect({ garam: local }).toEqual({ garam: await balance(w, z.id, 'garam') })
  }, 60_000)

  it('a drawer payment the laptop offers while the manager runs the till is accepted', async () => {
    const { w, till, laptop } = await small(h.client, 103, ['kopi-house'])
    // The cashier is off: the manager opens the till himself, then takes a catering down payment in cash at the laptop.
    await w.signIn(till, 'manager')
    await w.act(till, 'shift.open', (c) => c.openShift(500_000)); await w.sync(till)
    await w.signIn(laptop, 'manager')
    const latte = (await laptop.session!.db.menu.get('latte'))!
    const so = await w.act(laptop, 'salesorder.save', (c) => c.saveSalesOrder({ customer: { name: 'Arisan Bu Ani', phone: '0812', address: '' }, deliverAt: '2026-11-03T05:00:00.000Z', lines: [{ id: crypto.randomUUID(), itemId: 'latte', name: latte.name, qty: 20, price: 30_000, catalogVersion: latte.version }], discount: 0, note: '' }))
    // Catering.tsx offers "Tunai ke laci kas sif aktif" whenever a shift is open; Commands.shift() passes (it is his).
    const paid = await w.act(laptop, 'salesorder.pay (laci)', (c) => c.paySalesOrder(so!.id, 200_000, 'drawer'))
    expect(paid).toBe(true)
    await w.sync(laptop)
    expect(problems(w)).toEqual([])
  }, 60_000)

  it('a line voided with a reason ending in a new line can be followed by a re-save of the order', async () => {
    // Bar and kitchen tablets on: lines are sent before payment, so a made line can come off an open order.
    const { w, till } = await small(h.client, 104, ['kopi-house', 'susu-segar', 'es-batu', 'gelas-16', 'tutup-dome', 'sedotan', 'roti-bakar'], { stationTablets: true })
    await w.signIn(till, 'manager')
    await w.act(till, 'shift.open', (c) => c.openShift(500_000)); await w.sync(till)
    const m = await till.session!.db.menu.toArray(), latte = m.find((x) => x.id === 'latte-iced')!, americano = m.find((x) => x.id === 'americano-iced')!, toast = m.find((x) => x.id === 'roti-bakar')!
    const o = await w.act(till, 'order.save', (c) => c.save(draft([line(latte), line(americano)])))
    const sent = await w.act(till, 'order.prepare', (c) => c.prepare(o!.id)); await w.sync(till)
    // The reason box on Pesanan is a textarea: Enter leaves a line break at the end.
    const voided = await w.act(till, 'order.voidline', (c) => c.voidLine(o!.id, sent!.lines[0].id, 'Gelas tumpah\n'))
    // A moment later the guest adds toast; the till has not pulled yet (it pulls every 10 s).
    await w.act(till, 'order.save (re-save)', (c) => c.save({ id: 'current', orderId: o!.id, revision: voided!.revision, label: 'Pager 1', mode: 'dinein', lines: [...voided!.lines, line(toast)], discount: 0, discountReason: '' }))
    await w.sync(till)
    expect(problems(w)).toEqual([])
  }, 60_000)

  it('a NUL character in a note is refused or rejected, never left retrying in the outbox', async () => {
    // Pasted text can carry control characters; Postgres cannot store \u0000 in jsonb (22P05).
    const { w, till } = await small(h.client, 105, ['kopi-house'])
    await w.act(till, 'shift.open', (c) => c.openShift(500_000)); await w.sync(till)
    const esp = (await till.session!.db.menu.get('espresso'))!
    const saved = await w.act(till, 'order.save', (c) => c.save(draft([line(esp, 1, [], 'Tanpa gula\u0000')])))
    const other = await w.act(till, 'order.save', (c) => c.save(draft([line(esp)], { label: 'Pager 2' })))
    for (let i = 0; i < 6; i++) { await w.sync(till); w.advance(6 * T) }
    const left = await till.session!.db.outbox.where('state').equals('pending').toArray()
    // Either the till keeps it (the command refused it) or the server answers once; nothing waits forever behind it.
    expect({ saved: Boolean(saved), other: Boolean(other), waiting: left.map((o) => `${o.kind} attempts ${o.attempts}: ${o.error}`) }).toEqual({ saved: Boolean(saved), other: true, waiting: [] })
  }, 60_000)

  it('a pager number typed as a long run of digits is accepted (Pos.tsx stores "Pager " + digits)', async () => {
    const { w, till } = await small(h.client, 106, ['kopi-house'])
    await w.act(till, 'shift.open', (c) => c.openShift(500_000)); await w.sync(till)
    const esp = (await till.session!.db.menu.get('espresso'))!
    // The field takes 100 characters; digits only become "Pager <digits>", 106 characters.
    await w.act(till, 'order.save', (c) => c.save(draft([line(esp)], { label: `Pager ${'1'.repeat(100)}` })))
    await w.sync(till)
    expect(problems(w)).toEqual([])
  }, 60_000)

  it("the server's best sellers (Telegram morning report) count what was sold, not compliments", async () => {
    const { w, till } = await small(h.client, 109, ['kopi-house', 'cup-panas-8'])
    await w.act(till, 'shift.open', (c) => c.openShift(500_000)); await w.sync(till)
    const m = await till.session!.db.menu.toArray(), esp = m.find((x) => x.id === 'espresso')!, kopi = m.find((x) => x.id === 'kopi-tubruk')!
    // The owner's family has six espressos on the house; one guest buys a kopi tubruk.
    const fam = await w.act(till, 'order.save', (c) => c.save(draft([line(esp, 6)], { mode: 'compliment', compliment: { kind: 'family', who: 'Ibu Linda' } })))
    await w.act(till, 'order.prepare', (c) => c.prepare(fam!.id)); await w.act(till, 'payment.record', (c) => c.pay(fam!.id, 'none', 0, true))
    const sold = await w.act(till, 'order.save', (c) => c.save(draft([line(kopi)], { label: 'Pager 2' })))
    await w.act(till, 'order.prepare', (c) => c.prepare(sold!.id)); const paid = await w.act(till, 'payment.record', (c) => c.pay(sold!.id, 'cash', 50_000, true)); await w.sync(till)
    const r = await w.call(w.staff('ziggy', 'manager'), 'sales_report', { from_day: '2026-11-02', to_day: '2026-11-02' })
    // Laporan's own best sellers (Reports.tsx) read only sales; compliments are "not counted as sales" (cashless PRD).
    expect({ sales: r.sales, transactions: r.transactions, bestSellers: r.bestSellers }).toEqual({ sales: paid!.totals.total, transactions: 1, bestSellers: [{ name: kopi.name, quantity: 1 }] })
  }, 60_000)

  it('voiding a line never raises what a paid order costs (a voucher with a minimum spend)', async () => {
    const { w, till } = await small(h.client, 110, ['kopi-house', 'susu-segar', 'es-batu', 'gelas-16', 'tutup-dome', 'sedotan', 'sirup-karamel'])
    await w.signIn(till, 'manager')
    await w.act(till, 'shift.open', (c) => c.openShift(500_000)); await w.sync(till)
    const m = await till.session!.db.menu.toArray(), item = (id: string) => m.find((x) => x.id === id)!
    // Rp114.000 of drinks with the Rp25.000 voucher (minimum spend Rp100.000), paid on the EDC.
    const lines = [line(item('latte-iced'), 2), line(item('air-mineral')), line(item('espresso')), line(item('kopi-tubruk'))]
    const o = await w.act(till, 'order.save', (c) => c.save(draft(lines, { discountId: 'voucher-25', discount: 25_000, discountReason: 'Voucher Rp25.000' })))
    await w.act(till, 'order.prepare', (c) => c.prepare(o!.id))
    const paid = await w.act(till, 'payment.record', (c) => c.pay(o!.id, 'card', 0, true, { edc: 'BCA' }))
    // The espresso (Rp18.000) is dropped and comes off the bill, the manager approving it himself.
    await w.act(till, 'order.voidline', (c) => c.voidLine(o!.id, paid!.lines.find((l) => l.itemId === 'espresso')!.id, 'Gelas jatuh'))
    await w.sync(till)
    const after = (await w.server.admin<{ t: { total: number } }>("select snapshot->'totals' as t from public.orders where id=$1", [o!.id]))[0].t
    expect(problems(w)).toEqual([])
    // Taking an item off can only lower the bill: the guest is owed the difference, never asked for more.
    expect(after.total).toBeLessThanOrEqual(paid!.totals.total)
  }, 60_000)

  it('a line voided after the manager changed a saved discount keeps the rate the order was paid at', async () => {
    const { w, till, laptop } = await small(h.client, 111, ['kopi-house', 'susu-segar', 'es-batu', 'gelas-16', 'tutup-dome', 'sedotan'])
    await w.act(till, 'shift.open', (c) => c.openShift(500_000)); await w.sync(till)
    const m = await till.session!.db.menu.toArray(), latte = m.find((x) => x.id === 'latte-iced')!, ame = m.find((x) => x.id === 'americano-iced')!
    // Happy hour, 20% off drinks, paid in cash.
    const o = await w.act(till, 'order.save', (c) => c.save(draft([line(latte), line(ame)], { discountId: 'happy-hour', discount: Math.floor(((latte.price + ame.price) * 20) / 100), discountReason: 'Happy hour minuman 20%' })))
    await w.act(till, 'order.prepare', (c) => c.prepare(o!.id))
    const paid = await w.act(till, 'payment.record', (c) => c.pay(o!.id, 'cash', 100_000, true)); await w.sync(till)
    // The manager raises happy hour to 25% on the laptop; the till pulls it.
    await w.signIn(laptop, 'manager')
    const s = (await laptop.session!.db.settings.get('settings'))!
    await w.act(laptop, 'settings.update', (c) => c.settings({ ...s, discounts: s.discounts!.map((d) => (d.id === 'happy-hour' ? { ...d, value: 25 } : d)) })); await w.sync(laptop); await w.sync(till)
    // The americano is voided (manager's PIN at the till).
    const gone = paid!.lines.find((l) => l.itemId === 'americano-iced')!
    const a = await w.approve(till, 'manager', 'voidline', { orderId: o!.id, lineId: gone.id, amount: gone.price })
    const done = await w.act(till, 'order.voidline', (c) => c.voidLine(o!.id, gone.id, 'Salah buat', a)); await w.sync(till)
    expect(problems(w)).toEqual([])
    // The latte left was sold at 20% off; the discount on it must stay 20%, not become 25%, on the till and the server.
    const server = (await w.server.admin<{ d: string }>("select snapshot->>'discount' as d from public.orders where id=$1", [o!.id]))[0].d
    expect({ till: done!.totals.discount, server: Number(server) }).toEqual({ till: Math.floor((latte.price * 20) / 100), server: Math.floor((latte.price * 20) / 100) })
  }, 60_000)

  it('a till whose clock runs three minutes fast still syncs', async () => {
    const { w, till } = await small(h.client, 107, ['kopi-house'])
    // The tablet's clock is set by hand, 3 minutes ahead of the server.
    const real = w.now
    vi.setSystemTime(real + 3 * T)
    await till.session!.commands.openShift(500_000)
    vi.setSystemTime(real); w.now = real
    await w.sync(till)
    expect(problems(w)).toEqual([])
  }, 60_000)

  it('every free-text field the commands take carries adversarial text to the server unchanged, or is refused on the device', async () => {
    const { w, z, till, laptop, dago } = await small(h.client, 108, ['kopi-house', 'susu-segar', 'es-batu', 'gelas-16', 'tutup-dome', 'sedotan', 'cup-panas-8', 'tutup-panas', 'air-galon'])
    const bad: string[] = [], refused: string[] = []
    const values = [...ADVERSARIAL, '  spasi di tepi  ', ' nbsp ', '​zero width', '😀'.repeat(15)]
    await w.signIn(laptop, 'manager')
    await w.act(till, 'shift.open', (c) => c.openShift(500_000)); await w.sync(till)
    const esp = (await till.session!.db.menu.get('espresso'))!, ame = (await till.session!.db.menu.get('americano'))!
    // One probe per field: the command, run with that text, on the device that would run it.
    type Probe = [string, (v: string) => Promise<unknown>]
    const tillProbes: Probe[] = [
      ['order label', (v) => w.act(till, 'label', (c) => c.save(draft([line(esp)], { label: v })))],
      ['guest name', (v) => w.act(till, 'name', (c) => c.save(draft([line(esp)], { name: v })))],
      ['line note', (v) => w.act(till, 'note', (c) => c.save(draft([line(esp, 1, [], v)])))],
      ['compliment for', (v) => w.act(till, 'who', (c) => c.save(draft([line(esp)], { mode: 'compliment', compliment: { kind: 'staff', who: v } })))],
      ['approval code', async (v) => { const o = await w.act(till, 'o', (c) => c.save(draft([line(esp)]))); await w.act(till, 'p', (c) => c.prepare(o!.id)); return w.act(till, 'approval code', (c) => c.pay(o!.id, 'card', 0, true, { edc: 'BCA', approvalCode: v })) }],
      ['void reason', async (v) => { const o = await w.act(till, 'o', (c) => c.save(draft([line(esp)]))); const a = await w.approve(till, 'manager', 'void', { orderId: o!.id, amount: o!.totals.total }); return w.act(till, 'void reason', (c) => c.voidOrder(o!.id, v, a)) }],
      ['void line reason', async (v) => { const o = await w.act(till, 'o', (c) => c.save(draft([line(esp), line(ame)]))); const p = await w.act(till, 'p', (c) => c.prepare(o!.id)); await w.act(till, 'pay', (c) => c.pay(o!.id, 'cash', 100_000, true)); const l0 = p!.lines[0], a = await w.approve(till, 'manager', 'voidline', { orderId: o!.id, lineId: l0.id, amount: l0.price * l0.qty }); return w.act(till, 'void line reason', (c) => c.voidLine(o!.id, p!.lines[0].id, v, a)) }],
      ['refund reason', async (v) => { const o = await w.act(till, 'o', (c) => c.save(draft([line(esp)]))); await w.act(till, 'p', (c) => c.prepare(o!.id)); await w.act(till, 'pay', (c) => c.pay(o!.id, 'cash', 100_000, true)); const a = await w.approve(till, 'manager', 'refund', { orderId: o!.id }); return w.act(till, 'refund reason', (c) => c.refund(o!.id, v, a)) }],
      ['waste reason', (v) => w.act(till, 'waste reason', (c) => c.stockRecord('es-batu', 'waste', 1000, v))],
      ['cash in reason', (v) => w.act(till, 'cash reason', (c) => c.cashMove(10_000, v))],
      ['count area', (v) => w.act(till, 'count area', (c) => c.submitCount({ id: crypto.randomUUID(), area: v, lines: [{ stockId: 'es-batu', counted: 1000 }] }))],
      ['count line reason', (v) => w.act(till, 'count reason', (c) => c.submitCount({ id: crypto.randomUUID(), area: 'Kulkas bar', lines: [{ stockId: 'es-batu', counted: 1000, reason: v }] }))],
    ]
    const laptopProbes: Probe[] = [
      ['supplier name', (v) => w.act(laptop, 'supplier name', (c) => c.saveSupplier({ id: crypto.randomUUID(), name: v, phone: '', address: '', note: '', active: true }))],
      ['supplier address', (v) => w.act(laptop, 'supplier address', (c) => c.saveSupplier({ id: crypto.randomUUID(), name: 'PT Uji', phone: '', address: v, note: v, active: true }))],
      ['purchase supplier and note', (v) => w.act(laptop, 'po', (c) => c.savePurchase({ supplier: v, note: v, lines: [{ stockId: 'es-batu', qty: 10_000_000, cost: 15_000 }] }))],
      ['purchase cancel reason', async (v) => { const po = await w.act(laptop, 'po', (c) => c.savePurchase({ supplier: 'PT Es', note: '', lines: [{ stockId: 'es-batu', qty: 10_000_000, cost: 15_000 }] })); return w.act(laptop, 'po cancel', (c) => c.cancelPurchase(po!.id, v)) }],
      ['production note', (v) => w.act(laptop, 'production note', (c) => c.produce('cold-brew', 2_000_000, [{ stockId: 'kopi-house', qty: 200_000 }, { stockId: 'air-galon', qty: 2_200_000 }], v))],
      ['catering customer and note', (v) => w.act(laptop, 'so', (c) => c.saveSalesOrder({ customer: { name: v, phone: '', address: v }, deliverAt: '2026-11-03T05:00:00.000Z', lines: [{ id: crypto.randomUUID(), itemId: 'espresso', name: esp.name, qty: 2, price: 15_000, catalogVersion: esp.version }], discount: 0, note: v }))],
      ['catering cancel reason', async (v) => { const so = await w.act(laptop, 'so', (c) => c.saveSalesOrder({ customer: { name: 'PT Uji', phone: '', address: '' }, deliverAt: '2026-11-03T05:00:00.000Z', lines: [{ id: crypto.randomUUID(), itemId: 'espresso', name: esp.name, qty: 2, price: 15_000, catalogVersion: esp.version }], discount: 0, note: '' })); return w.act(laptop, 'so cancel', (c) => c.cancelSalesOrder(so!.id, v)) }],
      ['purchase reason (stock.record)', (v) => w.act(laptop, 'purchase reason', (c) => c.stockRecord('es-batu', 'purchase', 5_000_000, v, 10_000))],
      ['transfer note', (v) => w.act(laptop, 'transfer note', (c) => c.sendTransfer({ id: dago.id, name: dago.name }, [{ stockId: 'es-batu', qty: 1000 }], v))],
      ['menu and bahan names', async (v) => { const m = await laptop.session!.db.menu.toArray(), s = await laptop.session!.db.stock.toArray(); return w.act(laptop, 'publish', (c) => c.publish(m.map((x) => (x.id === 'espresso' ? { ...x, version: x.version + 1, name: v || 'x', tags: [v], aliases: [v] } : x)), s.map((x) => (x.id === 'es-batu' ? { ...x, name: v || 'x', area: v, aliases: [v], packs: [{ name: v.slice(0, 30) || 'p', qty: 1000 }] } : x)))) }],
    ]
    // Each field gets every value, then one sync: a rejection names the operation and carries its payload.
    for (const [field, run] of [...tillProbes, ...laptopProbes]) {
      const before = w.findings.length
      for (const v of values) { const n = w.findings.length; await run(v); for (const f of w.findings.slice(n)) refused.push(`${field} ${JSON.stringify(v)}: ${f.what} — ${f.detail}`) }
      await w.sync(tillProbes.some((p) => p[0] === field) ? till : laptop)
      for (const f of w.findings.slice(before) as Finding[]) if (f.kind !== 'refused') bad.push(`${field}: ${f.kind} ${f.what} — ${f.detail} — ${JSON.stringify(f.op?.payload).slice(0, 300)}`)
    }
    // Stored as typed: an order note, a supplier name, a bahan name.
    const notes = (await w.server.admin<{ n: string }>("select l.snapshot->>'note' as n from public.order_lines l where l.restaurant_id=$1", [z.id])).map((r) => r.n)
    for (const v of values) if (!notes.includes(v)) bad.push(`line note ${JSON.stringify(v)} not stored as typed`)
    // A refusal on the device is the app protecting its queue; only what the server turned down, or left waiting, fails.
    expect({ bad, refused: refused.length }).toEqual({ bad: [], refused: refused.length })
  }, 240_000)
})
