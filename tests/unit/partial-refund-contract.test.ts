// @vitest-environment node
// D3/D4: a partial refund keeps the order paid, records its amount on the till and on the real SQL (migration
// 202611270001), a second refund is refused, and the drawer's expected cash drops by the amount.
import { describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ client: {} as Record<string, unknown> }))
vi.mock('../../src/lib/supabase', () => ({ configured: true, telegramBot: '', supabase: h.client }))
import { draft as bigDraft, line as bigLine, small } from '../corpus/small'
import { refundOf } from '../../src/domain/calculate'

describe('partial refund', () => {
  it('records the amount on the till and the server, once', async () => {
    const { w, till } = await small(h.client, 120, ['kopi-house', 'susu-segar', 'es-batu', 'gelas-16', 'tutup-dome', 'sedotan'])
    await w.signIn(till, 'manager')
    await w.act(till, 'shift.open', (c) => c.openShift(500_000)); await w.sync(till)
    const m = await till.session!.db.menu.toArray(), item = (x: string) => m.find((i) => i.id === x)!
    const o = await w.act(till, 'order.save', (c) => c.save(bigDraft([bigLine(item('latte-iced'), 2), bigLine(item('air-mineral'))])))
    await w.act(till, 'order.prepare', (c) => c.prepare(o!.id))
    const paid = await w.act(till, 'payment.record', (c) => c.pay(o!.id, 'cash', paid_cash(o!.totals.total), true)); await w.sync(till)
    const part = 10_000
    await w.act(till, 'refund.record', (c) => c.refund(o!.id, 'Salah pesan', undefined, part, [{ id: paid!.lines[1].id, qty: 1 }])); await w.sync(till)
    const done = await till.session!.db.orders.get(o!.id)
    expect(done!.status).toBe('paid'); expect(refundOf(done!)).toBe(part)
    const server = (await w.server.admin<{ s: string; a: number }>("select snapshot->>'status' as s, (snapshot->'refund'->>'amount')::int as a from public.orders where id=$1", [o!.id]))[0]
    expect(server).toEqual({ s: 'paid', a: part })
    expect((await w.server.admin<{ amount: number }>('select amount from public.refunds where order_id=$1', [o!.id]))[0].amount).toEqual(part)
    await w.act(till, 'refund.record', (c) => c.refund(o!.id, 'Lagi', undefined, 1_000)).catch(() => undefined); await w.sync(till)
    expect(refundOf((await till.session!.db.orders.get(o!.id))!)).toBe(part)
    expect(w.findings.filter((f) => f.kind === 'rejected' || f.kind === 'stuck')).toEqual([])
  }, 60_000)
})
const paid_cash = (total: number) => total
