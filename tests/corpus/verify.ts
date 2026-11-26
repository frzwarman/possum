import { journal } from '../../src/domain/accounting'
import type { Books } from '../../src/domain/accounting'
import type { MenuItem, Operation } from '../../src/domain/types'
import { businessDay, type Oracle } from './oracle'
import type { Lounge } from './trade'
import type { Outlet, World } from './world'
// After the run: the server's records, its reports and every device's pulled copy, each against what the restaurant did.
// Each returns a list of differences, one line each, so a failing test prints exactly what is off.

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))
// Postgres reorders jsonb keys: compare with sorted keys, as Commands does.
export const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort()) : x))

export async function orders(world: World, o: Oracle, outlet: Outlet) {
  const out: string[] = []
  const rows = await world.server.admin<{ id: string; status: string; snapshot: { totals: Record<string, number>; receiptId: string; payment?: { method: string; edc?: string } } }>('select id,status,snapshot from public.orders where restaurant_id=$1', [outlet.id])
  const pay = new Map((await world.server.admin<{ order_id: string; method: string; total: number; tendered: number; change: number; edc: string | null }>('select order_id,method,total::float8 as total,tendered::float8 as tendered,change::float8 as change,edc from public.payments where restaurant_id=$1', [outlet.id])).map((r) => [r.order_id, r]))
  const refunds = new Map((await world.server.admin<{ order_id: string; amount: number }>('select order_id,amount::float8 as amount from public.refunds where restaurant_id=$1', [outlet.id])).map((r) => [r.order_id, r.amount]))
  const server = new Map(rows.map((r) => [r.id, r]))
  for (const x of [...o.orders.values()].filter((x) => x.outlet === outlet.key)) {
    const r = server.get(x.id), e = o.totals(x), label = `${outlet.key} order ${r?.snapshot.receiptId ?? x.id}`
    if (!r) { out.push(`${label}: missing on the server`); continue }
    if (r.status !== x.status) out.push(`${label}: status ${r.status}, expected ${x.status}`)
    if (canon(r.snapshot.totals) !== canon(e)) out.push(`${label}: totals ${canon(r.snapshot.totals)}, expected ${canon(e)}`)
    const p = pay.get(x.id)
    if (x.payment && !p) out.push(`${label}: payment missing`)
    if (p && x.payment) {
      if (p.method !== x.payment.method || (p.edc ?? undefined) !== x.payment.edc) out.push(`${label}: paid ${p.method}/${p.edc}, expected ${x.payment.method}/${x.payment.edc}`)
      if (p.total !== x.paidTotal) out.push(`${label}: payment total ${p.total}, expected ${x.paidTotal}`)
      if (x.payment.method === 'cash' && (p.tendered !== x.payment.tendered || p.change !== x.payment.tendered - x.paidTotal!)) out.push(`${label}: tendered ${p.tendered} change ${p.change}, expected ${x.payment.tendered} / ${x.payment.tendered - x.paidTotal!}`)
    }
    if (x.status === 'refunded' && refunds.get(x.id) !== x.refundTotal) out.push(`${label}: refund ${refunds.get(x.id)}, expected ${x.refundTotal}`)
  }
  for (const id of server.keys()) if (!o.orders.has(id)) out.push(`${outlet.key} order ${id}: on the server, not in the corpus`)
  return out
}

export async function shifts(world: World, o: Oracle, outlet: Outlet, edcs: string[]) {
  const out: string[] = []
  const rows = await world.server.admin<{ id: string; opening: number; counted: number | null; expected: number | null; variance: number | null; settlements: { edc: string; expected: number; slip: number }[] | null; closed: boolean }>('select id,opening::float8 as opening,counted::float8 as counted,expected::float8 as expected,variance::float8 as variance,settlements,closed_at is not null as closed from public.shifts where restaurant_id=$1', [outlet.id])
  const cash = new Map((await world.server.admin<{ shift_id: string; n: number }>('select shift_id,sum(amount)::float8 as n from public.cash_movements where restaurant_id=$1 group by 1', [outlet.id])).map((r) => [r.shift_id, r.n]))
  for (const s of [...o.shifts.values()].filter((x) => x.outlet === outlet.key)) {
    const r = rows.find((x) => x.id === s.id), label = `${outlet.key} shift ${s.openedAt}`
    if (!r) { out.push(`${label}: missing`); continue }
    if ((cash.get(s.id) ?? 0) !== s.cashMoves) out.push(`${label}: drawer movements ${cash.get(s.id) ?? 0}, expected ${s.cashMoves}`)
    if (!s.closedAt) continue
    const edc = o.expectedEdc(s.id, edcs), slips = s.slips ?? {}, slipTotal = Object.values(slips).reduce((n, v) => n + v, 0)
    const expected = o.expectedCash(s.id) + [...edc.values()].reduce((n, v) => n + v, 0), counted = s.counted! + (edcs.length ? slipTotal : 0)
    if (!r.closed) out.push(`${label}: still open on the server`)
    if (r.expected !== expected) out.push(`${label}: expected ${r.expected}, the drawer and EDCs came to ${expected}`)
    if (r.counted !== counted) out.push(`${label}: counted ${r.counted}, cashier counted ${counted}`)
    if (r.variance !== counted - expected) out.push(`${label}: variance ${r.variance}, expected ${counted - expected}`)
    for (const [e, v] of edc) { const x = r.settlements?.find((y) => y.edc === e); if (edcs.length && (!x || x.expected !== v || x.slip !== (slips[e] ?? 0))) out.push(`${label}: EDC ${e} ${JSON.stringify(x)}, expected ${v}/${slips[e] ?? 0}`) }
  }
  return out
}

// The sales report the manager pulls for a range, against the corpus. Sales count at payment and read the order as it
// stands (a voided line lowers it); compliments are not sales; refunds count on the day given back.
export async function salesReport(world: World, o: Oracle, outlet: Outlet, manager: string, from: string, to: string) {
  const out: string[] = []
  const r = await world.call(world.staff(outlet.key, manager), 'sales_report', { from_day: from, to_day: to })
  const inRange = (iso?: string) => { if (!iso) return false; const d = businessDay(iso); return d >= from && d <= to }
  const all = [...o.orders.values()].filter((x) => x.outlet === outlet.key), paid = all.filter((x) => x.payment && inRange(x.paidAt))
  const sale = paid.filter((x) => x.mode !== 'compliment'), comp = paid.filter((x) => x.mode === 'compliment')
  const sum = (xs: typeof all, f: (x: (typeof all)[number]) => number) => xs.reduce((n, x) => n + f(x), 0)
  const expect: Record<string, unknown> = {
    sales: sum(sale, (x) => o.totals(x).total), transactions: sale.length, refunds: sum(all.filter((x) => x.status === 'refunded' && inRange(x.refundAt)), (x) => x.refundTotal!),
    discounts: sum(sale, (x) => o.totals(x).discount), compliments: sum(comp, (x) => o.totals(x).discount), outstanding: sum(all.filter((x) => x.status === 'open' && inRange(x.createdAt)), (x) => o.totals(x).total),
  }
  for (const [k, v] of Object.entries(expect)) if (num(r[k]) !== v) out.push(`${outlet.key} sales_report ${from}..${to} ${k}: ${r[k]}, expected ${v}`)
  const methods: Record<string, number> = {}, edcs: Record<string, number> = {}
  for (const x of paid) { methods[x.payment!.method] = (methods[x.payment!.method] ?? 0) + o.totals(x).total; if (x.payment!.edc) edcs[x.payment!.edc] = (edcs[x.payment!.edc] ?? 0) + o.totals(x).total }
  if (canon(Object.fromEntries(Object.entries(r.methods ?? {}).map(([k, v]) => [k, Number(v)]))) !== canon(methods)) out.push(`${outlet.key} sales_report ${from}..${to} methods: ${canon(r.methods)}, expected ${canon(methods)}`)
  if (canon(Object.fromEntries(Object.entries(r.edcs ?? {}).map(([k, v]) => [k, Number(v)]))) !== canon(edcs)) out.push(`${outlet.key} sales_report ${from}..${to} edcs: ${canon(r.edcs)}, expected ${canon(edcs)}`)
  const qty = new Map<string, number>()
  for (const x of sale) for (const l of x.lines.filter((l) => !l.cancelled)) qty.set(l.name, (qty.get(l.name) ?? 0) + l.qty)
  const top = [...qty.values()].sort((a, b) => b - a).slice(0, 10)
  const best = (r.bestSellers ?? []) as { name: string; quantity: number }[]
  if (canon(best.map((b) => Number(b.quantity))) !== canon(top) || best.some((b) => qty.get(b.name) !== Number(b.quantity))) out.push(`${outlet.key} sales_report ${from}..${to} bestSellers: ${canon(best)}, expected the top quantities ${canon(top)}`)
  return out
}

// accounting_data for a range, against the corpus: which orders, stock moved per day/bahan/kind, the opening stock, the
// latest prices, the shifts and drawer floats. Then the journal the Akuntansi page builds from it must balance.
export async function accounting(world: World, o: Oracle, outlet: Outlet, who: string, from: string, to: string, menu: MenuItem[]) {
  const out: string[] = [], tag = `${outlet.key} accounting_data ${from}..${to}`
  const b = (await world.call(world.staff(outlet.key, who), 'accounting_data', { from_day: from, to_day: to })) as Books
  const inRange = (iso?: string) => { if (!iso) return false; const d = businessDay(iso); return d >= from && d <= to }
  const ids = [...o.orders.values()].filter((x) => x.outlet === outlet.key && ((x.payment && inRange(x.paidAt)) || inRange(x.refundAt))).map((x) => x.id).sort()
  if (canon(b.orders.map((x) => x.id).sort()) !== canon(ids)) out.push(`${tag} orders: ${b.orders.length} rows, expected ${ids.length} (missing ${ids.filter((i) => !b.orders.some((x) => x.id === i)).length})`)
  for (const x of b.orders) { const oo = o.orders.get(x.id); if (oo && canon(x.totals) !== canon(o.totals(oo))) out.push(`${tag} order ${x.receiptId} totals ${canon(x.totals)}, expected ${canon(o.totals(oo))}`) }
  const moves = new Map<string, { qty: number; cost: number }>(), opening = new Map<string, number>()
  for (const m of o.moves.filter((m) => m.outlet === outlet.key)) {
    const d = businessDay(m.at)
    if (d < from) opening.set(m.stockId, (opening.get(m.stockId) ?? 0) + m.qty)
    if (d < from || d > to) continue
    const k = [d, m.stockId, m.kind, m.comp].join('|'), row = moves.get(k) ?? { qty: 0, cost: 0 }
    row.qty += m.qty; row.cost += m.qty < 0 ? -m.cost : m.cost; moves.set(k, row)
  }
  // The server keeps unpriced deliveries and production batches in rows of their own; the totals per day, bahan and kind are what is compared.
  const server = new Map<string, { qty: number; cost: number }>()
  for (const m of b.moves) { const k = [m.day, m.stockId, m.kind, m.comp].join('|'), r = server.get(k) ?? { qty: 0, cost: 0 }; r.qty += Number(m.qty); r.cost += Number(m.cost); server.set(k, r) }
  for (const k of new Set([...moves.keys(), ...server.keys()])) {
    const e = moves.get(k), a = server.get(k)
    if ((e?.qty ?? 0) !== (a?.qty ?? 0) || (e?.cost ?? 0) !== (a?.cost ?? 0)) out.push(`${tag} moves ${k}: ${canon(a)}, expected ${canon(e)}`)
  }
  for (const id of new Set([...opening.keys(), ...Object.keys(b.opening)])) if ((opening.get(id) ?? 0) !== Number(b.opening[id] ?? 0)) out.push(`${tag} opening ${id}: ${b.opening[id]}, expected ${opening.get(id) ?? 0}`)
  const latest = new Map<string, number>()
  for (const m of o.moves.filter((m) => m.outlet === outlet.key && businessDay(m.at) <= to && m.qty > 0 && m.cost > 0 && ['purchase', 'production', 'transfer'].includes(m.kind))) latest.set(m.stockId, m.cost / m.qty)
  for (const id of new Set([...latest.keys(), ...Object.keys(b.costs)])) { const e = latest.get(id), a = b.costs[id] === undefined ? undefined : Number(b.costs[id]); if (e === undefined || a === undefined || Math.abs(e - a) > 1e-9 * Math.max(1, e)) out.push(`${tag} cost ${id}: ${a}, expected ${e}`) }
  const closed = [...o.shifts.values()].filter((s) => s.outlet === outlet.key && inRange(s.closedAt))
  if (b.shifts.length !== closed.length) out.push(`${tag} shifts: ${b.shifts.length}, expected ${closed.length}`)
  const all = [...o.shifts.values()].filter((s) => s.outlet === outlet.key).sort((a, z) => a.openedAt.localeCompare(z.openedAt))
  const opened = all.flatMap((s, i) => (inRange(s.openedAt) ? [{ at: s.openedAt, opening: s.opening, prior: i ? (all[i - 1].counted ?? null) : 0 }] : []))
  if (canon(b.opened.map((x) => ({ at: x.at, opening: Number(x.opening), prior: x.prior === null ? null : Number(x.prior) }))) !== canon(opened)) out.push(`${tag} opened: ${canon(b.opened)}, expected ${canon(opened)}`)
  // The page's journal from these books: every journal balances, debits equal credits.
  const dayOf = (iso: string) => businessDay(iso)
  const { entries } = journal(b, menu, { from, to, dayOf })
  const refs = new Map<string, number>()
  for (const e of entries) refs.set(e.ref, (refs.get(e.ref) ?? 0) + e.debit - e.credit)
  for (const [ref, v] of refs) if (v !== 0) out.push(`${tag} journal ${ref} does not balance: debit − credit = ${v}`)
  return out
}

// The first differing field of two records, for a readable failure.
function diff(a: unknown, b: unknown, path = ''): string {
  if (canon(a) === canon(b)) return ''
  if (a && b && typeof a === 'object' && typeof b === 'object') for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`); if (d) return d }
  return `${path}: server ${JSON.stringify(a)?.slice(0, 120)}, device ${JSON.stringify(b)?.slice(0, 120)}`
}
// Every device, after its last pull: what it holds against the server. Stock on hand per bahan must match on every
// device; an office device holds every order as the server has it, a till the ones its role is sent.
export async function pulled(world: World) {
  const out: string[] = []
  for (const d of world.devices.values()) {
    const s = d.session
    if (!s) continue
    await world.sync(d)
    const tag = `${d.name} · ${s.staff.key}`, rid = d.outlet.id
    const server = new Map((await world.server.admin<{ stock_id: string; qty: number }>('select stock_id,sum(qty)::float8 as qty from public.stock_movements where restaurant_id=$1 group by 1', [rid])).map((r) => [r.stock_id, r.qty]))
    const local = new Map<string, number>()
    for (const m of await s.db.movements.toArray()) local.set(m.stockId, (local.get(m.stockId) ?? 0) + m.qty)
    for (const id of new Set([...server.keys(), ...local.keys()])) if ((server.get(id) ?? 0) !== (local.get(id) ?? 0)) out.push(`${tag}: stock ${id} on the device ${local.get(id) ?? 0}, on the server ${server.get(id) ?? 0}`)
    const rows = new Map((await world.server.admin<{ id: string; snapshot: unknown }>('select id,snapshot from public.orders where restaurant_id=$1', [rid])).map((r) => [r.id, r.snapshot]))
    // A device keeps the newest 500 orders from sign-in on (by design, see 202611200001_accounting.sql), so only the
    // copies it holds are compared; an office device is sent every change to them.
    const office = ['owner', 'manager', 'admin', 'chef'].includes(s.identity.role)
    for (const x of await s.db.orders.toArray()) { const r = rows.get(x.id); if (r && office && canon(r) !== canon(x)) out.push(`${tag}: order ${x.receiptId} differs from the server's copy: ${diff(r, x)}`) }
    // Shifts and drawer movements: the copies a device holds, as pull and bootstrap shape them for its role.
    const managers = ['owner', 'manager'].includes(s.identity.role)
    const shifts = new Map((await world.server.admin<{ id: string; j: unknown }>('select s.id,public.shift_json(s,$2) as j from public.shifts s where s.restaurant_id=$1', [rid, managers])).map((r) => [r.id, r.j]))
    for (const x of await s.db.shifts.toArray()) { const r = shifts.get(x.id); if (r && canon(r) !== canon(x)) out.push(`${tag}: shift ${x.openedAt} differs from the server's copy: ${diff(r, x)}`) }
    const cash = new Map((await world.server.admin<{ id: string; j: unknown }>('select c.id,public.cash_json(c) as j from public.cash_movements c where c.restaurant_id=$1', [rid])).map((r) => [r.id, r.j]))
    for (const x of await s.db.cash.toArray()) { const r = cash.get(x.id); if (!r) out.push(`${tag}: drawer movement ${x.id} (${x.amount}) only on the device`); else if (canon(r) !== canon(x)) out.push(`${tag}: drawer movement ${x.id} differs from the server's copy: ${diff(r, x)}`) }
    const pending = await world.pending(d)
    if (pending) out.push(`${tag}: ${pending} operations still waiting to be sent`)
  }
  return out
}

// Sends every accepted operation again, as its actor: the server must answer with the receipt it gave the first time and
// change nothing.
export async function replay(world: World, ops: Operation[]) {
  const out: string[] = []
  const state = async () => canon(await world.server.admin(`select (select count(*) from public.sync_operations)::int as ops,(select count(*) from public.orders)::int as orders,(select coalesce(sum(revision),0) from public.orders)::int as revisions,
    (select count(*) from public.stock_movements)::int as moves,(select coalesce(sum(qty),0)::text from public.stock_movements) as qty,(select count(*) from public.payments)::int as payments,(select count(*) from public.cash_movements)::int as cash,
    (select coalesce(sum(amount),0)::text from public.cash_movements) as drawer,(select count(*) from public.shifts where closed_at is not null)::int as closed,(select count(*) from public.counts)::int as counts,(select count(*) from public.purchase_orders)::int as pos,(select count(*) from public.sales_orders)::int as sos,(select count(*) from public.transfers)::int as transfers`))
  const before = await state()
  for (const op of ops) {
    const first = (await world.server.admin<{ result: unknown }>('select result from public.sync_operations where id=$1', [op.id]))[0]?.result
    world.server.session = op.actor
    const { operation } = { operation: { id: op.id, kind: op.kind, actor: op.actor, restaurantId: op.restaurantId, deviceId: op.deviceId, occurredAt: op.occurredAt, payload: op.payload, state: 'pending', attempts: 0, nextAttempt: 0 } }
    const { data, error } = await world.server.rpc('apply_operation', { operation })
    if (error) out.push(`replay ${op.kind} ${op.id}: ${error.code} ${error.message}`)
    else if (canon(data) !== canon(first)) out.push(`replay ${op.kind} ${op.id}: answered ${canon(data)}, first ${canon(first)}`)
  }
  const after = await state()
  if (after !== before) out.push(`replay changed the server: ${before} → ${after}`)
  return out
}
export type { Lounge }
