import { convert, sanity } from '../domain/calculate'
import type { Delivery, DeliveryLine, Job, PhoneStock } from './types'

// The server's ceiling for one stock entry's cost.
const MAX_COST = 1_000_000_000

// The units a delivery can be typed in: each pack, then kg or L for a bahan kept in g or ml, then the base unit.
// per = thousandths of the base unit in one. A name is offered once: lemons bought by a pack called "kg" have that
// pack, not a second kg beside it.
export function units(item: PhoneStock): { name: string; per: number }[] {
  const big = item.unit === 'g' ? [{ name: 'kg', per: 1_000_000 }] : item.unit === 'ml' ? [{ name: 'l', per: 1_000_000 }] : []
  const all = [...(item.packs ?? []).map((p) => ({ name: p.name, per: p.qty })), ...big, { name: item.unit, per: 1000 }]
  return all.filter((u, i) => all.findIndex((x) => x.name === u.name) === i)
}
const per = (item: PhoneStock, unit: string) => units(item).find((u) => u.name === unit)?.per

// Thousandths of the base unit. Blank or zero means nothing arrived; anything else goes through Takar's own
// convert(), which throws its message on a bad number ("2,5" is fine, "3 karton" is not).
export function lineQty(item: PhoneStock, line: DeliveryLine): number {
  return /[1-9]/.test(line.amount) ? convert(line.amount, line.unit, item.unit, item.packs) : 0
}

// amount × price in whole rupiah. Thousands dots are forgiven ("216.000"). A blank price is 0, which is safe:
// Takar's unit cost only reads deliveries that have a price.
export function lineCost(item: PhoneStock, line: DeliveryLine): number {
  const p = per(item, line.unit)
  return p ? Math.round((lineQty(item, line) / p) * Number(line.price.replace(/\D/g, '') || 0)) : 0
}

// The last price paid, as a prefill for one `unit`; '' when Takar has no price for this bahan yet.
export function suggestedPrice(item: PhoneStock, unit: string): string {
  const p = per(item, unit)
  return item.cost && p ? String(Math.round(item.cost * p)) : ''
}

// PUR-4: an amount over 5× or under a fifth of the usual delivery needs a second look, until the person confirms
// exactly that quantity: the same digits in another unit, or in a pack that was resized since, ask again.
// An amount that does not parse is not flagged here; saving reports it.
export function flag(item: PhoneStock, line: DeliveryLine): 'high' | 'low' | undefined {
  let qty = 0
  try {
    qty = lineQty(item, line)
  } catch {
    return undefined
  }
  if (line.checked === qty) return undefined
  const verdict = qty > 0 ? sanity(qty, item.usual ?? []) : 'ok'
  return verdict === 'ok' ? undefined : verdict
}
// "Ya, benar": the person looked at the nota and this is what came. Only offered for a line flag() has flagged,
// so the amount parses.
export const confirmed = (item: PhoneStock, line: DeliveryLine): DeliveryLine => ({ ...line, checked: lineQty(item, line) })

// One stock.record per line, as the Stok page's "Terima kiriman" sends it. The job id is the line's own id, so
// saving the same delivery twice cannot put the stock in twice. The note photo rides on the first line only.
export function deliveryJobs(delivery: Delivery, stock: PhoneStock[], actor: string, now: string): Job[] {
  const reason = delivery.note.trim()
  if (!reason) throw new Error('Isi pemasok atau nomor nota')
  const rows = delivery.lines.flatMap((line) => {
    const item = stock.find((s) => s.id === line.stockId)
    const qty = item ? lineQty(item, line) : 0
    return item && qty > 0 ? [{ line, item, qty }] : []
  })
  if (!rows.length) throw new Error('Tambahkan bahan yang datang')
  if (rows.some((r) => flag(r.item, r.line))) throw new Error('Cek jumlah yang ditandai')
  return rows.map(({ line, item, qty }, i): Job => {
    const cost = lineCost(item, line)
    if (cost > MAX_COST) throw new Error('Harga terlalu besar')
    return {
      id: line.id, actor, occurredAt: now, label: `Kiriman ${item.name}`, state: 'pending', type: 'op', kind: 'stock.record',
      payload: { stockId: item.id, kind: 'purchase', qty, reason, cost, fromDrawer: false, ...(i === 0 && delivery.photo ? { photo: delivery.photo } : {}) },
    }
  })
}
