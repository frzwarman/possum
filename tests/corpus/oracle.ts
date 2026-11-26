import type { Discount, Ingredient, MenuItem, MenuType, Settings } from '../../src/domain/types'
// What the restaurant actually did, kept by the corpus itself and priced by its own arithmetic (the rules in the PRDs and
// src/domain/types.ts comments), not by src/domain/calculate.ts, so a wrong number on both the till and the server
// still shows. One instance per restaurant group; everything is keyed by outlet.

export interface OLine { id: string; itemId: string; version: number; qty: number; mods: string[]; cancelled: boolean; name: string }
export interface OOrder {
  id: string; outlet: string; shiftId: string; mode: 'dinein' | 'takeaway' | 'compliment'; comp?: 'staff' | 'family'; lines: OLine[]
  // manual: a manager-approved amount; saved: the definition the till priced it with.
  discount: { kind: 'none' } | { kind: 'manual'; amount: number } | { kind: 'saved'; def: Discount }
  status: 'open' | 'paid' | 'void' | 'refunded'; createdAt: string; paidAt?: string; paidTotal?: number; refundAt?: string; refundTotal?: number
  payment?: { method: 'cash' | 'qris' | 'card' | 'none'; tendered: number; edc?: string }
}
export interface OMove { outlet: string; at: string; stockId: string; kind: string; qty: number; cost: number; comp: boolean; recordId: string }
export interface OShift { id: string; outlet: string; opening: number; openedAt: string; closedAt?: string; counted?: number; slips?: Record<string, number>; cashMoves: number }
const BEVERAGE = /minum|drink|kopi|coffee|tea|teh|juice|jus/i, SNACK = /camilan|snack|tambahan|side/i
export const typeOf = (m: Pick<MenuItem, 'type' | 'category'>): MenuType => m.type ?? (BEVERAGE.test(m.category) ? 'beverage' : SNACK.test(m.category) ? 'snack' : 'food')

export class Oracle {
  readonly versions = new Map<string, MenuItem>()
  readonly settings = new Map<string, Settings>()
  readonly orders = new Map<string, OOrder>()
  readonly moves: OMove[] = []
  readonly shifts = new Map<string, OShift>()
  readonly balance = new Map<string, number>()
  // Latest price per thousandth: [at, unit] per outlet|stock, from purchases, batches and transfers that came in priced.
  readonly cost = new Map<string, [string, number]>()

  publish(outlet: string, menu: MenuItem[]) { for (const m of menu) this.versions.set(`${outlet}|${m.id}|${m.version}`, structuredClone(m)) }
  item(outlet: string, l: Pick<OLine, 'itemId' | 'version'>) { const m = this.versions.get(`${outlet}|${l.itemId}|${l.version}`); if (!m) throw new Error(`oracle: no ${l.itemId} v${l.version}`); return m }
  value(outlet: string, l: OLine) { const m = this.item(outlet, l); return (m.price + l.mods.reduce((n, id) => n + m.modifiers.find((x) => x.id === id)!.price, 0)) * l.qty }
  live(o: OOrder) { return o.lines.filter((l) => !l.cancelled) }
  subtotal(o: OOrder) { return this.live(o).reduce((n, l) => n + this.value(o.outlet, l), 0) }
  savedAmount(o: Pick<OOrder, 'outlet' | 'lines'>, d: Discount) {
    const live = o.lines.filter((l) => !l.cancelled), all = live.reduce((n, l) => n + this.value(o.outlet, l), 0)
    if ((d.minSpend ?? 0) > all) return 0
    const base = live.filter((l) => d.scope === 'order' || (d.scope === 'items' ? (d.items ?? []).includes(l.itemId) : typeOf(this.item(o.outlet, l)) === d.scope)).reduce((n, l) => n + this.value(o.outlet, l), 0)
    return Math.min(base, d.kind === 'percent' ? Math.floor((base * d.value) / 100) : d.value)
  }
  discount(o: OOrder) {
    if (o.mode === 'compliment') {
      let free = 0, food = 0
      for (const l of this.live(o)) { const v = this.value(o.outlet, l); if (o.comp === 'family' || typeOf(this.item(o.outlet, l)) === 'beverage') free += v; else food += v }
      return free + Math.floor(food / 2)
    }
    return o.discount.kind === 'manual' ? o.discount.amount : o.discount.kind === 'saved' ? this.savedAmount(o, o.discount.def) : 0
  }
  totals(o: OOrder) {
    const s = this.settings.get(o.outlet)!, comp = o.mode === 'compliment', subtotal = this.subtotal(o), discount = this.discount(o)
    const service = comp ? 0 : Math.floor(((subtotal - discount) * s.serviceBps + 5000) / 10000)
    const tax = comp ? 0 : Math.floor(((subtotal - discount + service) * s.taxBps + 5000) / 10000)
    return { subtotal, discount, service, tax, total: subtotal - discount + service + tax }
  }
  // Per line: base recipe, option deltas and (takeaway) packaging, netted per ingredient, never below zero, times qty.
  use(o: OOrder, lines: OLine[]) {
    const out = new Map<string, number>(), pack = o.mode === 'takeaway' ? this.settings.get(o.outlet)!.packaging : []
    for (const l of lines) {
      const m = this.item(o.outlet, l), per = new Map<string, number>()
      for (const r of [...m.recipe, ...l.mods.flatMap((id) => m.modifiers.find((x) => x.id === id)!.recipe), ...pack]) per.set(r.stockId, (per.get(r.stockId) ?? 0) + r.qty)
      for (const [id, q] of per) if (q > 0) out.set(id, (out.get(id) ?? 0) + q * l.qty)
    }
    return out
  }
  // Stock: every movement is kept, the balance follows.
  move(outlet: string, at: string, stockId: string, kind: string, qty: number, cost: number, recordId: string, comp = false) {
    this.moves.push({ outlet, at, stockId, kind, qty, cost, comp, recordId })
    this.balance.set(`${outlet}|${stockId}`, this.on(outlet, stockId) + qty)
    if (qty > 0 && cost > 0 && ['purchase', 'production', 'transfer'].includes(kind)) this.cost.set(`${outlet}|${stockId}`, [at, cost / qty])
  }
  on(outlet: string, stockId: string) { return this.balance.get(`${outlet}|${stockId}`) ?? 0 }
  unit(outlet: string, stockId: string) { return this.cost.get(`${outlet}|${stockId}`)?.[1] }
  prepare(o: OOrder, at: string, lines: OLine[]) { for (const [id, q] of this.use(o, lines)) this.move(o.outlet, at, id, 'preparation', -q, 0, o.id, o.mode === 'compliment') }
  // A batch is costed at its inputs' latest prices; an input never priced counts as zero (op_production).
  produce(outlet: string, at: string, stockId: string, qty: number, inputs: Ingredient[], record: string) {
    const cost = Math.min(1_000_000_000, Math.round(inputs.reduce((n, i) => n + i.qty * (this.unit(outlet, i.stockId) ?? 0), 0)))
    this.move(outlet, at, stockId, 'production', qty, cost, record)
    for (const i of inputs) this.move(outlet, at, i.stockId, 'production', -i.qty, 0, record)
    return cost
  }
  // The drawer: float, cash sales still standing (a refund gives them back, a voided line already lowered the total),
  // and every cash movement of the shift.
  expectedCash(shiftId: string) {
    const s = this.shifts.get(shiftId)!
    return s.opening + [...this.orders.values()].filter((o) => o.shiftId === shiftId && o.payment?.method === 'cash' && o.status !== 'refunded').reduce((n, o) => n + this.totals(o).total, 0) + s.cashMoves
  }
  expectedEdc(shiftId: string, edcs: string[]) {
    const out = new Map(edcs.map((e) => [e, 0]))
    for (const o of this.orders.values()) if (o.shiftId === shiftId && o.status === 'paid' && o.payment?.edc) out.set(o.payment.edc, (out.get(o.payment.edc) ?? 0) + this.totals(o).total)
    return out
  }
}
// The business day an instant belongs to: the restaurant's date, a day earlier before the cutoff hour.
export function businessDay(iso: string, cutoff = 4, offsetHours = 7) {
  const local = new Date(Date.parse(iso) + (offsetHours - cutoff) * 3600_000)
  return local.toISOString().slice(0, 10)
}
