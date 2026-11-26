// @vitest-environment node
// QA 2026-11-25, cluster voids: the till (Commands.voidLine) and the real SQL (public.apply_operation through the migrations)
// give the same bill after a void, for the cases the verifiers reproduced (CT-02, CT-05). Run apart from qa-voids.test.ts, which is jsdom.
import { describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ client: {} as Record<string, unknown> }))
vi.mock('../../src/lib/supabase', () => ({ configured: true, telegramBot: '', supabase: h.client }))
import { draft as bigDraft, line as bigLine, small } from '../corpus/small'

describe('the till and the real server give the same bill after a void', () => {
  // Cases fed to the till (Commands.voidLine) and to public.apply_operation through the real migrations.
  it.each([
    ['a voucher with a minimum spend, paid on the EDC (CT-02)', 'voucher-25', 25_000],
    ['a happy hour the laptop raised after the sale (CT-05)', 'happy-hour', undefined],
  ] as const)('%s', async (_, id, amount) => {
    const { w, till, laptop } = await small(h.client, id === 'voucher-25' ? 110 : 111, ['kopi-house', 'susu-segar', 'es-batu', 'gelas-16', 'tutup-dome', 'sedotan'])
    await w.signIn(till, 'manager')
    await w.act(till, 'shift.open', (c) => c.openShift(500_000)); await w.sync(till)
    const m = await till.session!.db.menu.toArray(), item = (x: string) => m.find((i) => i.id === x)!
    const lines = id === 'voucher-25' ? [bigLine(item('latte-iced'), 2), bigLine(item('air-mineral')), bigLine(item('espresso')), bigLine(item('kopi-tubruk'))] : [bigLine(item('latte-iced')), bigLine(item('americano-iced'))]
    const sub = lines.reduce((n, l) => n + l.price * l.qty, 0), discount = amount ?? Math.floor(sub * 0.2)
    const o = await w.act(till, 'order.save', (c) => c.save(bigDraft(lines, { discountId: id, discount, discountReason: id })))
    await w.act(till, 'order.prepare', (c) => c.prepare(o!.id))
    const paid = await w.act(till, 'payment.record', (c) => c.pay(o!.id, 'card', 0, true, { edc: 'BCA' })); await w.sync(till)
    if (id === 'happy-hour') {
      await w.signIn(laptop, 'manager')
      const s = (await laptop.session!.db.settings.get('settings'))!
      await w.act(laptop, 'settings.update', (c) => c.settings({ ...s, discounts: s.discounts!.map((d) => (d.id === id ? { ...d, value: 25 } : d)) })); await w.sync(laptop); await w.sync(till)
    }
    expect(w.findings.map((f) => f.what + ': ' + f.detail)).toEqual([])
    const gone = paid!.lines[id === 'voucher-25' ? 2 : 1]
    const done = await w.act(till, 'order.voidline', (c) => c.voidLine(o!.id, gone.id, 'Salah menu')); await w.sync(till)
    const server = (await w.server.admin<{ t: { discount: number; total: number } }>("select snapshot->'totals' as t from public.orders where id=$1", [o!.id]))[0].t
    expect(w.findings.filter((f) => f.kind === 'rejected' || f.kind === 'stuck')).toEqual([])
    expect({ discount: done!.totals.discount, total: done!.totals.total }).toEqual({ discount: server.discount, total: server.total })
    expect(done!.totals.total).toBeLessThanOrEqual(paid!.totals.total)
  }, 60_000)
})
