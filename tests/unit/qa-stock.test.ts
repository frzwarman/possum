// QA 2026-11-25, cluster stock. Client side of CAT-5 (a delivery time is the restaurant's wall clock), SQL-10 (a transfer
// receipt never exceeds what was sent) and STK-12 (the admin reads outlets and transfers). The server side of these, and
// of CT-03/STK-05/CAT-6 (drawer payments), is scripts/db-checks/qa-stock.mjs; CT-03 and CT-06 end to end are in
// tests/unit/contract-edges.test.ts.
import { beforeAll, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../../src/lib/supabase', () => ({ configured: true, telegramBot: '', supabase: { rpc: h.rpc } }))
import { zonedLocal, zonedTime } from '../../src/domain/calculate'
import { identity, seed } from './offline-harness'

describe('CAT-5: a delivery time is read in the restaurant zone', () => {
  beforeAll(() => { process.env.TZ = 'Asia/Makassar' }) // the owner's phone is in Bali, the restaurant in Jakarta
  it('zonedTime and zonedLocal are inverses in the restaurant zone, whatever the device zone is', () => {
    expect(new Date(zonedTime('2026-11-28T11:30', 'Asia/Jakarta')).toISOString()).toBe('2026-11-28T04:30:00.000Z')
    expect(new Date(zonedTime('2026-11-28T11:30', 'Asia/Makassar')).toISOString()).toBe('2026-11-28T03:30:00.000Z')
    expect(zonedLocal('2026-11-28T04:30:00.000Z', 'Asia/Jakarta')).toBe('2026-11-28T11:30')
    expect(zonedLocal('2026-11-28T04:30:00.000Z')).toBe('2026-11-28T11:30')
  })
  it('saveSalesOrder stores 11:30 typed at the till as 11:30 WIB', async () => {
    const { commands, db } = await seed(identity({ role: 'manager' }))
    const m = (await db.menu.toArray())[0]
    const so = await commands.saveSalesOrder({ customer: { name: 'PT Uji', phone: '', address: '' }, deliverAt: '2026-11-28T11:30', lines: [{ id: 'l1', itemId: m.id, name: m.name, qty: 1, price: 10000, catalogVersion: m.version }], discount: 0, note: '' })
    expect(so.deliverAt).toBe('2026-11-28T04:30:00.000Z')
    // An ISO string with its own zone (older callers, imports) is taken as it is.
    const iso = await commands.saveSalesOrder({ customer: { name: 'PT Uji', phone: '', address: '' }, deliverAt: '2026-11-28T04:30:00.000Z', lines: so.lines, discount: 0, note: '' })
    expect(iso.deliverAt).toBe('2026-11-28T04:30:00.000Z')
  })
})

describe('SQL-10: receiving a transfer', () => {
  it('refuses more than was sent, accepts the sent amount and less', async () => {
    const user = identity({ role: 'manager' }), { commands, db } = await seed(user)
    const stockItem = (await db.stock.toArray()).find((s) => s.unit === 'g')!
    const send = (id: string) => db.transfers.put({ id, number: 'TR-' + id, from: 'lain', fromName: 'Dago', to: user.restaurantId, toName: 'Ziggy', note: '', status: 'sent', sentAt: new Date().toISOString(), lines: [{ stockId: stockItem.id, name: stockItem.name, unit: 'g', qty: 1000, value: 150 }] })
    await send('t1')
    const receive = (id: string, qty: number) => commands.receiveTransfer(id, [{ stockId: stockItem.id, target: stockItem.id, qty }])
    await expect(receive('t1', 1_000_000)).rejects.toThrow('melebihi yang dikirim')
    expect((await db.transfers.get('t1'))!.status).toBe('sent')
    expect(await db.outbox.count()).toBe(0)
    await receive('t1', 1000)
    expect((await db.transfers.get('t1'))!.status).toBe('received')
    await send('t2')
    await receive('t2', 400)
    expect((await db.transfers.get('t2'))!.status).toBe('received')
  })
})

describe('STK-12: the admin reads linked outlets and transfers', () => {
  it('refreshTransfers asks the server for an admin, not for a cashier', async () => {
    h.rpc.mockResolvedValue({ data: { outlets: [{ id: 'o2', name: 'Dago' }], transfers: [] }, error: null })
    const admin = await seed(identity({ role: 'admin' }))
    await admin.commands.refreshTransfers()
    expect(h.rpc).toHaveBeenCalledWith('outlet_transfers')
    expect(JSON.parse((await admin.db.meta.get('outlets'))!.value)).toEqual([{ id: 'o2', name: 'Dago' }])
    h.rpc.mockClear()
    await (await seed(identity({ role: 'cashier' }))).commands.refreshTransfers()
    expect(h.rpc).not.toHaveBeenCalled()
  })
})
