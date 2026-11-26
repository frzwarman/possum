// @vitest-environment node
// QA 2026-11-25, cluster pull: what a device receives from pull and at sign-in, with the real Commands and
// synchronize() against every migration on PGlite (tests/corpus/world). Server-side checks: scripts/db-checks/qa-pull.mjs.
//   pnpm vitest run tests/unit/qa-pull.test.ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ client: {} as Record<string, unknown> }))
vi.mock('../../src/lib/supabase', () => ({ configured: true, telegramBot: '', supabase: h.client }))
import { ZIGGY_STAFF, menu as fullMenu, settings, stock as fullStock } from '../corpus/catalog'
import { wib } from '../corpus/trade'
import { World, type Device, type Outlet } from '../corpus/world'
import { pull, synchronize, type PullResult } from '../../src/lib/sync'
import type { Operation } from '../../src/domain/types'

const DAY = '2026-11-25'
let w: World, outlet: Outlet, laptopA: Device, laptopB: Device, till: Device
const MILK = fullStock().find((s) => !s.production)!.id
const queue = async (d: Device) => (await d.session!.db.outbox.where('state').anyOf('pending', 'rejected').toArray()).map((o) => `${o.kind}:${o.state}`)
const offline = async () => { throw Object.assign(new Error('Failed to fetch'), { name: 'Network' }) }
// One sync tick whose push fails and whose pull goes through, as the device does it.
const pullOnly = async (d: Device) => { w.server.session = d.session!.staff.id; await synchronize(d.session!.db, d.session!.identity, offline) }
beforeAll(async () => {
  w = await World.create(h.client, 11, wib(DAY, '08:00'))
  outlet = await w.outlet('ziggy', settings('Ziggy Lounge', DAY, [DAY]), ZIGGY_STAFF, null)
  laptopA = await w.device(outlet, 'Laptop A', 'office'); laptopB = await w.device(outlet, 'Laptop B', 'office'); till = await w.device(outlet, 'Kasir', 'pos')
  await w.signIn(laptopA, 'owner')
  await w.act(laptopA, 'publish', (c) => c.publish(fullMenu(), fullStock()))
  await w.act(laptopA, 'opening', (c) => c.stockRecord(MILK, 'opening', 20_000_000, 'Saldo awal', 300_000))
  await w.sync(laptopA)
}, 120_000)
afterAll(() => vi.useRealTimers())

describe('CAT-1, STK-04, SYNC-12: back-office records made on one laptop reach the other by pull', () => {
  it('a supplier, a purchase order and a catering order with its payments arrive, and a change arrives as a change', async () => {
    await w.signIn(laptopB, 'manager'); await w.sync(laptopB)
    await w.signIn(laptopA, 'admin')
    const m = (await laptopA.session!.db.menu.toArray()).find((x) => x.active && x.recipe.length)!
    const sup = (await w.act(laptopA, 'supplier', (c) => c.saveSupplier({ id: crypto.randomUUID(), name: 'Toko Beras Jaya', phone: '0812 3333 4444', address: 'Pasar Kemang', note: '', active: true })))!
    const po = (await w.act(laptopA, 'purchase', (c) => c.savePurchase({ supplierId: sup.id, supplier: sup.name, note: '', lines: [{ stockId: MILK, qty: 12_000_000, cost: 180_000 }] })))!
    const so = (await w.act(laptopA, 'catering', (c) => c.saveSalesOrder({ customer: { name: 'Ibu Ratna', phone: '0812 9999 1234', address: 'Jl. Kemang Raya 12' }, deliverAt: wib(DAY, '18:00') && new Date(wib(DAY, '18:00')).toISOString(), lines: [{ id: crypto.randomUUID(), itemId: m.id, name: m.name, qty: 10, price: m.price, catalogVersion: m.version }], discount: 0, note: '' })))!
    await w.act(laptopA, 'deposit', (c) => c.paySalesOrder(so.id, 100_000, 'outside'))
    await w.sync(laptopA)
    expect(w.findings).toEqual([])
    w.advance(30_000); await w.sync(laptopB)
    const B = laptopB.session!.db
    expect((await B.suppliers.get(sup.id))?.name).toBe('Toko Beras Jaya')
    expect((await B.purchaseOrders.get(po.id))?.status).toBe('ordered')
    expect((await B.salesOrders.get(so.id))?.payments.map((p) => p.amount)).toEqual([100_000])
    // The admin receives the delivery and takes the rest: the manager's laptop learns both on its next pull.
    await w.act(laptopA, 'receive', (c) => c.receivePurchase(po.id, po.lines, 'unpaid', true))
    await w.act(laptopA, 'balance', (c) => c.paySalesOrder(so.id, so.totals.total - 100_000, 'outside'))
    await w.sync(laptopA); w.advance(30_000); await w.sync(laptopB)
    expect((await B.purchaseOrders.get(po.id))?.status).toBe('received')
    expect((await B.salesOrders.get(so.id))?.payments.length).toBe(2)
    // And the manager's own action on that order now carries the server's revision: it is accepted, nothing halts.
    await w.act(laptopB, 'deliver', (c) => c.deliverSalesOrder(so.id))
    await w.sync(laptopB)
    expect(await queue(laptopB)).toEqual([])
    expect(w.findings).toEqual([])
    expect((await w.server.admin<{ status: string }>('select status from public.sales_orders where id=$1', [so.id]))[0].status).toBe('delivered')
  }, 120_000)
  it('a pulled record never overwrites one this laptop still has an operation queued for', async () => {
    await w.signIn(laptopA, 'admin')
    const sup = (await w.act(laptopA, 'supplier', (c) => c.saveSupplier({ id: crypto.randomUUID(), name: 'Toko Telur', phone: '', address: '', note: '', active: true })))!
    await w.sync(laptopA); w.advance(30_000); await w.sync(laptopB)
    // The manager renames it while his push fails; the admin renames it too and her change lands first.
    await w.act(laptopB, 'rename', (c) => c.saveSupplier({ ...sup, name: 'Toko Telur Jaya' }))
    await w.act(laptopA, 'rename', (c) => c.saveSupplier({ ...sup, name: 'Toko Telur Abadi' }))
    await w.sync(laptopA); w.advance(30_000)
    await pullOnly(laptopB)
    expect((await laptopB.session!.db.suppliers.get(sup.id))?.name).toBe('Toko Telur Jaya')
    expect(await queue(laptopB)).toEqual(['supplier.save:pending'])
    await w.sync(laptopB)
    expect(await queue(laptopB)).toEqual([])
  }, 60_000)
})

describe('SYNC-16: a count approved on this device stays approved while its count.record waits', () => {
  it('the pulled "submitted" row does not win over the pending approval', async () => {
    await w.signIn(till, 'siti')
    const id = crypto.randomUUID()
    await w.act(till, 'count', (c) => c.submitCount({ id, area: 'Bar', lines: [{ stockId: MILK, counted: 19_000_000, reason: '' }] }))
    await w.sync(till); w.advance(30_000); await w.sync(laptopB)
    expect((await laptopB.session!.db.counts.get(id))?.status).toBe('submitted')
    await w.act(laptopB, 'approve', (c) => c.recordCount({ id, area: 'Bar', lines: [{ stockId: MILK, counted: 19_000_000, reason: '' }] }))
    w.advance(10_000); await pullOnly(laptopB)
    expect([(await laptopB.session!.db.counts.get(id))?.status, await queue(laptopB)]).toEqual(['approved', ['count.record:pending']])
    await w.sync(laptopB)
    expect(await queue(laptopB)).toEqual([])
    // STK-02, STK-03: the till learns the approval from its pull.
    w.advance(10_000); await w.sync(till)
    expect((await till.session!.db.counts.get(id))?.status).toBe('approved')
  }, 60_000)
})

describe('F1: after a refused catalog save is discarded, the device shows the server\'s catalog again', () => {
  it('the pulled catalog is skipped while the save waits, and asked for again once it is gone', async () => {
    await w.signIn(laptopA, 'owner'); await w.sync(laptopA); w.advance(30_000); await w.sync(laptopB)
    const B = laptopB.session!.db, d = laptopB.session!
    const item = (await B.menu.toArray()).find((x) => x.active && x.recipe.length)!
    // B's save is written locally first, then refused by the server (a recipe naming a bahan the server never had: the
    // menu screen's own check cannot see it); nothing changed on the server since B's cursor.
    const mine = { ...item, price: item.price + 2000, version: item.version + 1, recipe: [{ stockId: 'bahan-hantu', qty: 1000 }] }
    await B.menu.put(mine)
    await B.outbox.add({ id: crypto.randomUUID(), kind: 'catalog.publish', payload: { menu: [mine], stock: [] }, actor: d.identity.id, restaurantId: d.identity.restaurantId, deviceId: d.identity.deviceId, occurredAt: w.iso(), state: 'pending', attempts: 0, nextAttempt: 0 })
    w.server.session = d.staff.id
    await synchronize(B, d.identity)
    expect(await queue(laptopB)).toEqual(['catalog.publish:rejected'])
    expect((await B.menu.get(item.id))?.price).toBe(item.price + 2000)
    // The next pulls bring no catalog (nothing changed on the server), and B keeps its refused version.
    w.advance(30_000); await synchronize(B, d.identity)
    expect((await B.menu.get(item.id))?.price).toBe(item.price + 2000)
    // The owner discards the refused operation (Lainnya → Sinkronisasi): the next pull shows the server's catalog again.
    const op = (await B.outbox.where('state').equals('rejected').first())!
    await B.outbox.delete(op.id)
    w.advance(30_000); await synchronize(B, d.identity)
    expect([(await B.menu.get(item.id))?.price, (await B.menu.get(item.id))?.version, await B.meta.get('pullError'), await B.meta.get('held')]).toEqual([item.price, item.version, undefined, undefined])
  }, 60_000)
  it('pull() itself: a skipped catalog is remembered, and the first free pull asks with refresh', async () => {
    const d = laptopB.session!, empty = (): PullResult => ({ now: w.iso(), orders: [], shifts: [], cash: [], movements: [], counts: [] })
    const asked: (boolean | undefined)[] = []
    const fake = async (_s: string, _d: string, refresh?: boolean) => { asked.push(refresh); return { ...empty(), catalog: { menu: await d.db.menu.toArray(), stock: await d.db.stock.toArray() }, settings: (await d.db.settings.get('settings'))! } }
    const op: Operation = { id: crypto.randomUUID(), kind: 'catalog.remove', payload: { id: 'x' }, actor: d.identity.id, restaurantId: d.identity.restaurantId, deviceId: d.identity.deviceId, occurredAt: w.iso(), state: 'pending', attempts: 0, nextAttempt: 0 }
    await d.db.outbox.add(op)
    await pull(d.db, d.identity, fake)
    expect((await d.db.meta.get('held'))?.value).toBe('1')
    await pull(d.db, d.identity, fake)
    await d.db.outbox.delete(op.id)
    await pull(d.db, d.identity, fake)
    expect([asked, await d.db.meta.get('held')]).toEqual([[undefined, undefined, true], undefined])
  })
})

describe('SYNC-09: a signed-in device whose database went empty loads everything again', () => {
  it('with no cursor and nothing queued, the next sync is a bootstrap, not a pull from now', async () => {
    await w.signIn(till, 'siti'); await w.sync(till)
    const db = till.session!.db
    expect(await db.menu.count()).toBeGreaterThan(0)
    await db.transaction('rw', db.tables, async () => { for (const t of db.tables) await t.clear() })
    expect([await db.menu.count(), await db.settings.count(), await db.meta.get('pullCursor')]).toEqual([0, 0, undefined])
    w.advance(10_000); await w.sync(till)
    expect([w.findings.filter((f) => f.where.startsWith('Kasir')), await db.meta.get('pullError')]).toEqual([[], undefined])
    expect([await db.menu.count() > 0, (await db.settings.get('settings'))?.name, (await db.meta.get('pullCursor'))?.value, (await db.meta.get('initialized'))?.value]).toEqual([true, 'Ziggy Lounge', w.iso(), 'yes'])
    expect(await db.movements.where('stockId').equals(MILK).count()).toBeGreaterThan(0)
  }, 60_000)
})

describe('pull tells the device who its person is now', () => {
  it('writes the member\'s role and access beside the device row; a person switched off is marked inactive', async () => {
    await w.sync(till)
    const db = till.session!.db
    expect(JSON.parse((await db.meta.get('member'))!.value)).toEqual({ role: 'cashier', active: true })
    const siti = w.staff('ziggy', 'siti')
    await w.server.admin('update public.memberships set active=false where user_id=$1', [siti.id])
    w.advance(10_000); await w.sync(till)
    expect(JSON.parse((await db.meta.get('member'))!.value)).toEqual({ active: false })
    await w.server.admin('update public.memberships set active=true where user_id=$1', [siti.id])
  }, 60_000)
})
