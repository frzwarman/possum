import { describe, expect, it } from 'vitest'
import { demoIdentity, demoServer, demoSnapshot } from '../../src/stok/demo'
import { Queue, load, save } from '../../src/stok/queue'
import { Rejected, classify, explain, flush, staysSignedIn, toOperation } from '../../src/stok/sync'
import type { Identity, Job, KV, Operation, Server } from '../../src/stok/types'

const memory = (): KV => { const m = new Map<string, string>(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) } }
const me: Identity = { id: 'u1', name: 'Adit', role: 'admin', restaurantId: 'r1', store: 'Ziggy', timezone: 'Asia/Jakarta', deviceId: 'd1', paired: true, demo: false }
const job = (id: string, p: Partial<Job> = {}): Job => ({ id, actor: 'u1', occurredAt: `2026-11-17T03:00:0${id.slice(-1)}.000Z`, label: id, state: 'pending', type: 'op', kind: 'stock.record', payload: { stockId: 'milk' }, ...p } as Job)
const server = (apply: (o: Operation) => Promise<void>): Server => ({ apply, link: async () => {}, unlink: async () => {}, pair: async () => {}, snapshot: async () => demoSnapshot('now') })

describe('queue', () => {
  it('survives a restart and reads broken storage as empty', () => {
    const kv = memory()
    new Queue(kv, 'u1').add([job('j1'), job('j2')])
    expect(new Queue(kv, 'u1').all().map((j) => j.id)).toEqual(['j1', 'j2'])
    expect(new Queue(kv, 'u2').all()).toEqual([])
    kv.setItem('stok-queue-u1', '{broken')
    expect(new Queue(kv, 'u1').all()).toEqual([])
    save(kv, 'k', { a: 1 })
    expect(load(kv, 'k', {})).toEqual({ a: 1 })
    expect(load(kv, 'missing', 7)).toBe(7)
  })
  it('never queues the same id twice', () => {
    const q = new Queue(memory(), 'u1')
    q.add([job('j1')]); q.add([job('j1'), job('j2')])
    expect(q.all().map((j) => j.id)).toEqual(['j1', 'j2'])
  })
  it('keeps a refused job with its message until it is sent again as new or deleted', () => {
    const q = new Queue(memory(), 'u1')
    q.add([job('j1'), job('j2')]); q.reject('j1', 'Device not enrolled')
    expect(q.all()[0]).toMatchObject({ state: 'rejected', error: 'Device not enrolled' })
    q.renew('j1', 'j9', '2026-11-18T00:00:00.000Z')
    expect(q.all().map((j) => [j.id, j.state, j.error])).toEqual([['j2', 'pending', undefined], ['j9', 'pending', undefined]])
    q.remove('j9'); q.done('j2')
    expect(q.all()).toEqual([])
  })
})

describe('sending', () => {
  it('tells a final refusal from a failure worth another try', () => {
    expect(classify({ code: 'P0001', message: 'Operation timestamp outside recovery window' })).toBeInstanceOf(Rejected)
    expect(classify({ code: '42501', message: 'Manager permission required' })).toBeInstanceOf(Rejected)
    expect(classify({ message: 'Failed to fetch' })).not.toBeInstanceOf(Rejected)
    expect(classify({ code: 'PGRST301', message: 'JWT expired' })).not.toBeInstanceOf(Rejected)
  })
  it('puts the server\'s refusals in words staff can act on, and passes an unknown one through', () => {
    expect(explain('Device not enrolled')).toBe('Ponsel ini belum dipasangkan. Minta pemilik atau manajer memasangkannya.')
    expect(explain('Operation timestamp outside recovery window')).toBe('Catatan ini tertunda lebih dari 7 hari, atau jam ponsel salah. Kirim ulang untuk mencatatnya sekarang.')
    expect(explain('Manager permission required')).toBe('Peran Anda tidak boleh melakukan ini.')
    expect(explain('Something new')).toBe('Something new')
  })
  it('keeps a person signed in when the session cannot be checked for lack of signal', () => {
    const saved = { id: 'u1', demo: false }
    expect(staysSignedIn(saved, { id: 'u1', unsure: false })).toBe(true)
    // Opened in a storeroom after an hour: the session has expired and cannot be refreshed. The person keeps working.
    expect(staysSignedIn(saved, { unsure: true })).toBe(true)
    expect(staysSignedIn(saved, { unsure: false })).toBe(false)
    expect(staysSignedIn(saved, { id: 'u2', unsure: false })).toBe(false)
    expect(staysSignedIn({ id: 'demo-admin', demo: true }, { unsure: false })).toBe(true)
  })
  it('wraps a job as the operation apply_operation expects', () => {
    const j = job('j1')
    expect(toOperation(j as Extract<Job, { type: 'op' }>, me)).toEqual({ id: 'j1', kind: 'stock.record', actor: 'u1', restaurantId: 'r1', deviceId: 'd1', occurredAt: j.occurredAt, payload: { stockId: 'milk' } })
  })
  it('sends oldest first and removes what was accepted', async () => {
    const q = new Queue(memory(), 'u1'), seen: string[] = []
    q.add([job('j2'), job('j1')])
    expect(await flush(q, me, server(async (o) => void seen.push(o.id)))).toEqual({ sent: 2, rejected: 0, left: 0 })
    expect(seen).toEqual(['j1', 'j2'])
  })
  it('sets a refused job aside and carries on', async () => {
    const q = new Queue(memory(), 'u1')
    q.add([job('j1'), job('j2')])
    expect(await flush(q, me, server(async (o) => { if (o.id === 'j1') throw new Rejected('Bahan tidak ditemukan') }))).toEqual({ sent: 1, rejected: 1, left: 0 })
    expect(q.all()).toMatchObject([{ id: 'j1', state: 'rejected', error: 'Bahan tidak ditemukan' }])
  })
  it('stops at a network failure and sends the same ids on the next try', async () => {
    const q = new Queue(memory(), 'u1'), seen: string[] = []
    q.add([job('j1'), job('j2')])
    let online = false
    const s = server(async (o) => { seen.push(o.id); if (!online) throw new Error('Failed to fetch') })
    expect(await flush(q, me, s)).toEqual({ sent: 0, rejected: 0, left: 2 })
    online = true
    expect(await flush(q, me, s)).toEqual({ sent: 2, rejected: 0, left: 0 })
    expect(seen).toEqual(['j1', 'j1', 'j2'])
  })
  it('leaves another person\'s work alone', async () => {
    const kv = memory(), q = new Queue(kv, 'u1')
    q.add([job('j1', { actor: 'u2' }), job('j2')])
    expect(await flush(q, me, server(async () => {}))).toEqual({ sent: 1, rejected: 0, left: 0 })
    expect(q.all().map((j) => j.id)).toEqual(['j1'])
  })
  it('sends barcode links through their own calls', async () => {
    const q = new Queue(memory(), 'u1'), calls: string[] = []
    q.add([job('j1', { type: 'link', code: '899', stockId: 'milk', pack: 'karton' } as Partial<Job>), job('j2', { type: 'unlink', code: '899' } as Partial<Job>)])
    await flush(q, me, { ...server(async () => {}), link: async (d, c, s, p) => void calls.push(`link ${d} ${c} ${s} ${p}`), unlink: async (d, c) => void calls.push(`unlink ${d} ${c}`) })
    expect(calls).toEqual(['link d1 899 milk karton', 'unlink d1 899'])
  })
})

describe('demo', () => {
  it('runs on Takar\'s sample bahan and remembers a link', async () => {
    const s = demoServer(() => 'now')
    expect(demoIdentity('d1')).toMatchObject({ role: 'admin', demo: true, paired: true, deviceId: 'd1' })
    expect((await s.snapshot('d1')).barcodes.find((b) => b.code === '8991002101234')).toEqual({ code: '8991002101234', stockId: 'water', pack: 'dus' })
    await s.link('d1', '4902430', 'rice', 'karung')
    expect((await s.snapshot('d1')).barcodes.some((b) => b.code === '4902430' && b.stockId === 'rice')).toBe(true)
    await s.unlink('d1', '4902430')
    expect((await s.snapshot('d1')).barcodes.some((b) => b.code === '4902430')).toBe(false)
  })
})
