// QA 2026-11-25, cluster till: what the till refuses before it queues anything (TILL-03, TILL-12, CT-09, SQL-16), the pilot's payment that
// sends the lines with it (TILL-04) and keeps working after the 12 hours for cash (TILL-08, decision 15), the receipt's change (TILL-14).
// Server rules are in scripts/db-checks/qa-till.mjs; screens in tests/e2e/qa-till.spec.ts.
import { describe, expect, it } from 'vitest'
import { receiptText } from '../../src/lib/printer'
import { draft, identity, line, seed, tick } from './offline-harness'

const kinds = async (db: Awaited<ReturnType<typeof seed>>['db']) => (await db.outbox.toArray()).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).map((o) => o.kind)
async function till() {
  const s = await seed(identity({ role: 'cashier' }))
  await s.commands.openShift(200000); await tick()
  return s
}

describe('QA till: limits the server enforces are refused on the till', () => {
  it('TILL-03: more than 200 lines never reach the outbox, 200 do', async () => {
    const { commands, db } = await till()
    await expect(commands.save(draft(Array.from({ length: 201 }, () => line())))).rejects.toThrow('Maksimal 200 menu per pesanan')
    expect(await kinds(db)).toEqual(['shift.open'])
    await commands.save(draft(Array.from({ length: 200 }, () => line())))
    expect(await kinds(db)).toEqual(['shift.open', 'order.save'])
  })
  it('TILL-12, CT-09: a label over 100 characters (a pager typed as 95 digits) is refused', async () => {
    const { commands } = await till()
    await expect(commands.save(draft([line()], { label: `Pager ${'7'.repeat(95)}` }))).rejects.toThrow('maksimal 100 karakter')
    await commands.save(draft([line()], { label: `Pager ${'7'.repeat(94)}` }))
  })
  it('SQL-16: a cash movement reason over 300 characters is refused', async () => {
    const { commands } = await till()
    await expect(commands.cashMove(5000, 'x'.repeat(301))).rejects.toThrow('maksimal 300')
    await commands.cashMove(5000, 'x'.repeat(300))
  })
})

describe('QA till: the pilot sends the lines with the payment, and cash may be taken after the 12 hours', () => {
  it('TILL-04: Commands.pay with send queues the prepare then the payment; without send an unsent line is refused', async () => {
    const { commands, db } = await till()
    const o = await commands.save(draft([line()])); await tick()
    await expect(commands.pay(o.id, 'cash', 25000, true)).rejects.toThrow('Kirim ke dapur sebelum pembayaran')
    expect(await kinds(db)).toEqual(['shift.open', 'order.save'])
    const paid = await commands.pay(o.id, 'cash', 25000, true, { send: true })
    expect(await kinds(db)).toEqual(['shift.open', 'order.save', 'order.prepare', 'payment.record'])
    expect([paid.status, paid.lines.every((l) => l.prepared)]).toEqual(['paid', true])
    expect((await db.movements.toArray()).filter((m) => m.kind === 'preparation').length).toBeGreaterThan(0)
  })
  it('TILL-04: a payment that fails its checks sends nothing (a short tender, an unverified card)', async () => {
    const { commands, db } = await till()
    const o = await commands.save(draft([line()])); await tick()
    await expect(commands.pay(o.id, 'cash', 1000, true, { send: true })).rejects.toThrow('Uang diterima kurang')
    await expect(commands.pay(o.id, 'card', 0, false, { edc: 'BCA', send: true })).rejects.toThrow()
    expect(await kinds(db)).toEqual(['shift.open', 'order.save'])
  })
  it('TILL-08: after the shift ran out a tab is paid in cash with its prepare; card and a new save are refused, before anything is queued', async () => {
    const { commands, db } = await till()
    const o = await commands.save(draft([line()])); await tick()
    const shift = (await db.shifts.where('status').equals('open').first())!
    await db.shifts.update(shift.id, { expiresAt: new Date(Date.now() - 60_000).toISOString() })
    await expect(commands.save(draft([line()]))).rejects.toThrow('Otorisasi sif berakhir')
    await expect(commands.pay(o.id, 'card', 0, true, { edc: 'BCA', send: true })).rejects.toThrow('Otorisasi sif berakhir')
    expect(await kinds(db)).toEqual(['shift.open', 'order.save'])
    const paid = await commands.pay(o.id, 'cash', 25000, true, { send: true })
    expect(paid.status).toBe('paid')
    expect(await kinds(db)).toEqual(['shift.open', 'order.save', 'order.prepare', 'payment.record'])
  })
})

describe('QA till: a receipt printed after a void adds up', () => {
  it('TILL-14: change is the tender minus the total as it stands now', async () => {
    const { commands } = await till()
    const o = await commands.save(draft([line(), line({ price: 6000 })])); await tick()
    const paid = await commands.pay(o.id, 'cash', 50000, true, { send: true })
    expect(paid.payment!.change).toBe(50000 - 31000)
    // A line voided afterwards: the order total falls to 25.000, so what goes back is 25.000, not the 19.000 of the payment.
    const after = { ...paid, totals: { ...paid.totals, total: 25000 } }
    expect(receiptText(after)).toContain('Kembalian: Rp25.000')
  })
})
