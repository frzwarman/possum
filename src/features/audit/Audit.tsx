import { useEffect, useState } from 'react'
import { Navigate } from '@tanstack/react-router'
import { Download, RefreshCw, ScrollText } from 'lucide-react'
import { useApp } from '../../app/context'
import { Button } from '../../components/ui/button'
import { Select } from '../../components/ui/select'
import { businessDay, quantity, rupiah, stamp, when } from '../../domain/calculate'
import { can } from '../../domain/permissions'
import { csv, download } from '../../lib/db'
import { supabase } from '../../lib/supabase'
interface Entry { id: string; kind: string; at: string; actor: string; actorName: string; role?: string; device?: string; mode?: string | null; approvedBy?: string | null; payload: Record<string, unknown> }
const KINDS: Record<string, string> = { 'order.void': 'Pembatalan', 'refund.record': 'Refund', 'order.save': 'Diskon', 'shift.cash': 'Kas keluar/masuk', 'stock.record': 'Stok', 'count.record': 'Hitung stok', 'catalog.publish': 'Menu & bahan', 'settings.update': 'Pengaturan', 'shift.close': 'Tutup sif' }
// CTL-3: every sensitive action, who did it, from which device, who approved it; nobody can edit it.
export default function Audit() {
 const { user, settings, outbox, db, orders, shifts, cash, stockItems } = useApp()
 const day = (iso: string) => businessDay(iso, settings?.timezone, settings?.cutoff), today = day(new Date().toISOString())
 const [from, setFrom] = useState(() => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 6); return d.toISOString().slice(0, 10) })
 const [to, setTo] = useState(today)
 const [rows, setRows] = useState<Entry[]>([])
 const [source, setSource] = useState<'server' | 'local'>(user.demo ? 'local' : 'server')
 const [who, setWho] = useState(''); const [kind, setKind] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
 const item = (id: unknown) => stockItems.find((s) => s.id === id)?.name ?? String(id)
 const order = (id: unknown) => { const o = orders.find((o) => o.id === id); return o ? `${o.label || o.receiptId} · ${rupiah(o.totals.total)}` : String(id).slice(0, 8) }
 // What happened, in one line, from the operation's own payload.
 function describe(e: Entry): string {
  const p = e.payload as Record<string, any>
  switch (e.kind) {
   case 'order.void': return `${order(p.id)} · ${p.reason}`
   case 'refund.record': return `${order(p.id)} · ${p.reason}`
   case 'order.save': return `${order(p.order?.id)} · diskon ${rupiah(p.order?.discount ?? 0)} · ${p.order?.discountReason ?? ''}`
   case 'shift.cash': return `${p.amount < 0 ? 'keluar' : 'masuk'} ${rupiah(Math.abs(p.amount))} · ${p.reason}`
   case 'stock.record': return `${p.kind} ${item(p.stockId)} ${p.kind === 'waste' ? '−' : ''}${quantity(Math.abs(p.qty))} · ${p.reason}`
   case 'count.record': return `${p.area} · ${(p.lines ?? []).length} bahan`
   case 'catalog.publish': return `${(p.menu ?? []).length} menu, ${(p.stock ?? []).length} bahan`
   case 'settings.update': return `${p.settings?.name ?? ''}`
   case 'shift.close': { const s = shifts.find((s) => s.id === p.id); return s ? `dihitung ${rupiah(s.counted ?? 0)} · selisih ${rupiah(s.variance ?? 0)}` : `dihitung ${rupiah(p.counted ?? 0)}` }
   default: return ''
  }
 }
 // Offline, or in the demo: what this device itself sent, from its own outbox.
 async function loadLocal() {
  const ops = await db.outbox.toArray()
  setRows(ops.filter((op) => day(op.occurredAt) >= from && day(op.occurredAt) <= to && (op.kind in KINDS) && (op.kind !== 'order.save' || ((op.payload.order as { discount?: number } | undefined)?.discount ?? 0) > 0))
   .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
   .map((op) => ({ id: op.id, kind: op.kind, at: op.occurredAt, actor: op.actor, actorName: op.actor === user.id ? user.name : op.actor.slice(0, 8), mode: user.mode ?? (user.primary ? 'pos' : null), approvedBy: approverOf(op.kind, op.payload), payload: op.payload })))
 }
 const approverOf = (kind: string, p: Record<string, unknown>) => {
  if (kind === 'order.void') return orders.find((o) => o.id === p.id)?.voidApprovedBy ?? null
  if (kind === 'refund.record') return orders.find((o) => o.id === p.id)?.refund?.approvedBy ?? null
  if (kind === 'order.save') return orders.find((o) => o.id === (p.order as { id?: string } | undefined)?.id)?.discountApprovedBy ?? null
  if (kind === 'shift.cash') return cash.find((c) => c.id === (p as { shiftId?: string }).shiftId && c.amount === p.amount)?.approvedBy ?? null
  if (kind === 'shift.close') return shifts.find((s) => s.id === p.id)?.varianceApprovedBy ?? null
  return null
 }
 async function load() {
  setBusy(true); setError('')
  try {
   if (source === 'local' || !supabase) { await loadLocal(); return }
   const { data, error } = await supabase.rpc('audit_log', { from_day: from, to_day: to })
   if (error) throw error
   setRows(data as unknown as Entry[])
  } catch (e) { setError(e instanceof Error ? e.message : 'Gagal memuat log'); await loadLocal() } finally { setBusy(false) }
 }
 useEffect(() => { void load() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [from, to, source])
 if (!can(user.role, 'audit')) return <Navigate to="/pos" />
 const people = [...new Set(rows.map((r) => r.actorName))].sort()
 const shown = rows.filter((r) => (!who || r.actorName === who) && (!kind || r.kind === kind))
 const exportCsv = () => download(`takar-audit-${from}-${to}.csv`, csv([['Waktu', 'Jenis', 'Siapa', 'Peran', 'Perangkat', 'Apa', 'Disetujui'], ...shown.map((r) => [stamp(r.at, settings?.timezone), KINDS[r.kind] ?? r.kind, r.actorName, r.role ?? '', r.mode ?? '', describe(r), r.approvedBy ?? ''])]), 'text/csv')
 return <section className="page-content">
  <div className="page-heading"><div><p className="eyebrow">Tidak ada yang hilang</p><h1>Log audit</h1><p className="muted">Pembatalan, diskon, refund, kas, stok, hitungan, menu, pengaturan. Tidak bisa diubah.</p></div><div className="button-row"><Button variant="secondary" onClick={() => void load()} loading={busy}><RefreshCw size={16} /> Muat ulang</Button><Button variant="secondary" onClick={exportCsv}><Download size={16} /> Ekspor CSV</Button></div></div>
  <div className="report-filter">
   <label>Dari tanggal<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
   <label>Sampai tanggal<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
   <Select label="Siapa" value={who} onChange={setWho} options={[{ value: '', label: 'Semua orang' }, ...people.map((p) => ({ value: p, label: p }))]} />
   <Select label="Jenis" value={kind} onChange={setKind} options={[{ value: '', label: 'Semua jenis' }, ...Object.entries(KINDS).map(([value, label]) => ({ value, label }))]} />
   {!user.demo && <Select label="Sumber" value={source} onChange={(v) => setSource(v as typeof source)} options={[{ value: 'server', label: 'Server (semua perangkat)' }, { value: 'local', label: 'Perangkat ini saja' }]} />}
  </div>
  {error && <p className="callout">Server tidak terjangkau ({error}); menampilkan catatan perangkat ini.</p>}
  {source === 'local' && outbox.length > 0 && <p className="report-completeness">{outbox.length} operasi belum tersinkron ikut ditampilkan.</p>}
  <article className="panel"><div className="table-scroll"><table className="data-table"><thead><tr><th>Waktu</th><th>Jenis</th><th>Siapa</th><th>Perangkat</th><th>Apa</th><th>Disetujui</th></tr></thead><tbody>
   {shown.map((r) => <tr key={r.id}><td>{when(r.at, settings?.timezone)}</td><td>{KINDS[r.kind] ?? r.kind}</td><td>{r.actorName}{r.role ? <small className="muted"> · {r.role}</small> : null}</td><td>{r.mode === 'pos' ? 'Kasir' : r.mode === 'station' ? 'Stasiun' : r.mode === 'office' ? 'Back office' : '—'}</td><td>{describe(r)}</td><td>{r.approvedBy ?? '—'}</td></tr>)}
  </tbody></table></div>
  {!shown.length && <p className="muted">{busy ? 'Memuat…' : 'Tidak ada catatan di rentang ini.'}</p>}
  <p className="small muted"><ScrollText size={14} /> Catatan server ditulis sekali oleh apply_operation dan tidak pernah diubah; ekspor pemulihan di Lainnya memuat salinannya dari perangkat ini.</p></article>
 </section>
}
