// QA 2026-11-25, cluster voids: the till's side of what a void does to the bill (CT-02, SQL-08, CT-05, DSC-4, TILL-13), the
// approval a cashier's void is bound to (SEC-1), one trim rule for the reason (CT-04) and the cart following a line void (STN-04).
// The server's side of the same sums is scripts/db-checks/qa-voids.mjs; qa-voids-contract.test.ts runs the till and the real SQL together.
import { describe, expect, it } from 'vitest'
import { afterVoid } from '../../src/domain/calculate'
import { DEMO_PIN } from '../../src/lib/commands'
import type { Discount } from '../../src/domain/types'
import { draft, identity, line, seed, tea, tick } from './offline-harness'

const cashier = () => seed(identity({ role: 'cashier', name: 'Kasir Demo', demo: true }))
const manager = () => seed(identity({ role: 'manager', name: 'Siti', demo: true }))
type Seeded = Awaited<ReturnType<typeof manager>>
// Rings the lines, sends them to the station and (paid) takes cash: the order a void works on.
async function made(s: Seeded, lines = [line(), tea()], over = {}, paid = false) {
  await s.commands.openShift(200000); await tick()
  const o = await s.commands.save(draft(lines, over)); await tick()
  await s.commands.prepare(o.id); await tick()
  if (paid) { await s.commands.pay(o.id, 'cash', 1_000_000, true); await tick() }
  return (await s.db.orders.get(o.id))!
}
const happy = (value: number): Discount => ({ id: 'happy', name: 'Happy hour', note: '', kind: 'percent', value, scope: 'order', from: '2020-01-01', to: '2099-12-31' })

describe('afterVoid: what is left of a discount (old, voided line, subtotal left, the discount\'s own rule on the lines left)', () => {
  it.each([
    ['a voucher under its minimum keeps what the line did not use (CT-02)', [25000, 18000, 96000, 0], 7000],
    ['a percent follows the lines left', [13000, 10000, 120000, 12000], 12000],
    ['a fixed amount that still applies stays', [25000, 18000, 96000, 25000], 25000],
    ['a manual amount without a rule is capped at the subtotal left (TILL-13, DSC-4)', [20000, 25000, 6000, 20000], 6000],
    ['never above the old discount, whatever the rule says', [5000, 10000, 100000, 50000], 5000],
    ['never below 0', [0, 10000, 5000, 0], 0],
  ] as const)('%s', (_, [old, voided, left, own], expected) => { expect(afterVoid(old, voided, left, own)).toBe(expected) })
  it('never raises the guest\'s bill: (subtotal - discount) after is at most before', () => {
    for (const old of [0, 3000, 25000]) for (const voided of [1000, 18000]) for (const own of [0, 7000, 25000]) {
      const before = 114000 - old, after = 114000 - voided - afterVoid(old, voided, 114000 - voided, own)
      expect(after).toBeLessThanOrEqual(before)
    }
  })
})

describe('SEC-1: a cashier\'s void is bound to what the manager saw', () => {
  it('a line void takes only an approval of action voidline for that order, that line and its value', async () => {
    const s = await cashier(), o = await made(s), [rice, drink] = o.lines
    const ask = (action: 'void' | 'voidline', over: Record<string, unknown> = {}) => s.commands.approve('demo-owner', DEMO_PIN, action, { orderId: o.id, lineId: drink.id, amount: drink.price, ...over })
    for (const a of [await ask('void', { lineId: undefined, amount: undefined }), await ask('void', { lineId: undefined }), await ask('voidline', { lineId: rice.id }), await ask('voidline', { amount: drink.price + 1 }), await ask('voidline', { orderId: 'other' })])
      await expect(s.commands.voidLine(o.id, drink.id, 'Salah menu', a)).rejects.toThrow('Perlu persetujuan manajer')
    await s.commands.voidLine(o.id, drink.id, 'Salah menu', await ask('voidline'))
    expect((await s.db.outbox.toArray()).find((x) => x.kind === 'order.voidline')?.payload).toMatchObject({ id: o.id, lineId: drink.id, reason: 'Salah menu' })
  })
  it('a whole-order void takes only an approval for the order\'s total', async () => {
    const s = await cashier(), o = await made(s)
    const ask = (over: Record<string, unknown>) => s.commands.approve('demo-owner', DEMO_PIN, 'void', { orderId: o.id, ...over })
    for (const a of [await ask({}), await ask({ amount: o.totals.total - 1 }), await s.commands.approve('demo-owner', DEMO_PIN, 'voidline', { orderId: o.id, lineId: o.lines[0].id, amount: o.totals.total })])
      await expect(s.commands.voidOrder(o.id, 'Salah meja', a)).rejects.toThrow('Perlu persetujuan manajer')
    await s.commands.voidOrder(o.id, 'Salah meja', await ask({ amount: o.totals.total }))
    expect((await s.db.orders.get(o.id))?.status).toBe('void')
  })
  it('the manager asks for the new forms by PIN: the request names the line and its value', async () => {
    const s = await cashier(), o = await made(s), a = await s.commands.approve('demo-owner', DEMO_PIN, 'voidline', { orderId: o.id, lineId: o.lines[1].id, amount: 6000 })
    expect(a).toMatchObject({ action: 'voidline', orderId: o.id, lineId: o.lines[1].id, amount: 6000 })
  })
})

describe('CT-04: one trim rule', () => {
  it('sends and stores the same reason: JavaScript trim, line breaks and no-break spaces included', async () => {
    const s = await manager(), o = await made(s, [line(), tea()])
    const done = await s.commands.voidLine(o.id, o.lines[1].id, ' Gelas tumpah\n')
    expect(done.lines[1].voidReason).toBe('Gelas tumpah')
    expect((await s.db.outbox.toArray()).find((x) => x.kind === 'order.voidline')?.payload.reason).toBe('Gelas tumpah')
  })
  it('a reason of 300 characters plus a line break is fine; of 301 is not', async () => {
    const s = await manager(), o = await made(s, [line(), tea(), line({ name: 'Mie' })])
    await expect(s.commands.voidLine(o.id, o.lines[1].id, 'x'.repeat(301))).rejects.toThrow('maksimal 300')
    await s.commands.voidLine(o.id, o.lines[1].id, 'x'.repeat(300) + '\n')
  })
})

describe('a void never raises the bill or fails for a discount', () => {
  it('TILL-13: a manual discount larger than what is left is capped at the subtotal left', async () => {
    const s = await manager(), o = await made(s, [line(), tea()], { discount: 20000, discountReason: 'Teman' })
    const done = await s.commands.voidLine(o.id, o.lines[0].id, 'Salah menu')
    expect([done.totals.subtotal, done.discount, done.totals.total]).toEqual([6000, 6000, 0])
  })
  it('DSC-4: a saved amount discount that was deleted keeps its amount, capped, and the line goes', async () => {
    const s = await manager(), voucher: Discount = { id: 'v', name: 'Voucher 20rb', note: '', kind: 'amount', value: 20000, scope: 'order', from: '2020-01-01', to: '2099-12-31' }
    await s.db.settings.update('settings', { discounts: [voucher] })
    const o = await made(s, [line(), tea()], { discountId: 'v', discount: 20000, discountReason: voucher.name })
    await s.db.settings.update('settings', { discounts: [] })
    const done = await s.commands.voidLine(o.id, o.lines[0].id, 'Salah menu')
    expect([done.discount, done.totals.total]).toEqual([6000, 0])
  })
  it('SQL-08, CT-05: a saved discount follows the lines left by the definition the order was sold with, not today\'s', async () => {
    const s = await manager()
    await s.db.settings.update('settings', { discounts: [happy(20)] })
    const o = await made(s, [line(), tea(), line({ name: 'Mie' })], { discountId: 'happy', discount: Math.floor(56000 * 0.2), discountReason: 'Happy hour' }, true)
    expect(o.settings.discounts?.[0].value).toBe(20)
    // The laptop raises it to 50% and the till pulls it; the order keeps the 20% it was paid at.
    await s.db.settings.update('settings', { discounts: [happy(50)] })
    const done = await s.commands.voidLine(o.id, o.lines[1].id, 'Salah menu')
    expect(done.discount).toBe(Math.floor(50000 * 0.2))
  })
  it('a manual discount with a rule follows it; the compliment keeps its own rule', async () => {
    const s = await manager(), rule = { kind: 'percent' as const, value: 10, scope: 'order' as const }
    const o = await made(s, [line(), tea(), line({ name: 'Mie' })], { discountRule: rule, discount: 5600, discountReason: 'Teman' })
    expect((await s.commands.voidLine(o.id, o.lines[1].id, 'Salah menu')).discount).toBe(5000)
    const c = await seed(identity({ role: 'manager', demo: true })), f = await made(c, [line(), tea()], { mode: 'compliment', compliment: { kind: 'staff', who: 'Raka' } })
    expect((await c.commands.voidLine(f.id, f.lines[0].id, 'Salah menu')).discount).toBe(6000)
  })
})

describe('STN-04: the cart follows a line void', () => {
  it('the draft of the order loses the voided line, takes the new revision, and can be saved and paid', async () => {
    const s = await manager(), o = await made(s)
    await s.db.drafts.put({ id: 'current', orderId: o.id, revision: o.revision, label: o.label, mode: o.mode, lines: o.lines, discount: o.discount, discountReason: '' })
    const done = await s.commands.voidLine(o.id, o.lines[1].id, 'Salah menu')
    const d = (await s.db.drafts.get('current'))!
    expect(d.revision).toBe(done.revision)
    expect(d.lines.find((l) => l.id === o.lines[1].id)).toMatchObject({ cancelled: true, voidReason: 'Salah menu' })
    // What the cart shows is what Bayar charges, and the next save is not turned down for the voided line.
    const saved = await s.commands.save({ ...d, lines: d.lines })
    expect(saved.totals.total).toBe(done.totals.total)
  })
  it('a draft that holds unsent lines keeps them, and another order\'s draft is left alone', async () => {
    const s = await manager(), o = await made(s), extra = line({ name: 'Mie' })
    await s.db.drafts.put({ id: 'current', orderId: o.id, revision: o.revision, label: o.label, mode: o.mode, lines: [...o.lines, extra], discount: 0, discountReason: '' })
    await s.commands.voidLine(o.id, o.lines[1].id, 'Salah menu')
    expect((await s.db.drafts.get('current'))!.lines.map((l) => [l.name, Boolean(l.cancelled)])).toEqual([[o.lines[0].name, false], [o.lines[1].name, true], ['Mie', false]])
  })
})
