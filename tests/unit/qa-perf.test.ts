// QA 2026-11-25, cluster perf (PERF-5, PERF-6, STK-15): the till no longer re-reads every movement and the newest 500 orders
// on each write, and the screens' scans give the same numbers as before. pnpm vitest run tests/unit/qa-perf.test.ts
import { describe, expect, it, vi } from 'vitest'
import { MejaDB } from '../../src/lib/db'
import { Recent, Tally } from '../../src/lib/tally'
import { expiring, movesOf, unitCosts, usagePerDay } from '../../src/domain/calculate'
import type { Movement, Order, StockItem } from '../../src/domain/types'

let n = 0
const fresh = () => new MejaDB(`perf-${++n}-${Date.now()}`)
const rng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296
const KINDS = ['preparation', 'purchase', 'waste', 'count', 'production', 'transfer', 'opening'] as const
function moves(count: number, stocks: number, seed = 7): Movement[] {
  const r = rng(seed), now = Date.now()
  return Array.from({ length: count }, (_, i) => {
    const kind = KINDS[Math.floor(r() * KINDS.length)], sign = kind === 'preparation' || kind === 'waste' ? -1 : 1
    const qty = sign * (r() * 900 + 0.1), cost = kind === 'purchase' || kind === 'production' || kind === 'transfer' ? Math.round(r() * 90000) : 0
    return { id: `m${String(Math.floor(r() * 1e9)).padStart(10, '0')}-${i}`, stockId: `s${Math.floor(r() * stocks)}`, qty, kind, reason: '', actor: 'u', at: new Date(now - r() * 40 * 864e5).toISOString(), recordId: `r${i}`, cost }
  })
}
// What context.tsx computed before: one pass over db.movements.toArray().
const oldBalances = (all: Movement[]) => { const m = new Map<string, number>(); for (const x of all) m.set(x.stockId, (m.get(x.stockId) || 0) + x.qty); return m }
async function expectTally(db: MejaDB, t: Tally) {
  const oracle = new MejaDB(db.name), all = await oracle.movements.toArray(); oracle.close()
  await vi.waitFor(() => { expect(t.balances).toEqual(oldBalances(all)); expect(t.units).toEqual(unitCosts(all)) })
}

describe('PERF-5: the stock figures follow the writes without reading every movement', () => {
  it('equals the whole-table pass after adds, updates, deletes, a reset and an aborted write', async () => {
    const db = fresh(), t = new Tally(db, () => {}), base = moves(600, 12)
    await db.movements.bulkPut(base)
    const stop = t.start(); await expectTally(db, t)
    const read = vi.spyOn(db.movements, 'toArray')
    await db.movements.add({ ...moves(1, 12, 3)[0], id: 'zz-new', stockId: 's3', qty: -41.7 })
    await db.movements.bulkPut([{ ...base[0], qty: base[0].qty + 5.25 }, { ...moves(1, 99, 4)[0], id: 'zz-other', stockId: 'brand-new', kind: 'purchase', qty: 10, cost: 5000 }])
    await db.movements.delete(base[1].id)
    await expectTally(db, t)
    // a transaction that fails leaves no trace
    await expect(db.transaction('rw', db.movements, async () => { await db.movements.add({ ...base[2], id: 'zz-aborted', qty: 777777 }); throw new Error('no') })).rejects.toThrow()
    await new Promise(r => setTimeout(r, 50)); await expectTally(db, t)
    expect(t.balances.get(base[2].stockId)).not.toBe((oldBalances(base).get(base[2].stockId) ?? 0) + 777777)
    // sign-in replaces the history: clear then bulkPut in one transaction
    await db.transaction('rw', db.movements, async () => { await db.movements.clear(); await db.movements.bulkPut(moves(80, 5, 9)) })
    await expectTally(db, t)
    expect(read).not.toHaveBeenCalled() // none of it read the whole table again
    stop()
  })
  it('a second tab writing behind its back is caught when the table size differs', async () => {
    const db = fresh(), other = new MejaDB(db.name), t = new Tally(db, () => {})
    await db.movements.bulkPut(moves(50, 4)); const stop = t.start(); await expectTally(db, t)
    await other.movements.bulkPut(moves(5, 4, 11).map(m => ({ ...m, id: 'x' + m.id })))
    await new Promise(r => setTimeout(r, 30)); await t.catchUp(); await expectTally(db, t)
    stop(); other.close()
  })
  it('the newest-500 window equals the old query after every kind of write, and a tap does not re-read it', async () => {
    const db = fresh(), oracle = new MejaDB(db.name); let shown: Order[] = []
    const order = (i: number) => ({ id: `o${String(i).padStart(4, '0')}`, createdAt: new Date(Date.UTC(2026, 10, 1) + (i % 700) * 6e4).toISOString(), status: 'open', label: `Pager ${i}` }) as unknown as Order
    await db.orders.bulkPut(Array.from({ length: 640 }, (_, i) => order(i)))
    const r = new Recent(db, rows => { shown = rows }), stop = r.start()
    const same = async () => { const old = await oracle.orders.orderBy('createdAt').reverse().limit(500).toArray(); await vi.waitFor(() => expect(shown.map(o => o.id + o.status)).toEqual(old.map(o => o.id + o.status))) }
    await same()
    const read = vi.spyOn(db.orders, 'orderBy')
    await db.orders.add({ ...order(9001), createdAt: new Date(Date.UTC(2026, 11, 1)).toISOString() }); await same()
    await db.orders.update(shown[3].id, { status: 'paid' } as never); await same()
    await db.orders.update('o0005', { status: 'paid' } as never); await same() // outside the window
    await db.orders.delete(shown[10].id); await same() // an older order takes its place
    expect(read).toHaveBeenCalledTimes(1) // only the delete needed a read of the window
    stop(); oracle.close()
  })
})

describe('PERF-6: grouping by ingredient gives the numbers the filters gave', () => {
  const all = moves(3000, 30, 21), items = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, name: `b${i}`, shelfLife: i % 3 ? 6 : 0, threshold: 1 }) as unknown as StockItem)
  const oldUsage = (m: Movement[], id: string, days = 7) => { const since = Date.now() - days * 86_400_000; return m.filter(x => x.stockId === id && x.qty < 0 && ['preparation', 'production'].includes(x.kind) && Date.parse(x.at) >= since).reduce((a, x) => a - x.qty, 0) / days }
  it('usagePerDay', () => { for (const s of items) expect(usagePerDay(all, s.id)).toBe(oldUsage(all, s.id)) })
  it('expiring', () => {
    const now = Date.now(), old = () => { const out: unknown[] = []; for (const s of items) { if (!s.shelfLife) continue; let left = all.filter(m => m.stockId === s.id).reduce((a, m) => a + m.qty, 0); for (const b of all.filter(m => m.stockId === s.id && m.kind === 'production' && m.qty > 0).sort((a, b) => b.at.localeCompare(a.at))) { if (left <= 0) break; const remaining = Math.min(left, b.qty); left -= remaining; const expiresAt = Date.parse(b.at) + s.shelfLife * 3_600_000; if (expiresAt - now <= 2 * 3_600_000) out.push({ item: s, movement: b, remaining, expiresAt, expired: expiresAt <= now }) } } return (out as { expiresAt: number }[]).sort((a, b) => a.expiresAt - b.expiresAt) }
    expect(expiring(items, all, 2, now)).toEqual(old())
  })
  it('a grown array is grouped again', () => { const a = all.slice(0, 100), before = movesOf(a, 's1').length; a.push({ ...all[0], id: 'late', stockId: 's1' }); expect(movesOf(a, 's1').length).toBe(before + 1) })
  it('scans 140k movements for 270 ingredients in well under a second', () => {
    const big = moves(140_000, 270, 5), t = performance.now(); for (let i = 0; i < 270; i++) usagePerDay(big, `s${i}`)
    expect(performance.now() - t).toBeLessThan(1500)
  })
})
