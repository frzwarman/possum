import { describe, expect, it } from 'vitest'
import { balances, journal, position, profit, sumMoves, valuation, zero, type Books, type Move, type Range } from '../../src/domain/accounting'
import { businessDay } from '../../src/domain/calculate'
import { plain } from '../../src/features/accounting/Accounting'
import type { Movement, SalesOrder } from '../../src/domain/types'

const range: Range = { from: '2026-11-10', to: '2026-11-12', dayOf: (iso) => businessDay(iso) }
const base: Books = { orders: [], moves: [], opening: {}, costs: {}, shifts: [], opened: [], cash: [], purchaseOrders: [], salesOrders: [], entries: [] }
const sales = (status: SalesOrder['status'], payments: SalesOrder['payments']): SalesOrder => ({ id: 's', number: 'SO-1', customer: { name: 'PT', phone: '', address: '' }, deliverAt: '2026-11-12T05:00:00.000Z', lines: [], discount: 0, note: '',
  totals: { subtotal: 750000, discount: 0, service: 0, tax: 0, total: 750000 }, payments, status, revision: 3, createdAt: '2026-11-10T05:00:00.000Z', updatedAt: '2026-11-12T05:00:00.000Z' })
const run = (b: Books) => { const j = journal(b, [], range), bal = balances(j.entries), pos = position(zero(), bal); return { j, bal, pos, result: profit(bal).result } }
const balanced = (r: ReturnType<typeof run>) => { expect(r.j.entries.reduce((n, e) => n + e.debit - e.credit, 0)).toBe(0); expect(r.pos.totalAssets).toBe(r.pos.totalLiabilities + r.pos.totalEquity) }
const pay = (amount: number, at = '2026-11-10T05:00:00.000Z') => ({ at, amount, from: 'outside' as const })

describe('QA accounting', () => {
  it('CAT-2: a down payment kept on a cancelled order is income on the day of the cancellation; the receivable ends at 0', () => {
    const kept = run({ ...base, salesOrders: [sales('cancelled', [pay(300000)])] })
    expect(kept.result).toBe(300000); expect(kept.bal.receivable).toBe(0); expect(kept.bal.catering).toBe(-300000)
    expect(kept.j.entries.find((e) => e.account === 'catering')!.day).toBe('2026-11-12'); balanced(kept)
    const partly = run({ ...base, salesOrders: [sales('cancelled', [pay(500000), pay(-200000, '2026-11-12T05:00:00.000Z')])] })
    expect(partly.result).toBe(300000); expect(partly.bal.receivable).toBe(0); balanced(partly)
    const full = run({ ...base, salesOrders: [sales('cancelled', [pay(300000), pay(-300000, '2026-11-12T05:00:00.000Z')])] })
    expect(full.result === 0).toBe(true); expect(full.bal.receivable === 0).toBe(true); balanced(full)
    const open = run({ ...base, salesOrders: [sales('confirmed', [pay(300000)])] })
    expect(open.bal.receivable).toBe(-300000); expect(open.result === 0).toBe(true)
  })

  const mv = (id: string, stockId: string, kind: Movement['kind'], qty: number, cost: number, at: string, recordId = id): Movement => ({ id, stockId, kind, qty, cost, at, reason: 'x', actor: 'u', recordId })
  const worth = (b: Pick<Books, 'moves' | 'opening' | 'costs'>, id: string) => valuation(b).stock[id]
  it('STOK-1: a priced and an unpriced delivery on one day are worth what they are worth on two days', () => {
    const same = sumMoves([mv('a', 'segar', 'purchase', 1000, 230000, '2026-11-10T03:00:00.000Z'), mv('b', 'segar', 'purchase', 1000, 0, '2026-11-10T04:00:00.000Z')], new Set(), range)
    const two = sumMoves([mv('a', 'segar', 'purchase', 1000, 230000, '2026-11-10T03:00:00.000Z'), mv('b', 'segar', 'purchase', 1000, 0, '2026-11-11T04:00:00.000Z')], new Set(), range)
    expect(same.moves.length).toBe(2)
    expect(worth({ ...base, ...same }, 'segar').slice(0, 2)).toEqual([2000, 460000])
    expect(worth({ ...base, ...two }, 'segar').slice(0, 2)).toEqual([2000, 460000])
    // What the server now sends: the same two rows.
    const server: Move[] = [{ day: '2026-11-10', stockId: 'segar', kind: 'purchase', comp: false, qty: 1000, cost: 230000 }, { day: '2026-11-10', stockId: 'segar', kind: 'purchase', comp: false, qty: 1000, cost: 0 }]
    expect(worth({ ...base, moves: server }, 'segar').slice(0, 2)).toEqual([2000, 460000])
    const r = run({ ...base, moves: server }); balanced(r)
  })

  it('STK-10: a batch that uses what an earlier one made the same day is valued in order', () => {
    const rows = sumMoves([
      mv('p1', 'shallot', 'purchase', 1000, 60000, '2026-11-10T01:00:00.000Z'), mv('p2', 'chili', 'purchase', 1000, 50000, '2026-11-10T01:00:00.000Z'),
      mv('b1-bg', 'bg', 'production', 500, 30000, '2026-11-10T02:00:00.000Z', 'b1'), mv('b1-sh', 'shallot', 'production', -500, 0, '2026-11-10T02:00:00.000Z', 'b1'),
      mv('b2-sm', 'sambal', 'production', 800, 43000, '2026-11-10T07:00:00.000Z', 'b2'), mv('b2-bg', 'bg', 'production', -300, 0, '2026-11-10T07:00:00.000Z', 'b2'), mv('b2-ch', 'chili', 'production', -500, 0, '2026-11-10T07:00:00.000Z', 'b2'),
    ], new Set(), range)
    const s = valuation({ ...base, ...rows }).stock
    expect([s.bg[1], s.sambal[1]]).toEqual([12000, 43000])
    // Rows in the wrong order (the server sends them by day) still come out in time order.
    const shuffled = valuation({ ...base, moves: [...rows.moves].reverse() }).stock
    expect([shuffled.bg[1], shuffled.sambal[1]]).toEqual([12000, 43000])
    balanced(run({ ...base, ...rows }))
    // Rows without a batch (an older server): the day is one batch, as before.
    const old = valuation({ ...base, moves: [{ day: '2026-11-10', stockId: 'bg', kind: 'production', comp: false, qty: 200, cost: 30000 }, { day: '2026-11-10', stockId: 'shallot', kind: 'production', comp: false, qty: -500, cost: 0 }, { day: '2026-11-10', stockId: 'shallot', kind: 'purchase', comp: false, qty: 1000, cost: 60000 }] }).stock
    expect(old.bg[1]).toBe(30000)
  })

  it('RPT-3: column titles survive both file formats; numbers still convert', () => {
    for (const k of ['qty', 'pct', 'rp', 'num', 'text'] as const) for (const pc of [true, false]) expect(plain('Awal', k, pc)).toBe('Awal')
    expect(plain(1500, 'qty')).toBe(1.5); expect(plain(0.256, 'pct', true)).toBe(25.6); expect(plain(0.256, 'pct')).toBe(0.256)
  })
})
