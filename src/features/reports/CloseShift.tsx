import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { CreditCard,QrCode,Gift,Lock,Search,ClipboardList,AlertTriangle,Wallet } from 'lucide-react'
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
export function CloseShift(){
 const {orders,settings,shift,shifts,counts,cash:moves,commands,act,busy,manager,user}=useApp()
 const [slips,setSlips]=useState<Record<string,string>>({});const [drawer,setDrawer]=useState('');const [query,setQuery]=useState('');const [kind,setKind]=useState('all');const [edc,setEdc]=useState('');const [byAmount,setByAmount]=useState(true);const [ask,setAsk]=useState<ApprovalRequest>()
 const {cash,edcs}=tills(settings)
 if(!shift)return <article className="panel"><div className="panel-heading"><h2>Tutup sif</h2><span className="badge">Tidak ada sif aktif</span></div><p className="muted">Buka sif dari kasir.{cash?'':' Tanpa tunai: tidak ada modal kas.'}</p>
  <div className="history-list">{shifts.filter(s=>s.status==='closed').slice(-3).reverse().map(s=><div key={s.id}><span>{when(s.closedAt!,settings?.timezone,{dateStyle:'medium'})}<small className="muted"> · {s.cashier}</small><br/>{s.settlements?.map(x=>`EDC ${x.edc} ${rupiah(x.slip)}`).join(' · ')||`Dihitung ${rupiah(s.counted||0)}`}</span><strong>Selisih {rupiah(s.variance||0)}{s.varianceApprovedBy?` · ${s.varianceApprovedBy}`:''}</strong></div>)}</div></article>
 const mine=orders.filter(o=>o.shiftId===shift.id),paid=mine.filter(o=>o.status==='paid'),open=mine.filter(o=>o.status==='open').length
 const sum=(list:Order[])=>list.reduce((n,o)=>n+o.totals.total,0)
 const sales=paid.filter(isSale),comps=paid.filter(o=>o.mode==='compliment'),given=(k:string)=>comps.filter(o=>o.compliment?.kind===k).reduce((n,o)=>n+o.discount,0)
 // The count before closing: any count this cashier started and sent since the shift opened.
 const counted=counts.some(c=>c.status!=='draft'&&(c.submittedAt??c.approvedAt??'')>=shift.openedAt)
 const amounts=Object.fromEntries(edcs.map(e=>[e,Number(slips[e]||0)])),list=settlements(shift.id,orders,amounts,edcs),cashGap=cash?Math.abs(Number(drawer||0)-expectedCash(shift,orders,moves)):0,gap=settlementGap(list)+cashGap,limit=settings?.varianceLimit??10000
 const shown=paid.filter(o=>(kind==='all'||(kind==='compliment'?o.mode==='compliment':o.payment?.method===kind))&&(!edc||o.payment?.edc===edc)&&[o.receiptId.slice(-6),o.label,o.name,o.payment?.approvalCode].join(' ').toLowerCase().includes(query.trim().toLowerCase())).sort((a,b)=>byAmount?b.totals.total-a.totals.total:b.payment!.at.localeCompare(a.payment!.at))
 async function close(approval?:Approval){if(!manager&&!approval&&gap>limit){setAsk({action:'variance',amount:gap,what:cash?'Selisih kas atau EDC di atas batas; manajer perlu menyetujui penutupan sif':`Selisih EDC ${rupiah(gap)}; manajer perlu menyetujui penutupan sif`});return}
  await act(async()=>{await commands.closeShift(cash?Number(drawer||0):0,approval,amounts);setSlips({});setDrawer('')},'Sif ditutup. Hasil hitung stok menunggu persetujuan manajer.')}
 return <>
  <div className="metrics">
   <article className="metric featured"><span>Total penjualan sif</span><strong>{rupiah(sum(sales))}</strong><small>{sales.length} pesanan. Compliment bukan penjualan.</small></article>
   {cash&&<article className="metric"><span><Wallet size={18}/> Tunai</span><strong>{rupiah(sum(paid.filter(o=>o.payment?.method==='cash')))}</strong><small>{paid.filter(o=>o.payment?.method==='cash').length} pembayaran</small></article>}
   <article className="metric"><span><CreditCard size={18}/> Kartu di EDC</span><strong>{rupiah(sum(paid.filter(o=>o.payment?.method==='card')))}</strong><small>{paid.filter(o=>o.payment?.method==='card').length} pembayaran</small></article>
   <article className="metric"><span><QrCode size={18}/> QRIS di EDC</span><strong>{rupiah(sum(paid.filter(o=>o.payment?.method==='qris')))}</strong><small>{paid.filter(o=>o.payment?.method==='qris').length} pembayaran</small></article>
   <article className="metric"><span><Gift size={18}/> Compliment</span><strong>{rupiah(given('staff')+given('family'))}</strong><small>Staf {rupiah(given('staff'))}, pemilik {rupiah(given('family'))}</small></article>
  </div>
  <div className="report-columns">
   <article className="panel"><div className="panel-heading"><h2>Transaksi sif ini</h2><span className="badge">{open?`${open} pesanan terbuka`:'Tidak ada pesanan terbuka'}</span></div>
    <div className="search-box"><Search size={18}/><input aria-label="Cari transaksi" placeholder="Nomor pesanan atau kode approval" value={query} onChange={e=>setQuery(e.target.value)}/></div>
    <div className="category-tabs">{[['all','Semua'],...(cash?[['cash','Tunai']]:[]),['card','Kartu'],['qris','QRIS'],['compliment','Compliment']].map(([id,label])=><button key={id} className={kind===id?'active':''} onClick={()=>setKind(id)}>{label}</button>)}
     <div className="filter-select"><Select ariaLabel="EDC" value={edc} onChange={setEdc} options={[{value:'',label:'EDC: semua'},...edcs.map(e=>({value:e,label:`EDC ${e}`}))]}/></div>
     <button onClick={()=>setByAmount(!byAmount)}>{byAmount?'Nominal: terbesar':'Waktu: terbaru'}</button></div>
    <div className="table-scroll"><table className="data-table"><thead><tr><th>Pesanan</th><th>Waktu</th><th>Pembayaran</th><th>Approval</th><th>Total</th></tr></thead><tbody>
     {shown.slice(0,50).map(o=><tr key={o.id}><td>#{o.receiptId.slice(-6).toUpperCase()}<br/><small className="muted">{o.compliment?o.compliment.who:[o.label,o.name].filter(Boolean).join(' · ')}</small></td><td>{when(o.payment!.at,settings?.timezone,{hour:'2-digit',minute:'2-digit'})}</td><td>{payLabel(o)}</td><td>{o.payment?.approvalCode??'—'}</td><td>{rupiah(o.totals.total)}</td></tr>)}
    </tbody></table></div>
    <p className="small muted">Menampilkan {Math.min(50,shown.length)} dari {shown.length}. Detail dan cetak ulang ada di Pesanan.</p>
   </article>
   <article className="panel"><div className="panel-heading"><h2>{cash?'Hitung laci & settlement EDC':'Cocokkan settlement EDC'}</h2></div>
    <p className="small muted">Cetak settlement di setiap EDC dan ketik totalnya.</p>
    {list.map(x=>{const d=x.slip-x.expected,typed=slips[x.edc]!==undefined&&slips[x.edc]!=='';return <div key={x.edc} className={`settle-row mt ${typed&&d<0?'short':''}`}>
     <strong>EDC {x.edc}</strong><span className="match">{!typed?'':d===0?'Cocok':d<0?`${rupiah(-d)} kurang`:`${rupiah(d)} lebih`}</span>
     <small className="muted">Takar {rupiah(x.expected)}</small><Money aria-label={`Slip EDC ${x.edc}`} value={slips[x.edc]??''} onChange={v=>setSlips({...slips,[x.edc]:v})}/></div>})}
    {/* Cash is counted blind: with the expected total on screen the count tends to match it. */}
    {cash&&<div className="settle-row mt"><strong>Uang tunai di laci</strong><span className="match"/><small className="muted">Hitung semua uang, termasuk modal {rupiah(shift.opening)}</small><Money aria-label="Uang tunai di laci" value={drawer} onChange={setDrawer}/></div>}
    <p className="callout"><AlertTriangle size={16}/>Selisih di atas {rupiah(limit)} perlu persetujuan manajer dengan PIN. Selisih {cash?'kas dan ':''}tiap EDC dijumlahkan, tidak saling menutup.</p>
    {!counted&&<p className="callout"><ClipboardList size={16}/><span>Hitung stok dulu sebelum menutup sif. <Link to="/counts" className="text-button">Ke Hitung stok</Link></span></p>}
    <Button className="full btn-accent" loading={busy} disabled={busy||!counted||open>0||edcs.some(e=>slips[e]===undefined||slips[e]==='')||(cash&&drawer==='')||!(shift.actor===user.id||manager)} onClick={()=>void close()}><Lock size={17}/> Tutup sif</Button>
    {open>0&&<p className="small muted center">Selesaikan atau batalkan pesanan terbuka dulu.</p>}
   </article>
  </div>
  <ApprovalDialog request={ask} onClose={()=>setAsk(undefined)} onApproved={a=>{setAsk(undefined);void close(a)}}/>
 </>
}
