import { itemStation, menuType } from '../../src/domain/calculate'
import type { Line, MenuItem } from '../../src/domain/types'
import { DAGO_STAFF, ZIGGY_STAFF, menu, packs, settings, stock } from './catalog'
import { World } from './world'
// A small Ziggy for one scenario: the full catalog published, opening stock on the bahan the scenario names, the till,
// the laptop and a station tablet paired, Siti signed in on the till. 07:00 in Jakarta on 2 November.
export async function small(client: Record<string, unknown>, seed: number, opening: string[], over: Partial<ReturnType<typeof settings>> = {}) {
  const w = await World.create(client, seed, Date.parse('2026-11-02T00:00:00Z'))
  const s = { ...settings('Ziggy Lounge', '2026-11-02', ['2026-11-02', '2026-11-03', '2026-11-04']), ...over }
  const group = w.rand.uuid(), z = await w.outlet('ziggy', s, ZIGGY_STAFF, group)
  const dago = await w.outlet('dago', { ...settings('Ziggy Dago', '2026-11-02', ['2026-11-02']), edcs: [], discounts: [] }, DAGO_STAFF, group)
  const till = await w.device(z, 'Ziggy kasir', 'pos'), laptop = await w.device(z, 'Ziggy laptop', 'office'), bar = await w.device(z, 'Ziggy bar', 'station')
  await w.signIn(laptop, 'owner')
  await w.act(laptop, 'catalog.publish', (c) => c.publish(menu(), stock()))
  for (const id of opening) { const p = packs.get(id); await w.act(laptop, 'opening', (c) => c.stockRecord(id, 'opening', (p?.qty ?? 1_000_000) * 10, 'Saldo awal', p ? p.price * 10 : 0)) }
  await w.sync(laptop)
  await w.signIn(till, 'siti')
  return { w, z, dago, till, laptop, bar }
}
// A line as Pos.tsx builds it, from an item on the device.
export function line(item: MenuItem, qty = 1, mods: string[] = [], note = ''): Line {
  return { id: crypto.randomUUID(), itemId: item.id, name: item.name, price: item.price, qty, modifiers: item.modifiers.filter((m) => mods.includes(m.id)), note, recipe: item.recipe, catalogVersion: item.version, prepared: false, cancelled: false, station: itemStation(item), type: menuType(item) }
}
export const draft = (lines: Line[], over: Record<string, unknown> = {}) => ({ id: 'current', revision: 0, label: 'Pager 1', mode: 'dinein' as const, lines, discount: 0, discountReason: '', ...over })
export async function balance(w: World, rid: string, stockId: string) {
  return Number((await w.server.admin<{ q: string }>('select coalesce(sum(qty),0)::text as q from public.stock_movements where restaurant_id=$1 and stock_id=$2', [rid, stockId]))[0].q)
}
