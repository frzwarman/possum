// @vitest-environment node
// QA 2026-11-25, cluster catalog: publishing the menu and the bahan list (menu/F1 F2 F8 F9, sql/SQL-05 SQL-17,
// sync/SYNC-13, perf/PERF-7). Two back-office laptops of one restaurant drive the real Commands and synchronize()
// against every migration on PGlite (tests/corpus). A laptop pulls every 30 seconds, so "has not pulled yet" is the
// normal state of the second laptop in a recipe session.
import { afterEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ client: {} as Record<string, unknown> }))
vi.mock('../../src/lib/supabase', () => ({ configured: true, telegramBot: '', supabase: h.client }))
import { Commands } from '../../src/lib/commands'
import { databaseFor } from '../../src/lib/db'
import { sampleMenu, stock as sampleStock } from '../../src/domain/sample'
import type { Identity, MenuItem, Operation, StockItem } from '../../src/domain/types'
import { small } from '../corpus/small'
import type { Device, World } from '../corpus/world'

afterEach(() => vi.useRealTimers())
const problems = (w: World) => w.findings.filter((f) => f.kind === 'rejected' || f.kind === 'stuck').map((f) => `${f.where} ${f.what}: ${f.detail}`)
const refusals = (w: World) => w.findings.filter((f) => f.kind === 'refused').map((f) => f.detail)
// What the menu editor's "Simpan versi menu" does: the one item, at the next version.
const saveMenu = (w: World, d: Device, id: string, change: Partial<MenuItem>) => w.act(d, `simpan menu ${id}`, async (c, s) => { const m = (await s.db.menu.get(id))!; await c.publish([{ ...m, ...change, version: m.version + 1 }], []) })
// What "Simpan bahan" does: the one bahan.
const saveBahan = (w: World, d: Device, id: string, change: Partial<StockItem>) => w.act(d, `simpan bahan ${id}`, async (c, s) => { const b = (await s.db.stock.get(id))!; await c.publish([], [{ ...b, ...change }]) })
const live = async (w: World, rid: string) => Object.fromEntries((await w.server.admin<{ id: string; version: number; price: string }>("select c.id,c.version,v.snapshot->>'price' as price from public.catalog_items c join public.catalog_versions v on v.restaurant_id=c.restaurant_id and v.item_id=c.id and v.version=c.version where c.restaurant_id=$1", [rid])).map((r) => [r.id, `v${r.version} Rp${r.price}`]))
const published = async (d: Device) => (await d.session!.db.outbox.orderBy('occurredAt').toArray()).filter((o) => o.kind === 'catalog.publish').map((o) => o.payload as { menu: MenuItem[]; stock: StockItem[] })
const shown = async (d: Device, id: string) => { const m = await d.session!.db.menu.get(id); return m ? `v${m.version} Rp${m.price}` : 'tidak ada' }
// Ziggy with its owner on one laptop and its manager on a second one, both freshly signed in.
async function twoLaptops(seed: number, opening: string[] = []) {
  const s = await small(h.client, seed, opening), B = await s.w.device(s.z, 'Ziggy laptop 2', 'office')
  await s.w.signIn(B, 'manager')
  return { w: s.w, z: s.z, A: s.laptop, B }
}

describe('QA catalog: two laptops edit the menu and the bahan list', () => {
  it('menu/F1: a laptop that has not pulled the other laptop\'s save still saves another menu, and its later work syncs', async () => {
    const { w, z, A, B } = await twoLaptops(201, ['susu-segar'])
    await saveMenu(w, A, 'americano', { price: 26000 }); await w.sync(A)
    // B has not synced since: it still shows the old americano. It changes only the latte, then records waste.
    expect(await shown(B, 'americano')).toBe('v1 Rp25000')
    await saveMenu(w, B, 'latte', { price: 33000 })
    await w.act(B, 'waste', (c) => c.stockRecord('susu-segar', 'waste', 100_000, 'Tumpah'))
    await w.sync(B)
    expect(problems(w)).toEqual([])
    expect(refusals(w)).toEqual([])
    expect(await w.pending(B)).toBe(0)
    expect(await live(w, z.id)).toMatchObject({ americano: 'v2 Rp26000', latte: 'v2 Rp33000' })
    // After that sync B shows the server's menu: the other laptop's change and its own.
    expect([await shown(B, 'americano'), await shown(B, 'latte')]).toEqual(['v2 Rp26000', 'v2 Rp33000'])
    // menu/F9, perf/PERF-7: the save carried the one menu it changed, not the catalog.
    expect((await published(B)).map((p) => [p.menu.map((m) => m.id), p.stock.length])).toEqual([[['latte'], 0]])
  }, 60_000)

  it('sync/SYNC-13, sql/SQL-17: a bahan edited on one laptop survives a menu save and a bahan save from a laptop that has not pulled', async () => {
    const { w, z, A, B } = await twoLaptops(202)
    await saveBahan(w, A, 'susu-segar', { threshold: 9_000_000, packs: [{ name: 'karton', qty: 12_000_000 }] }); await w.sync(A)
    await saveMenu(w, B, 'latte', { price: 33000 })
    await saveBahan(w, B, 'kopi-house', { area: 'Rak bar QA' })
    await w.sync(B)
    expect(problems(w)).toEqual([])
    const bahan = async (id: string) => (await w.server.admin<{ threshold: string; area: string; packs: unknown }>('select threshold::text as threshold,area,packs from public.inventory_items where restaurant_id=$1 and id=$2', [z.id, id]))[0]
    expect(await bahan('susu-segar')).toMatchObject({ threshold: '9000000', packs: [{ name: 'karton', qty: 12_000_000 }] })
    expect((await bahan('kopi-house')).area).toBe('Rak bar QA')
    expect((await published(B)).map((p) => [p.menu.map((m) => m.id), p.stock.map((s) => s.id)])).toEqual([[['latte'], []], [[], ['kopi-house']]])
    // "Simpan bahan" with nothing changed is not an operation at all.
    await saveBahan(w, B, 'kopi-house', {})
    expect((await published(B)).length).toBe(2)
  }, 60_000)

  it('menu/F8: a menu removed on one laptop stays removed when a laptop that still lists it saves something else', async () => {
    const { w, z, A, B } = await twoLaptops(203)
    expect(await w.act(A, 'hapus menu', (c) => c.removeMenu(['aneh-belum-laku']))).toBe(true); await w.sync(A)
    expect(await shown(B, 'aneh-belum-laku')).not.toBe('tidak ada')
    await saveMenu(w, B, 'latte', { price: 33000 }); await w.sync(B)
    expect(problems(w)).toEqual([])
    expect(Object.keys(await live(w, z.id))).not.toContain('aneh-belum-laku')
    expect(await shown(B, 'aneh-belum-laku')).toBe('tidak ada')
  }, 60_000)

  it('menu/F2: saving a menu the other laptop changed a moment ago is refused on the device with a message; nothing is queued', async () => {
    const { w, z, A, B } = await twoLaptops(204)
    await saveMenu(w, A, 'americano', { price: 26000 }); await w.sync(A)
    // B has not pulled: its copy is still v1, and its save would be v2 with other content.
    expect(await saveMenu(w, B, 'americano', { price: 27000 })).toBeUndefined()
    expect(refusals(w)).toEqual([expect.stringMatching(/Hot Americano.*diubah di perangkat lain/)])
    expect(await w.pending(B)).toBe(0)
    expect(await shown(B, 'americano')).toBe('v1 Rp25000')
    // Once it has pulled, the same edit goes through as v3.
    await w.sync(B)
    expect(await saveMenu(w, B, 'americano', { price: 27000 })).toBe(true); await w.sync(B)
    expect(problems(w)).toEqual([])
    expect((await live(w, z.id)).americano).toBe('v3 Rp27000')
  }, 60_000)

  it('an import passes the whole lists; only the rows it adds or changes are sent, and a chef needs no PIN for old recipe-less menus', async () => {
    const { w, z, B } = await twoLaptops(205)
    // Two new menus with a recipe, one bahan with a new "nama lain", as Settings.applyImport builds them.
    const added: MenuItem[] = ['Kopi Susu QA', 'Teh Tarik QA'].map((name, i) => ({ id: `qa-${i}`, name, category: 'Minuman', type: 'beverage', station: 'bar', tags: [], aliases: [], groups: [], lowAt: 5, price: 20000, active: true, soldOut: false, favorite: false, version: 1, modifiers: [], recipe: [{ stockId: 'susu-segar', qty: 150_000 }] }))
    // One active menu without a recipe is already live (the manager published it, no PIN): for the chef it is not news.
    expect(await w.act(B, 'menu tanpa resep', (c) => c.publish([{ ...added[0], id: 'qa-live-bare', name: 'Air putih QA', recipe: [] }], []))).toBe(true)
    await w.signIn(B, 'chef')
    const s = B.session!, menu = await s.db.menu.toArray(), stock = await s.db.stock.toArray()
    expect(menu.some((m) => m.active && !m.recipe.length)).toBe(true)
    expect(await w.act(B, 'impor', (c) => c.publish([...menu, ...added], stock.map((b) => (b.id === 'susu-segar' ? { ...b, aliases: [...(b.aliases ?? []), 'milk'] } : b))))).toBe(true)
    await w.sync(B)
    expect(problems(w)).toEqual([])
    expect((await published(B)).map((p) => [p.menu.map((m) => m.id), p.stock.map((b) => b.id)])).toEqual([[['qa-0', 'qa-1'], ['susu-segar']]])
    expect(await live(w, z.id)).toMatchObject({ 'qa-0': 'v1 Rp20000', 'qa-1': 'v1 Rp20000' })
    // MENU-7 still holds for what IS news: a new active menu without a recipe needs the manager's PIN.
    expect(await w.act(B, 'menu tanpa resep', (c) => c.publish([{ ...added[0], id: 'qa-bare', name: 'Bare QA', recipe: [] }], []))).toBeUndefined()
    expect(refusals(w)).toEqual(['Perlu persetujuan manajer'])
  }, 60_000)

  it('the app as deployed before this fix (the whole catalog with every save) is still accepted from a laptop that has not pulled', async () => {
    const { w, z, A, B } = await twoLaptops(206)
    await saveMenu(w, A, 'americano', { price: 26000 })
    expect(await w.act(A, 'hapus menu', (c) => c.removeMenu(['aneh-belum-laku']))).toBe(true); await w.sync(A)
    // git HEAD's Commands.publish queued every menu and every bahan the device held, the edited one at version + 1.
    const s = B.session!, menu = await s.db.menu.toArray(), stock = await s.db.stock.toArray()
    const send = async (payload: Record<string, unknown>) => { w.server.session = s.staff.id; return (await w.server.rpc('apply_operation', { operation: { id: crypto.randomUUID(), kind: 'catalog.publish', actor: s.identity.id, restaurantId: z.id, deviceId: B.id, occurredAt: w.iso(), payload } })).error }
    expect(await send({ menu: menu.map((m) => (m.id === 'latte' ? { ...m, price: 33000, version: m.version + 1 } : m)), stock })).toBeNull()
    const now = await live(w, z.id)
    expect(now).toMatchObject({ americano: 'v2 Rp26000', latte: 'v2 Rp33000' })
    expect(Object.keys(now)).not.toContain('aneh-belum-laku')
    // The same stale catalog once more, as that app's "Simpan bahan" sends it: nothing in it is news.
    expect(await send({ menu, stock })).toBeNull()
    expect(await live(w, z.id)).toEqual(now)
  }, 60_000)
})

// The device's own checks, without a server (the demo): what Commands.publish refuses before anything is queued.
describe('QA catalog: Commands.publish on the device', () => {
  let n = 0
  async function demo(role: Identity['role'] = 'owner') {
    const user: Identity = { id: `demo-${role}`, name: 'Uji', role, restaurantId: `qa-catalog-${++n}-${Date.now()}`, deviceId: 'dev', primary: false, demo: true, mode: 'office' }
    const db = databaseFor(user)
    await db.menu.bulkPut(sampleMenu); await db.stock.bulkPut(sampleStock)
    return { db, commands: new Commands(db, user) }
  }
  const sent = async (db: Awaited<ReturnType<typeof demo>>['db']) => (await db.outbox.toArray() as Operation[]).filter((o) => o.kind === 'catalog.publish').map((o) => o.payload as { menu: MenuItem[]; stock: StockItem[] })
  const [first] = sampleMenu

  it('sends and stores one edited menu; every other menu and bahan on the device stays as it was', async () => {
    const { db, commands } = await demo()
    await commands.publish([{ ...first, price: first.price + 1000, version: first.version + 1 }], [])
    expect(await sent(db)).toEqual([{ menu: [{ ...first, price: first.price + 1000, version: first.version + 1 }], stock: [] }])
    expect(await db.menu.count()).toBe(sampleMenu.length)
    expect((await db.menu.get(first.id))?.price).toBe(first.price + 1000)
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)
    expect((await db.stock.toArray()).sort(byId)).toEqual([...sampleStock].sort(byId))
  })

  it('checks a recipe against every bahan the device holds, not only the ones being sent', async () => {
    const { commands } = await demo()
    await commands.publish([{ ...first, recipe: [{ stockId: sampleStock[0].id, qty: 1000 }], version: first.version + 1 }], [])
    await expect(commands.publish([{ ...first, recipe: [{ stockId: 'durian', qty: 1000 }], version: first.version + 2 }], [])).rejects.toThrow('Resep')
    // A bahan sent in the same save counts too (an import adds both at once).
    await commands.publish([{ ...first, recipe: [{ stockId: 'durian', qty: 1000 }], version: first.version + 2 }], [{ id: 'durian', name: 'Durian', unit: 'g', threshold: 0 }])
  })

  it('keeps the catalog within 500 menus and 1.000 bahan in total, however few rows one save carries', async () => {
    const { db, commands } = await demo()
    const more = (count: number): MenuItem[] => Array.from({ length: count }, (_, i) => ({ ...first, id: `m-${i}`, name: `Menu ${i}`, version: 1 }))
    await expect(commands.publish(more(501 - sampleMenu.length), [])).rejects.toThrow('Katalog maksimal 500 menu')
    await expect(commands.publish([], Array.from({ length: 1001 - sampleStock.length }, (_, i) => ({ id: `s-${i}`, name: `Bahan ${i}`, unit: 'g' as const, threshold: 0 })))).rejects.toThrow('Katalog maksimal 500 menu')
    expect(await db.outbox.count()).toBe(0)
    await commands.publish(more(500 - sampleMenu.length), [])
    expect(await db.menu.count()).toBe(500)
  })

  it('menu/F7: a JPEG photo (WebKit cannot encode WebP) passes the same check as a WebP, under the same cap', async () => {
    const { db, commands } = await demo()
    for (const photo of ['data:image/jpeg;base64,/9j/4AAQSkZJRg==', 'data:image/webp;base64,UklGRg=='])
      await commands.publish([{ ...first, photo, version: first.version + 1 }], [])
    for (const photo of ['data:image/png;base64,iVBORw0KGgo=', `data:image/jpeg;base64,${'A'.repeat(70_000)}`, 'data:image/jpeg;base64,<svg>'])
      await expect(commands.publish([{ ...first, photo, version: first.version + 1 }], []), photo.slice(0, 30)).rejects.toThrow('Foto menu')
    expect((await db.outbox.count())).toBe(2)
  })

  it('sql/SQL-05: refuses a menu or bahan row with a missing field, as the server now does', async () => {
    const { db, commands } = await demo()
    const good: MenuItem = { ...first, id: 'qa', name: 'QA', version: 1 }
    for (const bad of [{ recipe: undefined }, { modifiers: undefined }, { active: undefined }, { active: null }, { version: 0 }, { version: 1.5 }, { id: '' }, { name: undefined }, { category: undefined }, { price: undefined }])
      await expect(commands.publish([{ ...good, ...bad } as unknown as MenuItem], []), JSON.stringify(bad)).rejects.toThrow()
    for (const bad of [{ id: '' }, { name: undefined }, { unit: undefined }, { threshold: undefined }, { production: { output: 1000 } }, { production: { inputs: [{ stockId: sampleStock[0].id, qty: 1000 }] } }])
      await expect(commands.publish([], [{ id: 'qa', name: 'QA', unit: 'g', threshold: 0, ...bad } as unknown as StockItem]), JSON.stringify(bad)).rejects.toThrow()
    expect(await db.outbox.count()).toBe(0)
  })
})
