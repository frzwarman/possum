// Regression tests for the Takar Stok findings of the November 2026 QA campaign (STOK-n). The phone's screens have
// no tests in this repo; these pin the decisions the screens and mobile/src/state.tsx take from src/stok.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { can, roles } from '../../src/domain/permissions'
import { boxOf, lookup } from '../../src/stok/barcode'
import { confirmed, deliveryJobs, flag, lineCost, lineQty, units } from '../../src/stok/delivery'
import { demoSnapshot } from '../../src/stok/demo'
import { Queue } from '../../src/stok/queue'
import { cannotLeave, deadline, flush, staysSignedIn, whoseSession } from '../../src/stok/sync'
import type { DeliveryLine, Identity, Job, KV, Operation, PhoneStock, Server } from '../../src/stok/types'

const now = '2026-11-24T03:00:00.000Z'
const stock = demoSnapshot(now).stock
// Air mineral botol: kept in pcs, bought by the dus of 24, usually 48 pcs a delivery.
const water = stock.find((s) => s.id === 'water')!
const memory = (): KV => { const m = new Map<string, string>(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) } }
const me: Identity = { id: 'u1', name: 'Adit', role: 'admin', restaurantId: 'r1', store: 'Ziggy', timezone: 'Asia/Jakarta', deviceId: 'd1', paired: true, demo: false }
const job = (id: string, p: Partial<Job> = {}): Job => ({ id, actor: 'u1', occurredAt: `2026-11-24T03:00:0${id.slice(-1)}.000Z`, label: id, state: 'pending', type: 'op', kind: 'stock.record', payload: { stockId: 'water' }, ...p } as Job)
const server = (apply: (o: Operation) => Promise<void>): Server => ({ apply, link: async () => {}, unlink: async () => {}, pair: async () => {}, snapshot: async () => demoSnapshot(now) })

describe('STOK-2: "Ya, benar" confirms a quantity, not the digits typed', () => {
  const typed: DeliveryLine = { id: 'l1', stockId: 'water', unit: 'pcs', amount: '300', price: '2000' }
  it('300 pcs against a usual 48 is flagged until it is confirmed', () => {
    expect(flag(water, typed)).toBe('high')
    expect(flag(water, confirmed(water, typed))).toBeUndefined()
  })
  it('300 confirmed as pcs is checked again when the unit becomes dus (7.200 pcs)', () => {
    expect(flag(water, { ...confirmed(water, typed), unit: 'dus' })).toBe('high')
  })
  it('the save refuses 300 dus that was only confirmed as 300 pcs', () => {
    const moved = { ...confirmed(water, typed), unit: 'dus' }
    expect(() => deliveryJobs({ id: 'd1', note: 'CV A', lines: [moved] }, stock, 'u1', now)).toThrow('Cek jumlah yang ditandai')
    // Confirmed again as dus, it goes in as what the person agreed to.
    const [saved] = deliveryJobs({ id: 'd1', note: 'CV A', lines: [confirmed(water, moved)] }, stock, 'u1', now)
    expect(saved.type === 'op' && saved.payload).toMatchObject({ stockId: 'water', qty: 7_200_000 })
  })
  it('the same quantity typed another way stays confirmed', () => {
    expect(flag(water, { ...confirmed(water, typed), unit: 'dus', amount: '12,5' })).toBeUndefined()
  })
  it('a pack that was resized in Takar after the confirmation is checked again', () => {
    const sure = confirmed(water, { ...typed, unit: 'dus', amount: '11' })
    expect(flag(water, sure)).toBeUndefined()
    expect(flag({ ...water, packs: [{ name: 'dus', qty: 48_000 }] }, sure)).toBe('high')
  })
  it('a confirmation the previous version of the app saved (the typed text) asks once more', () => {
    const old = { ...typed, checked: '300' } as unknown as DeliveryLine
    expect(flag(water, old)).toBe('high')
    expect(flag(water, { ...old, unit: 'dus' })).toBe('high')
  })
})

describe('STOK-11: a unit is offered once', () => {
  const lemon: PhoneStock = { id: 'lemon', name: 'Lemon', unit: 'g', packs: [{ name: 'kg', qty: 1_000_000 }] }
  it('a bahan bought by a pack named "kg" gets one kg, not two', () => {
    expect(units(lemon)).toEqual([{ name: 'kg', per: 1_000_000 }, { name: 'g', per: 1000 }])
  })
  it('likewise a pack named "l", or named like the base unit', () => {
    expect(units({ id: 'm', name: 'Susu', unit: 'ml', packs: [{ name: 'l', qty: 1_000_000 }, { name: 'karton', qty: 12_000_000 }] }).map((u) => u.name)).toEqual(['l', 'karton', 'ml'])
    expect(units({ id: 'c', name: 'Cup', unit: 'pcs', packs: [{ name: 'pcs', qty: 1000 }] }).map((u) => u.name)).toEqual(['pcs'])
  })
  it('and the amount and the cost of a delivery typed in that kg are what they were', () => {
    const line: DeliveryLine = { id: 'l1', stockId: 'lemon', unit: 'kg', amount: '2,5', price: '45000' }
    expect(lineQty(lemon, line)).toBe(2_500_000)
    expect(lineCost(lemon, line)).toBe(112_500)
  })
})

describe('STOK-3: the box of a count a scanned code stands for', () => {
  const egg: PhoneStock = { id: 'egg', name: 'Telur', unit: 'pcs', packs: [{ name: 'tray', qty: 30_000 }] }
  const hit = (pack: string) => lookup('899', { '899': { stockId: 'egg', pack } }, [egg])!
  it('a code taught as "satuan" stands for the loose box, never for the first pack', () => {
    expect(boxOf(hit(''))).toBe('')
  })
  it('a code printed on a pack stands for that pack, and for the loose box once the pack is gone', () => {
    expect(boxOf(hit('tray'))).toBe('tray')
    expect(boxOf(hit('dus'))).toBe('')
  })
})

describe('STOK-5 and STOK-6: no wait on the network is without an end', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())
  const never = <T,>() => new Promise<T>(() => {})
  const outcome = <T,>(p: Promise<T>) => { const seen: { is?: string } = {}; p.then((v) => { seen.is = `answered ${JSON.stringify(v)}` }, (e: Error) => { seen.is = `gave up: ${e.message}` }); return seen }

  it('a call that never answers is given up at the deadline, and told to stop', async () => {
    let signal: AbortSignal | undefined
    const seen = outcome(deadline(20_000, (s) => { signal = s; return never<string>() }))
    await vi.advanceTimersByTimeAsync(19_999)
    expect([seen.is, signal?.aborted]).toEqual([undefined, false])
    await vi.advanceTimersByTimeAsync(1)
    expect(signal?.aborted).toBe(true)
    expect(seen.is).toMatch(/^gave up: /)
  })
  it('an answer or a failure in time is passed on as it is', async () => {
    expect(await deadline(20_000, async () => 'ok')).toBe('ok')
    await expect(deadline(20_000, async () => { throw new Error('Failed to fetch') })).rejects.toThrow('Failed to fetch')
  })
  it('the signal still fires at the deadline after an answer: a fetch answers with the headers, and its body must not hang either', async () => {
    let signal: AbortSignal | undefined
    expect(await deadline(20_000, async (s) => { signal = s; return 'headers' })).toBe('headers')
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(signal?.aborted).toBe(true)
  })
  it('STOK-6: a send that never gets an answer stays queued, and goes out again under the same id', async () => {
    const q = new Queue(memory(), 'u1'), sent: string[] = []
    q.add([job('j1'), job('j2')])
    let dead = true
    const apply = (o: Operation) => deadline(20_000, () => { sent.push(o.id); return dead ? never<void>() : Promise.resolve() })
    const first = flush(q, me, server(apply))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await first).toEqual({ sent: 0, rejected: 0, left: 2 })
    // Not refused, not lost, not renumbered: the server answers a repeated id with its first result.
    expect(q.all().map((j) => [j.id, j.state])).toEqual([['j1', 'pending'], ['j2', 'pending']])
    dead = false
    expect(await flush(q, me, server(apply))).toEqual({ sent: 2, rejected: 0, left: 0 })
    expect(sent).toEqual(['j1', 'j1', 'j2'])
  })
  it('STOK-5: a saved session that cannot be checked within 2 s counts as unsure, and the person stays signed in', async () => {
    const asked = whoseSession(() => never())
    const seen = outcome(asked)
    await vi.advanceTimersByTimeAsync(1999)
    expect(seen.is).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(seen.is).toBe('answered {"unsure":true}')
    expect(staysSignedIn({ id: 'u1', demo: false }, await asked)).toBe(true)
  })
  it('STOK-5: an answer in time decides as before: the same person stays, a session that is gone signs out', async () => {
    const saved = { id: 'u1', demo: false }
    expect(staysSignedIn(saved, await whoseSession(async () => ({ id: 'u1', unsure: false })))).toBe(true)
    expect(staysSignedIn(saved, await whoseSession(async () => ({ unsure: false })))).toBe(false)
    expect(staysSignedIn(saved, await whoseSession(async () => ({ id: 'u2', unsure: false })))).toBe(false)
    expect(await whoseSession(async () => { throw new Error('storage') })).toEqual({ unsure: true })
  })
})

describe('STOK-8: who the phone offers a count to', () => {
  // Beranda's tile, the count screen and submitCount (mobile/src/state.tsx) all ask can(role, 'counts'). This is the
  // list apply_operation takes count.submit from (supabase/migrations/202611230001_maintenance.sql): if the two drift
  // apart, the phone again lets someone type and send a count that Takar refuses. The screens themselves are checked
  // on the app's web export, outside this repo.
  it('is every role Takar takes a count from, so not the accountant', () => {
    expect(roles.filter((r) => can(r, 'counts'))).toEqual(['owner', 'manager', 'admin', 'chef', 'cashier', 'barista', 'kitchen'])
  })
})

describe('STOK-9: what keeps a person from handing the phone over', () => {
  it('nothing, when all their work was sent', () => {
    expect(cannotLeave([])).toBeUndefined()
  })
  it('unsent work waits for signal', () => {
    expect(cannotLeave([job('j1'), job('j2')])).toBe('Masih ada 2 catatan belum terkirim. Cari sinyal dulu, lalu ganti pengguna.')
  })
  it('refused work waits for a decision in Perlu perhatian, which no signal will make', () => {
    const said = cannotLeave([job('j1', { state: 'rejected', error: 'Invalid stock amount' })])
    expect(said).toBe('Ada 1 catatan yang ditolak Takar. Buka Perlu perhatian: kirim ulang atau hapus, lalu ganti pengguna.')
    expect(said).not.toContain('sinyal')
  })
  it('with both, the unsent work is counted by itself and comes first', () => {
    expect(cannotLeave([job('j1'), job('j2', { state: 'rejected' })])).toBe('Masih ada 1 catatan belum terkirim. Cari sinyal dulu, lalu ganti pengguna.')
  })
})
