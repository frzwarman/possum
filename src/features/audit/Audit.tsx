import { Fragment, useEffect, useRef, useState } from 'react'
import { SkeletonRows } from '../../components/ui/loading'
import { Navigate } from '@tanstack/react-router'
import { ReceiptText, RefreshCw, ScrollText, Search } from 'lucide-react'
import { useApp, useMovements } from '../../app/context'
import { Button } from '../../components/ui/button'
import { Select } from '../../components/ui/select'
import { businessDay, complimentDiscount, lineUse, menuType, orderTotals, quantity, rupiah, stamp, when } from '../../domain/calculate'
import { can, roleLabel } from '../../domain/permissions'
import type { Line, MenuItem, Order, Role } from '../../domain/types'
import { csv, download } from '../../lib/db'
import { supabase } from '../../lib/supabase'
interface Entry { id: string; kind: string; at: string; actor: string; actorName: string; role?: string; device?: string; mode?: string | null; approvedBy?: string | null; payload: Record<string, unknown> }
interface View { chip: string; tone: string; title: string; detail: string; reason?: string; change?: [string, string][] }
const KINDS: Record<string, string> = { 'order.void': 'Pembatalan', 'order.voidline': 'Pembatalan item', 'refund.record': 'Refund', 'order.save': 'Diskon', 'shift.cash': 'Kas keluar/masuk', 'stock.record': 'Stok', 'count.record': 'Hitung stok', 'catalog.publish': 'Menu & bahan', 'catalog.remove': 'Menu dihapus', 'settings.update': 'Pengaturan', 'shift.close': 'Tutup sif', 'shift.open': 'Buka sif', 'purchase.receive': 'Pembelian dari laci', 'purchase.pay': 'Bayar pembelian dari laci', 'salesorder.pay': 'Bayar katering ke laci', 'salesorder.cancel': 'Katering dibatalkan', 'transfer.send': 'Kirim stok', 'production.record': 'Produksi', 'staff.change': 'Peran staf', 'device.enroll': 'Perangkat dipasangkan', 'device.revoke': 'Perangkat dicabut', 'ledger.remove': 'Catatan kas dihapus' }
// Money in or out of the drawer through a purchase or a catering order is sensitive only when it is the drawer's.
const DRAWER = ['purchase.receive', 'purchase.pay', 'salesorder.pay', 'salesorder.cancel']
// Figma M3 filter pills, each over the audit kinds it covers; Pengaturan shows only when there is one.
const GROUPS: [string, string[]][] = [['Pembatalan', ['order.void', 'order.voidline', 'refund.record']], ['Diskon', ['order.save']], ['Stok', ['stock.record', 'count.record', 'transfer.send', 'production.record']], ['Menu & harga', ['catalog.publish', 'catalog.remove']], ['Kas', ['shift.cash', 'shift.close', 'shift.open', ...DRAWER, 'ledger.remove']], ['Pengaturan', ['settings.update']], ['Akses', ['staff.change', 'device.enroll', 'device.revoke']]]
const STOCK: Record<string, string> = { waste: 'Terbuang', adjustment: 'Penyesuaian', count: 'Stok', purchase: 'Stok masuk', opening: 'Stok awal' }
const DEVICE: Record<string, string> = { pos: 'Kasir utama', station: 'Tablet stasiun', office: 'Back office (laptop)', phone: 'Ponsel stok' }
const PAGE = 1000
const PERIODS = [{ value: '0', label: 'Hari ini' }, { value: '6', label: '7 hari terakhir' }, { value: '29', label: '30 hari terakhir' }, { value: 'custom', label: 'Rentang lain' }]
const pairs = (...list: unknown[]) => list.filter((p): p is [string, string] => Array.isArray(p) && Boolean(p[1]))
// CTL-3: every sensitive action, who did it, from which device, who approved it; nobody can edit it.
export default function Audit() {
 const { user, settings, outbox, db, orders, shifts, cash, stockItems, menu, costs, counts } = useApp()
 const movements=useMovements()
 const tz = settings?.timezone
 const day = (iso: string) => businessDay(iso, tz, settings?.cutoff), today = day(new Date().toISOString())
 const back = (n: number) => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10) }
 const shift = (d: string, n: number) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return Number.isNaN(+x) ? '' : x.toISOString().slice(0, 10) }, back94 = (d: string) => shift(d, -93), ahead94 = (d: string) => shift(d, 93)
 const [from, setFrom] = useState(() => back(6))
 const [to, setTo] = useState(today)
 const [custom, setCustom] = useState(false)
 const [rows, setRows] = useState<Entry[]>([])
 const [source, setSource] = useState<'server' | 'local'>(user.demo ? 'local' : 'server')
 const [query, setQuery] = useState(''); const [group, setGroup] = useState(''); const [pick, setPick] = useState(''); const [error, setError] = useState<{ text: string; local: boolean }>(); const [busy, setBusy] = useState(false); const ticket = useRef(0)
 // Offline, or in the demo: what this device itself sent, from its own outbox (one database per person, so all theirs).
 async function loadLocal() {
  const ops = await db.outbox.toArray()
  // The till saves an order again at "Ke stasiun" and at "Bayar": a discount is one entry, however many saves carry it.
  const was = new Map<string, string>()
  const list = ops.filter((op) => day(op.occurredAt) >= from && day(op.occurredAt) <= to).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).filter((op) => {
   if (!(op.kind in KINDS)) return false
   if (DRAWER.includes(op.kind)) return op.payload.payment === 'drawer'
   if (op.kind !== 'order.save') return true
   const o = op.payload.order as { id?: string; discount?: number; discountReason?: string } | undefined, key = `${o?.discount ?? 0}|${o?.discountReason ?? ''}`, same = was.get(o?.id ?? '') === key
   was.set(o?.id ?? '', key); return (o?.discount ?? 0) > 0 && !same
  })
  setRows(list.reverse()
   .map((op) => ({ id: op.id, kind: op.kind, at: op.occurredAt, actor: op.actor, actorName: op.actor === user.id ? user.name : op.actor.slice(0, 8), role: op.actor === user.id ? user.role : undefined, mode: user.mode ?? (user.primary ? 'pos' : null), approvedBy: approverOf(op.kind, op.payload, op.id), payload: op.payload })))
 }
 const approverOf = (kind: string, p: Record<string, unknown>, id: string) => {
  if (kind === 'order.void') return orders.find((o) => o.id === p.id)?.voidApprovedBy ?? null
  if (kind === 'order.voidline') return orders.find((o) => o.id === p.id)?.lines.find((l) => l.id === p.lineId)?.voidApprovedBy ?? null
  if (kind === 'refund.record') return orders.find((o) => o.id === p.id)?.refund?.approvedBy ?? null
  if (kind === 'order.save') return orders.find((o) => o.id === (p.order as { id?: string } | undefined)?.id)?.discountApprovedBy ?? null
  if (kind === 'shift.cash') return cash.find((c) => c.id === id)?.approvedBy ?? null
  if (kind === 'shift.close') return shifts.find((s) => s.id === p.id)?.varianceApprovedBy ?? null
  if (kind === 'count.record') return counts.find((c) => c.id === p.id)?.approvedBy ?? null
  return null
 }
 // QA RPT-5, SQL-06, RPT-11: the server sends at most 1.000 entries a call; ask again from the last one until a page is short,
 // so the list and the export hold them all. Only an unreachable server falls back to this device's own log; any other
 // answer is shown as it is.
 async function load() {
  const mine = ++ticket.current; setBusy(true); setError(undefined)
  try {
   if ((Date.parse(to) - Date.parse(from)) / 864e5 > 93) { setRows([]); setError({ text: 'Rentang log audit paling lama 94 hari.', local: false }); return }
   if (source === 'local' || !supabase) { await loadLocal(); return }
   const all: Entry[] = []
   for (let page = 0; ; page++) {
    const last = all.at(-1)
    const { data, error } = await supabase.rpc('audit_log', { from_day: from, to_day: to, page: PAGE, ...(last && { after_at: last.at, after_id: last.id }) })
    if (mine !== ticket.current) return
    if (error) { if (error.code) { setRows([]); setError({ text: error.message === 'Audit range limited to 94 days' ? 'Rentang log audit paling lama 94 hari.' : `Log audit gagal dimuat: ${error.message}`, local: false }); return } throw new Error(error.message || 'Gagal memuat log') }
    const got = data as unknown as Entry[]; all.push(...got); setRows([...all])
    if (got.length < PAGE) return
    if (page >= 99) { setError({ text: 'Terlalu banyak entri untuk dimuat; persempit rentangnya.', local: false }); return }
   }
  } catch (e) { if (mine !== ticket.current) return; setError({ text: e instanceof Error ? e.message : 'Gagal memuat log', local: true }); await loadLocal() } finally { if (mine === ticket.current) setBusy(false) }
 }
 useEffect(() => { void load() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [from, to, source])
 if (!can(user.role, 'audit')) return <Navigate to="/pos" />
 const order = (id: unknown) => orders.find((o) => o.id === id)
 const name = (o: Order | undefined, id: unknown) => o ? o.label || o.receiptId : String(id).slice(0, 8)
 const item = (id: string) => stockItems.find((s) => s.id === id)
 const signed = (v: number) => `${v < 0 ? '−' : '+'}${rupiah(Math.abs(Math.round(v)))}`
 const amount = (stockId: string, qty: number) => { const s = item(stockId); return `${s?.name ?? stockId} ${qty < 0 ? '−' : '+'}${quantity(Math.abs(qty))} ${s?.unit ?? ''}`.trimEnd() }
 const worth = (list: { stockId: string; qty: number }[]) => list.reduce((n, m) => n + m.qty * (costs.get(m.stockId) ?? 0), 0)
 const price = (l: Line) => (l.price + l.modifiers.reduce((n, m) => n + m.price, 0)) * l.qty
 // A made line already took its ingredients; a void does not put them back (the server does the same).
 const used = (o: Order, lines: Line[]) => { const m = new Map<string, number>(); for (const l of lines) if (l.prepared) for (const r of lineUse(l, o.mode === 'takeaway' ? o.settings.packaging : [])) m.set(r.stockId, (m.get(r.stockId) ?? 0) + r.qty); return [...m].map(([s, q]) => amount(s, -q)).join(', ') }
 const drink = (l: Line) => { const m = menu.find((x) => x.id === l.itemId); return m ? menuType(m) === 'beverage' : l.station === 'bar' }
 // The bill with some lines off, priced as voidLine prices it (a compliment re-prices itself).
 const bill = (o: Order, off: (l: Line) => boolean = (l) => l.cancelled, discount?: number) => { try { const lines = o.lines.map((l) => ({ ...l, cancelled: off(l) })); return orderTotals({ lines, discount: discount ?? (o.compliment ? complimentDiscount(lines, o.compliment.kind, drink) : o.discount), mode: o.mode }, o.settings).total } catch { return undefined } }
 const moved = new Map(movements.map((m) => [m.id, m]))
 // Each entry in plain words: the chip, a title, one line for the table, and what it changed when that is known.
 function explain(e: Entry): View {
  const p = e.payload as Record<string, any>
  switch (e.kind) {
   case 'order.void': { const o = order(p.id), n = name(o, p.id)
    return { chip: 'Pembatalan', tone: 'critical', title: `Pembatalan ${n}`, detail: `Seluruh pesanan ${n}${o ? `, ${rupiah(o.totals.total)}` : ''}. ${p.reason}`, reason: p.reason, change: pairs(o && ['Total pesanan', `${rupiah(o.totals.total)} → ${rupiah(0)}`], o && ['Stok tidak kembali', used(o, o.lines.filter((l) => !l.cancelled))]) } }
   case 'order.voidline': { const o = order(p.id), n = name(o, p.id), l = o?.lines.find((x) => x.id === p.lineId)
    // Lines voided after this one were still on the bill at the time.
    const later = new Set(rows.filter((r) => r.kind === 'order.voidline' && r.payload.id === p.id && r.at > e.at).map((r) => r.payload.lineId))
    const before = o && l && bill(o, (x) => x.cancelled && x.id !== l.id && !later.has(x.id)), after = o && l && bill(o, (x) => x.cancelled && !later.has(x.id))
    return { chip: 'Pembatalan', tone: 'critical', title: `Pembatalan ${n}`, detail: l ? `${l.qty}× ${l.name}, ${rupiah(price(l))}, ${n}. ${p.reason}` : `Satu menu di ${n}. ${p.reason}`, reason: p.reason, change: pairs(before !== undefined && after !== undefined && ['Total pesanan', `${rupiah(before)} → ${rupiah(after)}`], o && l && ['Stok tidak kembali', used(o, [l])]) } }
   case 'refund.record': { const o = order(p.id), n = name(o, p.id)
    return { chip: 'Refund', tone: 'critical', title: `Refund ${n}`, detail: `${n}${o ? `, ${rupiah(o.totals.total)} dikembalikan` : ''}. ${p.reason}`, reason: p.reason } }
   case 'order.save': { const o = p.order as Order, n = name(o, o?.id), c = o?.compliment, full = o && bill(o, undefined, 0)
    const change = pairs(full !== undefined && ['Total pesanan', `${rupiah(full)} → ${rupiah(o.totals.total)}`])
    // Figma M3 files a staff meal under Diskon; the line and title still say which compliment it was.
    return c ? { chip: 'Diskon', tone: 'warning', title: `${c.kind === 'staff' ? 'Staff meal' : 'Keluarga pemilik'} ${n}`, detail: `${c.kind === 'staff' ? 'Staff meal' : 'Keluarga pemilik'} untuk ${c.who}, ${n}: potongan ${rupiah(o.discount)}`, reason: o.discountReason, change }
     : { chip: 'Diskon', tone: 'warning', title: `Diskon ${n}`, detail: `Diskon ${rupiah(o?.discount ?? 0)} di ${n}. ${o?.discountReason ?? ''}`, reason: o?.discountReason, change } }
   case 'stock.record': { const s = item(p.stockId), chip = STOCK[p.kind] ?? 'Stok', qty: number | undefined = moved.get(e.id)?.qty ?? (p.kind === 'waste' ? -Math.abs(p.qty) : p.kind === 'count' ? undefined : p.qty)
    const val = qty === undefined ? 0 : worth([{ stockId: p.stockId, qty }]), what = qty === undefined ? `${s?.name ?? p.stockId} dihitung ${quantity(p.qty)} ${s?.unit ?? ''}` : `${amount(p.stockId, qty)}${val ? ` (${signed(val)})` : ''}`
    return { chip, tone: 'neutral', title: s?.name ?? chip, detail: p.kind === 'waste' && qty !== undefined ? `${s?.name ?? p.stockId} ${quantity(Math.abs(qty))} ${s?.unit ?? ''}, ${p.reason}` : `${chip}: ${what}. ${p.reason}`, reason: p.reason, change: pairs(['Stok', what], p.fromDrawer && ['Dibayar dari kas', rupiah(p.cost)]) } }
   case 'count.record': { const diff = movements.filter((m) => m.kind === 'count' && m.recordId === p.id && m.qty !== 0), v = worth(diff), list = diff.map((m) => amount(m.stockId, m.qty))
    const why = ((p.lines ?? []) as { stockId: string; reason?: string }[]).filter((l) => l.reason).map((l) => `${item(l.stockId)?.name ?? l.stockId}: ${l.reason}`).join(', ')
    return { chip: 'Stok', tone: 'neutral', title: `Hitung ${p.area}`, detail: diff.length ? `Hitung ${p.area}: ${list.slice(0, 2).join(', ')}${diff.length > 2 ? ` dan ${diff.length - 2} lainnya` : ''}${v ? ` (${signed(v)})` : ''}` : `Hitung ${p.area}: ${(p.lines ?? []).length} bahan, tanpa selisih`, reason: why, change: pairs(['Selisih', list.join(', ')], v !== 0 && ['Nilai selisih', signed(v)]) } }
   case 'catalog.publish': { const prev = rows.find((r) => r.kind === 'catalog.publish' && r.at < e.at), was = new Map(((prev?.payload.menu ?? []) as MenuItem[]).map((m) => [m.id, m.price])), list = (p.menu ?? []) as MenuItem[]
    // A price change is only named when the publish before it is in range to compare with.
    const priced = list.flatMap((m) => was.has(m.id) && was.get(m.id) !== m.price ? [`${m.name} ${rupiah(was.get(m.id) ?? 0)} → ${rupiah(m.price)}`] : []), what = `${list.length} menu, ${(p.stock ?? []).length} bahan`
    return priced.length ? { chip: 'Harga', tone: 'info', title: 'Perubahan harga', detail: priced.join(', '), change: pairs(['Harga', priced.join(', ')], ['Diterbitkan', what]) } : { chip: 'Menu', tone: 'info', title: 'Menu diterbitkan', detail: `${what} diterbitkan`, change: pairs(['Diterbitkan', what]) } }
   case 'catalog.remove': return { chip: 'Menu', tone: 'info', title: 'Menu dihapus', detail: `${(p.ids ?? []).length} menu dihapus` }
   case 'settings.update': return { chip: 'Pengaturan', tone: 'neutral', title: 'Pengaturan diubah', detail: `Pengaturan ${p.settings?.name ?? 'restoran'} disimpan` }
   case 'shift.cash': { const chip = p.amount < 0 ? 'Kas keluar' : 'Kas masuk'
    return { chip, tone: 'warning', title: `${chip} ${rupiah(Math.abs(p.amount))}`, detail: `${chip} ${rupiah(Math.abs(p.amount))}. ${p.reason}`, reason: p.reason } }
   case 'shift.close': { const s = shifts.find((x) => x.id === p.id), gap = s?.variance
    return { chip: gap ? 'Selisih kas' : 'Tutup sif', tone: gap ? 'warning' : 'good', title: s ? `Sif ${s.cashier} ditutup` : 'Sif ditutup', detail: gap === undefined ? `Sif ditutup, dihitung ${rupiah(p.counted ?? 0)}` : gap ? `Sif ditutup, ${gap < 0 ? 'kurang' : 'lebih'} ${rupiah(Math.abs(gap))}` : 'Sif ditutup, pas', change: pairs(s?.expected !== undefined && ['Seharusnya → dihitung', `${rupiah(s.expected)} → ${rupiah(s.counted ?? 0)}`], ...(s?.settlements ?? []).filter((x) => x.slip !== x.expected).map((x) => [`EDC ${x.edc}`, `slip ${rupiah(x.slip)}, tercatat ${rupiah(x.expected)}`])) } }
   case 'shift.open': return { chip: 'Buka sif', tone: 'neutral', title: 'Sif dibuka', detail: `Sif dibuka dengan modal kas ${rupiah(p.opening ?? 0)}` }
   case 'purchase.receive': case 'purchase.pay': return { chip: 'Kas', tone: 'warning', title: 'Pembelian dibayar dari laci', detail: `Pembelian dibayar dari laci kas${p.amount ? `, ${rupiah(p.amount)}` : ''}` }
   case 'salesorder.pay': return { chip: 'Kas', tone: 'warning', title: 'Pembayaran katering ke laci', detail: `Pembayaran katering ${rupiah(p.amount ?? 0)} masuk ke laci kas` }
   case 'salesorder.cancel': return { chip: 'Kas', tone: 'warning', title: 'Katering dibatalkan', detail: `Pesanan katering dibatalkan${p.refund ? `, ${rupiah(p.refund)} dikembalikan dari laci kas` : ''}. ${p.reason ?? ''}`, reason: p.reason }
   case 'transfer.send': return { chip: 'Stok', tone: 'neutral', title: 'Stok dikirim', detail: 'Stok dikirim ke outlet lain' }
   case 'production.record': return { chip: 'Stok', tone: 'neutral', title: 'Produksi', detail: `Produksi ${item(p.stockId)?.name ?? p.stockId ?? ''}${p.qty ? ` ${quantity(p.qty)} ${item(p.stockId)?.unit ?? ''}` : ''}`.trimEnd(), reason: p.note }
   case 'staff.change': { const was = roleLabel[p.from as Role] ?? p.from, now = roleLabel[p.to as Role] ?? p.to
    return { chip: 'Akses', tone: 'warning', title: `Peran ${p.name}`, detail: p.from !== p.to ? `${p.name}: ${was} → ${now}` : `${p.name} ${p.active ? 'diaktifkan' : 'dinonaktifkan'}`, change: pairs(['Peran', `${was} → ${now}`], p.wasActive !== p.active && ['Akun', p.active ? 'aktif' : 'nonaktif']) } }
   case 'device.enroll': return { chip: 'Akses', tone: 'warning', title: 'Perangkat dipasangkan', detail: `Perangkat dipasangkan sebagai ${DEVICE[p.mode] ?? p.mode}`, change: pairs(['Perangkat', String(p.device ?? '').slice(0, 8)]) }
   case 'device.revoke': return { chip: 'Akses', tone: 'warning', title: 'Perangkat dicabut', detail: `Perangkat ${DEVICE[p.mode] ?? p.mode ?? ''} dicabut`.trimEnd() }
   case 'ledger.remove': return { chip: 'Kas', tone: 'warning', title: 'Catatan kas dihapus', detail: `Catatan ${p.entryKind} ${rupiah(p.amount ?? 0)} tanggal ${p.day} dihapus${p.note ? `. ${p.note}` : ''}` }
   default: return { chip: KINDS[e.kind] ?? e.kind, tone: 'neutral', title: KINDS[e.kind] ?? e.kind, detail: '' }
  }
 }
 // An old or odd payload never blanks the page: it shows as its kind.
 const views = new Map<string, View>()
 for (const r of rows) { try { views.set(r.id, explain(r)) } catch { views.set(r.id, { chip: KINDS[r.kind] ?? r.kind, tone: 'neutral', title: KINDS[r.kind] ?? r.kind, detail: '' }) } }
 const view = (r: Entry) => views.get(r.id)!
 const q = query.trim().toLowerCase()
 const found = q ? rows.filter((r) => { const v = view(r); return [v.chip, v.title, v.detail, v.reason, r.actorName, r.approvedBy, KINDS[r.kind]].join(' ').toLowerCase().includes(q) }) : rows
 const groups = GROUPS.map(([label, kinds]) => ({ label, kinds, n: found.filter((r) => kinds.includes(r.kind)).length })).filter((g) => (g.label !== 'Pengaturan' && g.label !== 'Akses') || g.n || group === g.label)
 const shown = group ? found.filter((r) => GROUPS.find(([l]) => l === group)?.[1].includes(r.kind)) : found
 const picked = shown.find((r) => r.id === pick) ?? shown[0]
 const period = custom ? 'custom' : (to === today && PERIODS.find((x) => x.value !== 'custom' && from === back(+x.value))?.value) || 'custom'
 const time = (iso: string) => { const d = day(iso); return when(iso, tz, d === today ? { hour: '2-digit', minute: '2-digit' } : d >= back(6) ? { weekday: 'short', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }
 const approved = (r: Entry, how: string) => r.approvedBy ? `${r.approvedBy}${r.payload.approval ? how : ''}` : '—'
 const exportCsv = () => download(`takar-audit-${from}-${to}.csv`, csv([['Waktu', 'Jenis', 'Siapa', 'Peran', 'Perangkat', 'Apa', 'Disetujui'], ...shown.map((r) => [stamp(r.at, tz), KINDS[r.kind] ?? r.kind, r.actorName, r.role ?? '', r.mode ?? '', view(r).detail, r.approvedBy ?? ''])]), 'text/csv')
 const v = picked && view(picked)
 // The picked entry: in the right panel on a laptop, under its own row on narrower screens.
 const entry = picked && v && <div className="audit-entry">
  <span className={`dot-chip ${v.tone}`}>{v.chip}</span>
  <h2>{v.title}</h2>
  <dl>
   <div><dt>Waktu</dt><dd>{when(picked.at, tz, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</dd></div>
   <div><dt>Diminta oleh</dt><dd>{picked.actorName}{roleLabel[picked.role as Role] ? `, ${roleLabel[picked.role as Role].toLowerCase()}` : ''}</dd></div>
   <div><dt>Disetujui oleh</dt><dd>{approved(picked, ', PIN manajer')}</dd></div>
   <div><dt>Perangkat</dt><dd>{DEVICE[picked.mode ?? ''] ?? '—'}</dd></div>
   {v.reason && <div><dt>Alasan</dt><dd>{v.reason}</dd></div>}
  </dl>
  {v.change?.length ? <div className="audit-change">{v.change.map(([k, x]) => <div key={k}><span>{k}</span><strong>{x}</strong></div>)}</div> : null}
 </div>
 return <section className="page-content audit-page">
  <div className="page-heading"><div><h1>Log audit</h1><p className="muted">Setiap pembatalan, diskon, perubahan harga, penyesuaian dan selisih kas. Tidak bisa diubah atau dihapus.</p></div>
   <div className="button-row">
    {!user.demo && <div className="pill-selects"><Select ariaLabel="Sumber" value={source} onChange={(x) => setSource(x as typeof source)} options={[{ value: 'server', label: 'Server (semua perangkat)' }, { value: 'local', label: 'Perangkat ini saja' }]} /></div>}
    <div className="pill-selects"><Select ariaLabel="Periode" value={period} onChange={(x) => { setCustom(x === 'custom'); if (x !== 'custom') { setFrom(back(+x)); setTo(today) } }} options={PERIODS} /></div>
    <Button variant="secondary" size="icon" aria-label="Muat ulang" aria-busy={busy || undefined} disabled={busy} onClick={() => load()}><RefreshCw size={18} className={busy ? 'spin' : undefined} /></Button>
    <Button variant="secondary" onClick={exportCsv}><ReceiptText size={18} /> Ekspor ke Excel</Button>
   </div>
  </div>
  <div className="audit-filters">
   <div className="search-box compact"><Search size={18} /><input aria-label="Cari di log audit" placeholder="Cari pesanan, menu, orang" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
   <div className="pill-tabs">{[{ id: '', label: 'Semua', n: found.length }, ...groups.map((g) => ({ id: g.label, label: g.label, n: g.n }))].map((g) => <button key={g.label} type="button" className={group === g.id ? 'active' : ''} aria-pressed={group === g.id} onClick={() => setGroup(g.id)}>{g.label}<small>{g.n}</small></button>)}</div>
   {period === 'custom' && <div className="audit-range"><input type="date" aria-label="Dari tanggal" value={from} min={back94(to)} max={to} onChange={(e) => setFrom(e.target.value)} /><span>sampai</span><input type="date" aria-label="Sampai tanggal" value={to} min={from} max={ahead94(from)} onChange={(e) => setTo(e.target.value)} /></div>}
  </div>
  {error && <p className="callout" role="alert">{error.local ? `Server tidak terjangkau (${error.text}); menampilkan catatan perangkat ini.` : error.text}</p>}
  <div className="audit-grid">
   <article className="panel audit-log">
    {shown.length ? <div className="table-scroll"><table className="data-table plain-table audit-table"><thead><tr><th>Waktu</th><th>Aksi</th><th>Detail</th><th>Oleh</th><th>Disetujui</th></tr></thead><tbody>
     {shown.map((r) => { const x = view(r), on = r.id === picked?.id
      return <Fragment key={r.id}><tr className={on ? 'on' : undefined} tabIndex={0} aria-selected={on} onClick={() => setPick(r.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPick(r.id) } }}>
       <td className="audit-time">{time(r.at)}</td><td><span className={`dot-chip ${x.tone}`}>{x.chip}</span></td><td>{x.detail}</td><td data-label="Oleh"><strong>{r.actorName}</strong></td><td data-label="Disetujui">{r.approvedBy ? <strong>{approved(r, ', PIN')}</strong> : '—'}</td></tr>
       {on && <tr className="audit-inline"><td colSpan={5}>{entry}</td></tr>}</Fragment> })}
    </tbody></table></div> : busy ? <SkeletonRows label="Memuat log audit" count={5} /> : <p className="muted">{rows.length ? 'Tidak ada yang cocok dengan pencarian atau filter ini.' : 'Tidak ada catatan di rentang ini.'}</p>}
    <p className="audit-note"><ScrollText size={14} /><span>{rows.length ? `${rows.length} entri${busy ? ', memuat...' : ''}. ` : ''}{source === 'local' && outbox.length > 0 ? `${outbox.length} operasi belum tersinkron ikut ditampilkan. ` : ''}Catatan server ditulis sekali dan tidak pernah diubah; ekspor pemulihan di Lainnya memuat salinannya dari perangkat ini.</span></p>
   </article>
   <aside className="panel audit-detail">{entry || <p className="muted">Rincian catatan yang dipilih muncul di sini.</p>}</aside>
  </div>
 </section>
}
