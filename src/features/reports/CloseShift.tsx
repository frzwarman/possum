import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { CreditCard,QrCode,Gift,Lock,Search,ClipboardList,AlertTriangle,Wallet,ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import { useApp } from '../../app/context'
import { expectedCash,isSale,rupiah,settlementGap,settlements,tills,when } from '../../domain/calculate'
import { Button } from '../../components/ui/button'
import { Money } from '../../components/ui/money'
import { Select } from '../../components/ui/select'
import { ApprovalDialog,type ApprovalRequest } from '../../app/Approval'
import type { Approval,Order } from '../../domain/types'
import { payLabel } from '../orders/Receipt'
// Close for a store with EDC machines (pilot PRD, Figma C9): the day's takings, every transaction findable, each
// EDC's settlement slip against what Takar recorded on it, and, when the store takes cash, the drawer counted blind.
// The stock count comes first.
export function CloseShift({heading=false}:{heading?:boolean}){
 const {orders,settings,shift,shifts,counts,cash:moves,commands,act,busy,manager,user,stockItems}=useApp()
 const [slips,setSlips]=useState<Record<string,string>>({});const [drawer,setDrawer]=useState('');const [query,setQuery]=useState('');const [kind,setKind]=useState('all');const [edc,setEdc]=useState('');const [byAmount,setByAmount]=useState(true);const [time,setTime]=useState('');const [ask,setAsk]=useState<ApprovalRequest>()
 const {cash,edcs}=tills(settings)
 // No shift open: say so with the one next step, then the last shifts as a table — one column per EDC (and the
 // drawer), a chip for the gap. Cashiers count blind, so the gap column is for managers only.
 if(!shift){const closed=shifts.filter(s=>s.status==='closed').sort((a,b)=>(b.closedAt??'').localeCompare(a.closedAt??'')).slice(0,10)
  const machines=[...new Set([...edcs,...closed.flatMap(s=>(s.settlements??[]).map(x=>x.edc))])]
  const gapChip=(n:number)=>n===0?<span className="chip-status good">Cocok</span>:<span className={`chip-status ${n<0?'critical':'warning'}`}>{n>0?'+':'−'}{rupiah(Math.abs(n))}</span>
  return <>
  <article className="panel shift-idle"><div><h2>Tidak ada sif yang terbuka</h2><p className="muted">{cash?'Buka sif di Kasir dan hitung modal kas di laci.':'Buka sif di Kasir. Tanpa tunai: tidak ada modal kas, cukup periksa mesin EDC.'}</p></div><Link to="/pos" className="btn btn-primary">Ke Kasir untuk buka sif</Link></article>
  <article className="panel"><div className="panel-heading"><h2>Sif terakhir</h2><span className="muted small">{closed.length?`${closed.length} terakhir, terbaru di atas`:''}</span></div>
   {closed.length?<div className="table-scroll"><table className="data-table shift-history"><thead><tr><th>Ditutup</th><th>Kasir</th>{machines.map(e=><th key={e} className="num">EDC {e}</th>)}{cash&&<th className="num">Tunai di laci</th>}{manager&&<th className="num">Selisih</th>}{manager&&<th>Disetujui</th>}</tr></thead><tbody>
    {closed.map(s=><tr key={s.id}><td><strong>{when(s.closedAt!,settings?.timezone,{day:'numeric',month:'short'})}</strong><small className="muted">{when(s.closedAt!,settings?.timezone,{hour:'2-digit',minute:'2-digit'})}</small></td><td>{s.cashier}</td>
     {machines.map(e=>{const x=s.settlements?.find(v=>v.edc===e);if(!x)return <td key={e} className="num muted">—</td>;const d=x.slip-x.expected;return <td key={e} className="num">{rupiah(x.slip)}{d!==0&&<small className={d<0?'negative':'over'}>{d>0?'+':'−'}{rupiah(Math.abs(d))}</small>}</td>})}
     {cash&&<td className="num">{s.settlements?rupiah((s.counted??0)-s.settlements.reduce((n,x)=>n+x.slip,0)):rupiah(s.counted??0)}</td>}
     {manager&&<td className="num">{gapChip(s.variance??0)}</td>}{manager&&<td className="muted">{s.varianceApprovedBy??'—'}</td>}</tr>)}
   </tbody></table></div>:<p className="muted">Sif yang sudah ditutup muncul di sini.</p>}
  </article></>}
 const mine=orders.filter(o=>o.shiftId===shift.id),paid=mine.filter(o=>o.status==='paid'),open=mine.filter(o=>o.status==='open').length
 const sum=(list:Order[])=>list.reduce((n,o)=>n+o.totals.total,0)
 const sales=paid.filter(isSale),comps=paid.filter(o=>o.mode==='compliment'),given=(k:string)=>comps.filter(o=>o.compliment?.kind===k).reduce((n,o)=>n+o.discount,0)
 // The count before closing: any count this cashier started and sent since the shift opened.
 // The count before closing: any count sent since the shift opened. A store with no ingredients yet has nothing to count.
 const done=counts.filter(c=>c.status!=='draft'&&(c.submittedAt??c.approvedAt??'')>=shift.openedAt).map(c=>c.submittedAt??c.approvedAt!).sort().at(-1),counted=!stockItems.length||Boolean(done)
 const tz=settings?.timezone,hhmm=(iso:string)=>when(iso,tz,{hour:'2-digit',minute:'2-digit'}),hour=(iso:string)=>Number(new Date(iso).toLocaleString('en-GB',{timeZone:tz,hour:'2-digit',hourCycle:'h23'}))
 const inTime=(iso:string)=>!time||(time==='morning'?hour(iso)<12:time==='afternoon'?hour(iso)>=12&&hour(iso)<17:hour(iso)>=17)
 const amounts=Object.fromEntries(edcs.map(e=>[e,Number(slips[e]||0)])),list=settlements(shift.id,orders,amounts,edcs),cashGap=cash?Math.abs(Number(drawer||0)-expectedCash(shift,orders,moves)):0,gap=settlementGap(list)+cashGap,limit=settings?.varianceLimit??10000
 const shown=paid.filter(o=>(kind==='all'||(kind==='compliment'?o.mode==='compliment':o.payment?.method===kind))&&(!edc||o.payment?.edc===edc)&&inTime(o.payment!.at)&&[o.receiptId.slice(-6),o.label,o.name,o.payment?.approvalCode].join(' ').toLowerCase().includes(query.trim().toLowerCase())).sort((a,b)=>byAmount?b.totals.total-a.totals.total:b.payment!.at.localeCompare(a.payment!.at))
 const blank=edcs.filter(e=>slips[e]===undefined||slips[e]==='')
 const missing=[...(!counted?['Kirim hitung stok dulu (Stok → Hitung stok).']:[]),...(open>0?[`Bayar atau batalkan ${open} pesanan terbuka di Pesanan.`]:[]),...(blank.length?[`Isi slip ${blank.map(e=>`EDC ${e}`).join(', ')}. Ketik 0 bila mesinnya tidak dipakai.`]:[]),...(cash&&drawer===''?['Isi uang tunai di laci.']:[]),...(!(shift.actor===user.id||manager)?[`Hanya ${shift.cashier} atau manajer yang bisa menutup sif ini.`]:[])]
 async function close(approval?:Approval){if(!manager&&!approval&&gap>limit){setAsk({action:'variance',amount:gap,what:cash?'Selisih kas atau EDC di atas batas; manajer perlu menyetujui penutupan sif':`Selisih EDC ${rupiah(gap)}; manajer perlu menyetujui penutupan sif`});return}
  await act(async()=>{await commands.closeShift(cash?Number(drawer||0):0,approval,amounts);setSlips({});setDrawer('')},'Sif ditutup. Hasil hitung stok menunggu persetujuan manajer.')}
 const tile=(icon:ReactNode,label:string,list:Order[],tone:string)=><article className={`metric tone-${tone}`}><span>{icon} {label}</span><strong>{rupiah(sum(list))}</strong><small>{list.length} pembayaran</small></article>
 return <>
  {/* Figma C9: who and since when, whether the count is in, and whether anything is still open. */}
  {heading&&<div className="page-heading"><div><h1>Tutup sif</h1><p className="muted">{shift.cashier}, {hhmm(shift.openedAt)} sampai sekarang. {done?`Hitung stok selesai ${hhmm(done)}.`:counted?'':'Stok belum dihitung.'}</p></div><span className={`dot-chip ${open?'warning':'good'}`}>{open?`${open} pesanan terbuka`:'Tidak ada pesanan terbuka'}</span></div>}
  <div className="metrics close-metrics">
   <article className="metric tone-dark"><span>Total penjualan sif</span><strong>{rupiah(sum(sales))}</strong><small>{sales.length} pesanan. Compliment bukan penjualan.</small></article>
   {cash&&tile(<Wallet size={16}/>,'Tunai',paid.filter(o=>o.payment?.method==='cash'),'mint')}
   {tile(<CreditCard size={16}/>,'Kartu di EDC',paid.filter(o=>o.payment?.method==='card'),'lavender')}
   {tile(<QrCode size={16}/>,'QRIS di EDC',paid.filter(o=>o.payment?.method==='qris'),'sky')}
   <article className="metric tone-mint"><span><Gift size={16}/> Compliment</span><strong>{rupiah(given('staff')+given('family'))}</strong><small>Staf {rupiah(given('staff'))}, pemilik {rupiah(given('family'))}</small></article>
  </div>
  <div className="close-columns">
   <article className="panel close-transactions"><div className="panel-heading"><h2>Transaksi sif ini</h2>
     <div className="search-box compact"><Search size={16}/><input aria-label="Cari transaksi" placeholder="No. pesanan atau kode approval" value={query} onChange={e=>setQuery(e.target.value)}/></div></div>
    <div className="filter-row"><div className="pill-tabs">{[['all','Semua'],...(cash?[['cash','Tunai']]:[]),['card','Kartu'],['qris','QRIS'],['compliment','Compliment']].map(([id,label])=><button key={id} className={kind===id?'active':''} aria-pressed={kind===id} onClick={()=>setKind(id)}>{label}</button>)}</div>
     <div className="pill-selects"><Select ariaLabel="EDC" value={edc} onChange={setEdc} options={[{value:'',label:'EDC: semua'},...edcs.map(e=>({value:e,label:`EDC ${e}`}))]}/><Select ariaLabel="Waktu" value={time} onChange={setTime} options={[{value:'',label:'Waktu: sepanjang hari'},{value:'morning',label:'Pagi, sebelum 12.00'},{value:'afternoon',label:'Siang, 12.00 sampai 17.00'},{value:'evening',label:'Malam, setelah 17.00'}]}/></div></div>
    <div className="table-scroll"><table className="data-table plain-table dense"><thead><tr><th>Pesanan</th><th>Waktu</th><th>Pembayaran</th><th>EDC</th><th className="num"><button type="button" className="sort-head" onClick={()=>setByAmount(!byAmount)}>{byAmount?'Nominal: terbesar':'Waktu: terbaru'}<ChevronDown size={14}/></button></th></tr></thead><tbody>
     {shown.slice(0,50).map(o=><tr key={o.id} title={o.payment?.approvalCode?`Approval ${o.payment.approvalCode}`:undefined}><td><strong>#{o.receiptId.slice(-6).toUpperCase()}</strong></td><td>{hhmm(o.payment!.at)}</td><td className={o.mode==='compliment'?'muted':''}>{o.mode==='compliment'?'Compliment':payLabel(o).split(',')[0]}</td><td>{o.mode==='compliment'?(o.compliment?.kind==='family'?'Keluarga pemilik':'Staff meal'):o.payment?.edc??'—'}{o.payment?.approvalCode&&<small className="muted"> · {o.payment.approvalCode}</small>}</td><td className="num"><strong>{rupiah(o.totals.total)}</strong></td></tr>)}
    </tbody></table></div>
    <p className="small muted">{shown.length?`Menampilkan ${Math.min(50,shown.length)} dari ${shown.length}. Detail, item dan cetak ulang ada di Pesanan.`:'Belum ada transaksi lunas di sif ini.'}</p>
   </article>
   <article className="panel settle-panel"><h2>{cash?'Hitung laci & settlement EDC':'Cocokkan settlement EDC'}</h2>
    <p className="small muted">Cetak settlement di setiap EDC dan ketik totalnya.</p>
    {list.map(x=>{const d=x.slip-x.expected,typed=slips[x.edc]!==undefined&&slips[x.edc]!=='';return <div key={x.edc} className={`settle-row ${typed&&d<0?'short':typed&&d>0?'over':''}`}>
     <strong>EDC {x.edc}</strong><span className="match">{!typed?'':d===0?'Cocok':d<0?`−${rupiah(-d)} kurang`:`+${rupiah(d)} lebih`}</span>
     <small className="muted">Takar {rupiah(x.expected)}</small><label className="slip-field"><span>Slip</span><Money aria-label={`Slip EDC ${x.edc}`} value={slips[x.edc]??''} onChange={v=>setSlips({...slips,[x.edc]:v})}/></label></div>})}
    {/* Cash is counted blind: with the expected total on screen the count tends to match it. */}
    {cash&&<div className="settle-row"><strong>Uang tunai di laci</strong><span className="match"/><small className="muted">Termasuk modal {rupiah(shift.opening)}</small><label className="slip-field"><span>Laci</span><Money aria-label="Uang tunai di laci" value={drawer} onChange={setDrawer}/></label></div>}
    <p className="settle-note"><AlertTriangle size={16}/>Selisih di atas {rupiah(limit)} perlu persetujuan manajer dengan PIN. Selisih {cash?'kas dan ':''}tiap EDC dijumlahkan, tidak saling menutup.</p>
    {!counted&&<p className="settle-note"><ClipboardList size={16}/><span>Hitung stok dulu sebelum menutup sif. <Link to="/counts" className="text-button">Ke Hitung stok</Link></span></p>}
    <Button className="full btn-accent close-button" loading={busy} disabled={busy||missing.length>0} onClick={()=>close()}><Lock size={17}/> Tutup sif</Button>
    {/* Say exactly what still blocks the close, instead of a grey button with no reason. */}
    {missing.length>0&&<div className="close-missing"><strong>Belum bisa ditutup:</strong><ul>{missing.map(m=><li key={m}>{m}</li>)}</ul></div>}
   </article>
  </div>
  <ApprovalDialog request={ask} onClose={()=>setAsk(undefined)} onApproved={a=>{setAsk(undefined);void close(a)}}/>
 </>
}
