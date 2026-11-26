// @vitest-environment node
// QA 2026-11-25, cluster counts. A count measures the shelf at the moment it was taken (CT-01, SQL-03, STK-01, STN-01):
// the same case fed to both sides, the laptop's Commands.recordCount and apply_operation on PGlite, must agree.
// Server-only rules (STK-02, STK-03, SEC-1, SQL-15, SQL-16) are in scripts/db-checks/qa-counts.mjs.
import { afterEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ client: {} as Record<string, unknown> }))
vi.mock('../../src/lib/supabase', () => ({ configured: true, telegramBot: '', supabase: h.client }))
import { balance, draft, line, small } from '../corpus/small'
import type { World } from '../corpus/world'
import { identity, sale, seed, tick } from './offline-harness'

afterEach(() => vi.useRealTimers())
const problems = (w: World) => w.findings.filter((f) => f.kind === 'rejected' || f.kind === 'stuck').map((f) => `${f.what}: ${f.detail}`)
const T = 60_000

describe('QA counts: a count approved later keeps what moved since', () => {
  it('count, then a sale and a delivery, then approve: the device and the server book the same gap at the count\'s time', async () => {
    const { w, z, till, laptop } = await small(h.client, 201, ['susu-segar', 'kopi-house', 'es-batu', 'gelas-16', 'tutup-dome', 'sedotan'])
    await w.act(till, 'shift.open', (c) => c.openShift(500_000)); await w.sync(till)
    // 15:40 Siti counts the bar fridge before closing: exactly what the books say.
    const counted = await balance(w, z.id, 'susu-segar'), id = crypto.randomUUID()
    await w.act(till, 'count.submit', (c) => c.submitCount({ id, area: 'Kulkas bar', lines: [{ stockId: 'susu-segar', counted }] })); await w.sync(till)
    // An iced latte (150 ml fresh milk) sells after the count, and 5 L arrive the next morning.
    const latte = (await till.session!.db.menu.get('latte-iced'))!, o = await w.act(till, 'order.save', (c) => c.save(draft([line(latte)])))
    await w.act(till, 'order.prepare', (c) => c.prepare(o!.id)); await w.act(till, 'payment.record', (c) => c.pay(o!.id, 'cash', 50_000, true)); await w.sync(till)
    w.advance(10 * 60 * T)
    await w.signIn(laptop, 'manager')
    await w.act(laptop, 'stock.record', (c) => c.stockRecord('susu-segar', 'purchase', 5_000_000, 'Kiriman pagi', 150_000)); await w.sync(laptop)
    // The waiting count reached the laptop with the balance at the time it was counted; the manager approves it there.
    const c = (await laptop.session!.db.counts.get(id))!
    expect(c.lines).toEqual([{ stockId: 'susu-segar', counted, reason: '', expected: counted, at: c.submittedAt }])
    await w.act(laptop, 'count.record', (x) => x.recordCount({ id, area: c.area, lines: c.lines })); await w.sync(laptop)
    expect(problems(w)).toEqual([])
    const want = counted - 150_000 + 5_000_000
    expect(await balance(w, z.id, 'susu-segar')).toBe(want)
    expect((await laptop.session!.db.movements.where('stockId').equals('susu-segar').toArray()).reduce((n, m) => n + m.qty, 0)).toBe(want)
    // No gap, stamped at the count's time, on both sides; the record keeps expected = the balance then.
    const move = (await laptop.session!.db.movements.where('stockId').equals('susu-segar').toArray()).find((m) => m.kind === 'count')!
    expect([move.qty, move.at]).toEqual([0, c.submittedAt])
    const row = (await w.server.admin<{ lines: unknown; q: string; at: string }>("select c.lines,(select qty::text from public.stock_movements m where m.restaurant_id=c.restaurant_id and m.kind='count' and m.record_id=c.id::text) as q,(select to_char(occurred_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') from public.stock_movements m where m.restaurant_id=c.restaurant_id and m.kind='count' and m.record_id=c.id::text) as at from public.counts c where c.id=$1", [id]))[0]
    expect([row.q, row.at]).toEqual(['0', c.submittedAt])
    expect(row.lines).toEqual([{ stockId: 'susu-segar', counted, reason: '', expected: counted, at: c.submittedAt }])
    expect((await laptop.session!.db.counts.get(id))!.lines).toEqual(row.lines)
  }, 120_000)
})

describe('QA counts: the device alone', () => {
  it('recordCount measures a count sent from this device against the movements up to its submit', async () => {
    const { db, commands } = await seed(identity({ role: 'manager' }))
    const id = crypto.randomUUID()
    const sent = await commands.submitCount({ id, area: 'Dry store', lines: [{ stockId: 'rice', counted: 10_000_000 }] }); await tick()
    await sale(commands) // nasi goreng: 100 g of rice after the count
    const c = (await db.counts.get(id))!
    await commands.recordCount({ id, area: c.area, lines: c.lines })
    const moves = await db.movements.where('stockId').equals('rice').toArray(), count = moves.find((m) => m.kind === 'count')!
    expect([count.qty, count.at]).toEqual([0, sent.submittedAt])
    expect(moves.reduce((n, m) => n + m.qty, 0)).toBe(9_900_000)
    expect((await db.counts.get(id))!.lines).toEqual([{ stockId: 'rice', counted: 10_000_000, expected: 10_000_000, reason: '', at: sent.submittedAt }])
  })
  it('SQL-16: stockRecord refuses a reason over 200 characters before it is queued', async () => {
    const { commands } = await seed(identity({ role: 'manager' }))
    await expect(commands.stockRecord('rice', 'waste', 1000, 'x'.repeat(201))).rejects.toThrow('Jumlah/alasan tidak valid')
    await expect(commands.stockRecord('rice', 'waste', 1000, 'x'.repeat(200))).resolves.toBe(-1000)
  })
})
