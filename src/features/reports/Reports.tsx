import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { AlertCircle,ChartColumn,Milk,Package,Percent,Printer,Trash2 } from 'lucide-react'
import { useApp, useMovements } from '../../app/context'
import { JAKARTA,businessDay,expectedCash,isSale,itemStation,lineUse,niceStep,quantity,refundOf,tills,rupiah,stamp,when } from '../../domain/calculate'
import { menuPicture } from '../../lib/menu-photo'
import { CloseShift } from './CloseShift'
import { rangeBounds,useRangeOrders,useShiftOrders } from './range'
import { OpenShift } from '../shift/OpenShift'
import { can } from '../../domain/permissions'
import { Button } from '../../components/ui/button'
import { Money } from '../../components/ui/money'
import { Select } from '../../components/ui/select'
import { Dialog } from '../../components/ui/dialog'
import { csv,download } from '../../lib/db'
import { supabase } from '../../lib/supabase'
import { ApprovalDialog,type ApprovalRequest } from '../../app/Approval'
import type { Approval,Line } from '../../domain/types'
export default function Reports(){
 const {settings,shift,shifts,cash,commands,act,manager,busy,outbox,lastSync,user,balance,costs,stockItems,menu,salesOrders}=useApp()
 const movements=useMovements()
 // A store with EDC machines closes on the EDC screen (with the drawer too when it takes cash); a cash-only store keeps the drawer panel.
 const till=tills(settings)
 const day=(iso:string)=>businessDay(iso,settings?.timezone,settings?.cutoff),today=day(new Date().toISOString())
 // Figma M4 opens on this week. A period sets both dates (today, from Monday, from the 1st); "Rentang lain" shows them.
 const start=(p:string)=>{const d=new Date(today+'T12:00:00Z');if(p==='week')d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));if(p==='month')d.setUTCDate(1);return d.toISOString().slice(0,10)}
 const [period,setPeriod]=useState('week');const [from,setFrom]=useState(()=>start('week'));const [to,setTo]=useState(today);const [closing,setClosing]=useState(false);const [counted,setCounted]=useState('');const [cashDialog,setCashDialog]=useState(false);const [amount,setAmount]=useState('');const [direction,setDirection]=useState('out');const [reason,setReason]=useState('');const [remote,setRemote]=useState<Record<string,number>|null>(null);const [ask,setAsk]=useState<ApprovalRequest>()
 // QA RPT-1: the range's own orders (server when signed in, the device otherwise), never the app's newest-500 window; the
 // shift's close and drawer read the shift's own orders.
 const {orders,loading,notice}=useRangeOrders(from,to,manager&&!(user.primary&&Boolean(shift))),shiftOrders=useShiftOrders(shift?.id)
 const inRange=(at:string)=>{const d=day(at);return d>=from&&d<=to}
 const filtered=orders.filter(o=>inRange(o.payment?.at||o.createdAt))
 // Compliments are not sales; they live in the compliment budget on Today.
 const paid=filtered.filter(o=>o.payment&&isSale(o));const sales=paid.reduce((n,o)=>n+o.totals.total,0);const refunds=orders.filter(o=>o.refund&&inRange(o.refund.at)).reduce((n,o)=>n+refundOf(o),0);const outstanding=filtered.filter(o=>o.status==='open').reduce((n,o)=>n+o.totals.total,0);const discounts=paid.reduce((n,o)=>n+o.discount,0)
 // RPT-7: the money taken per method, staff meals paid on the machine included, as the EDC slip and Akuntansi count it.
 const received=filtered.filter(o=>o.payment&&o.payment.method!=='none'),staffPaid=received.filter(o=>!isSale(o)).reduce((n,o)=>n+o.totals.total,0)
 // TDY-4: food cost, waste and the usage gap for the same period, valued at the latest ingredient prices.
 const catering=new Set(salesOrders.map(s=>s.id)) // CAT-7: a delivered catering order takes its ingredients, but its money is not counter sales
 // QA PERF-6: a string compare on the widened range (as range.ts asks the server) drops most movements before the zone arithmetic.
 const [lo,hi]=/^\d{4}-\d\d-\d\d$/.test(from)&&/^\d{4}-\d\d-\d\d$/.test(to)?rangeBounds(from,to):['','\uffff'],ranged=movements.filter(m=>m.at>=lo&&m.at<hi)
 const value=(kind:string)=>ranged.filter(m=>m.kind===kind&&inRange(m.at)&&!(kind==='preparation'&&catering.has(m.recordId))).reduce((n,m)=>n+m.qty*(costs.get(m.stockId)??0),0)
 const cogs=-value('preparation')||0,waste=-value('waste')||0,gap=value('count')
 const expected=shift?expectedCash(shift,shiftOrders,cash):0
 // Per menu item: portions, takings with options, and what its ingredients cost at the latest prices (a margin only
 // when every ingredient of every portion has a price).
 const lineValue=(l:Line)=>l.qty*(l.price+l.modifiers.reduce((n,m)=>n+m.price,0))
 const items=new Map<string,{id:string;name:string;qty:number;total:number;cost:number;known:boolean}>()
 for(const o of paid)for(const l of o.lines)if(!l.cancelled){const a=items.get(l.itemId)??{id:l.itemId,name:l.name,qty:0,total:0,cost:0,known:true},use=lineUse(l);a.qty+=l.qty;a.total+=lineValue(l);a.cost+=use.reduce((n,r)=>n+r.qty*(costs.get(r.stockId)??0),0);a.known=a.known&&use.length>0&&use.every(r=>costs.has(r.stockId));items.set(l.itemId,a)}
 const best=[...items.values()].sort((a,b)=>b.qty-a.qty).slice(0,5),margins=best.some(b=>b.known)
 const pending=outbox.filter(o=>o.state!=='synced').length
 function pick(p:string){setPeriod(p);setRemote(null);if(p!=='custom'){setFrom(start(p));setTo(today)}}
 // Sales per day of the range, split by the station that makes the item, like Today's hour chart. A typo'd year
 // must not draw thousands of days: past a year the chart says so instead.
 const station=(id:string)=>{const m=menu.find(x=>x.id===id);return m?itemStation(m):'kitchen'}
 const days:string[]=[];for(let d=from;/^\d{4}-\d\d-\d\d$/.test(d)&&d<=to&&days.length<367;d=new Date(Date.parse(d)+864e5).toISOString().slice(0,10))days.push(d)
 const byDay=new Map<string,{kitchen:number;bar:number}>()
 // The bars add up to the headline: each line carries its share of the order's discount, tax and service.
 for(const o of paid)for(const l of o.lines)if(!l.cancelled){const k=day(o.payment!.at),b=byDay.get(k)??{kitchen:0,bar:0};b[station(l.itemId)==='bar'?'bar':'kitchen']+=lineValue(l)*(o.totals.subtotal?o.totals.total/o.totals.subtotal:1);byDay.set(k,b)}
 const step=niceStep(Math.max(0,...[...byDay.values()].flatMap(b=>[b.kitchen,b.bar]))||400_000),top=step*4,every=Math.ceil(days.length/16)
 const on=(d:string,o:Intl.DateTimeFormatOptions)=>new Intl.DateTimeFormat('id-ID',{timeZone:'UTC',...o}).format(new Date(d+'T12:00:00Z'))
 const named=(d:string,month=true)=>`${on(d,{weekday:'long'})} ${Number(d.slice(8))}${month?` ${on(d,{month:'long'})}`:''}`
 const range=!days.length?'Pilih rentang tanggal':(from===to?named(to):`${named(from,from.slice(0,7)!==to.slice(0,7))}${from.slice(0,4)!==to.slice(0,4)?` ${from.slice(0,4)}`:''} sampai ${named(to)}`)+(to.slice(0,4)!==today.slice(0,4)?` ${to.slice(0,4)}`:'')
 // Count gaps per ingredient in the range, at the latest price. What the counts found missing (and nobody logged as
 // waste) is "used beyond recipes"; signs stay counted minus expected, as on the count review.
 const found=new Map<string,{qty:number;value:number}>()
 for(const m of ranged)if(m.kind==='count'&&m.qty&&inRange(m.at)){const g=found.get(m.stockId)??{qty:0,value:0};g.qty+=m.qty;g.value+=m.qty*(costs.get(m.stockId)??0);found.set(m.stockId,g)}
 const gaps=[...found].flatMap(([id,g])=>{const s=stockItems.find(x=>x.id===id);return s&&g.qty?[{s,...g}]:[]}).sort((a,b)=>Math.abs(b.value)-Math.abs(a.value))
 const lost=-gaps.reduce((n,g)=>n+Math.min(0,g.value),0)||0
 const cashGaps=shifts.filter(s=>s.status==='closed'&&s.variance&&inRange(s.closedAt!)).sort((a,b)=>b.closedAt!.localeCompare(a.closedAt!))
 const stockValue=stockItems.reduce((n,s)=>n+Math.max(0,balance(s.id))*(costs.get(s.id)??0),0)
 // Exception report: every correction in the range, who asked and who approved it.
 const audit=[...filtered.filter(o=>o.status==='void').map(o=>({at:o.updatedAt,what:`Batal ${o.label||o.receiptId} · ${rupiah(o.totals.total)}`,why:o.voidReason||'',who:o.cashier,by:o.voidApprovedBy})),...filtered.filter(o=>o.discount>0).map(o=>({at:o.updatedAt,what:`Diskon ${rupiah(o.discount)} · ${o.label||o.receiptId}`,why:o.discountReason,who:o.cashier,by:o.discountApprovedBy})),...orders.filter(o=>o.refund&&inRange(o.refund.at)).map(o=>({at:o.refund!.at,what:`Refund ${rupiah(o.totals.total)} · ${o.label||o.receiptId}`,why:o.refund!.reason,who:o.cashier,by:o.refund!.approvedBy})),...orders.filter(o=>inRange(o.updatedAt)).flatMap(o=>o.lines.filter(l=>l.cancelled&&l.voidReason).map(l=>({at:o.updatedAt,what:`Batal item ${l.qty}× ${l.name} · ${o.label||o.receiptId}`,why:l.voidReason!,who:o.cashier,by:l.voidApprovedBy}))),...cash.filter(c=>c.amount<0&&inRange(c.at)).map(c=>({at:c.at,what:`Kas keluar ${rupiah(-c.amount)}`,why:c.reason,who:shifts.find(s=>s.id===c.shiftId)?.cashier||'',by:c.approvedBy})),...shifts.filter(s=>s.status==='closed'&&s.variance&&inRange(s.closedAt!)).map(s=>({at:s.closedAt!,what:`Selisih ${s.settlements?'EDC':'kas'} ${rupiah(s.variance!)}`,why:s.settlements?s.settlements.map(x=>`EDC ${x.edc}: slip ${rupiah(x.slip)}, Takar ${rupiah(x.expected)}`).join(' · '):`Dihitung ${rupiah(s.counted||0)}, seharusnya ${rupiah(s.expected||0)}`,who:s.cashier,by:s.varianceApprovedBy}))].sort((a,b)=>b.at.localeCompare(a.at))
 async function moveCash(approval?:Approval){const value=Number(amount)*(direction==='out'?-1:1)
  if(value<0&&!manager&&!approval){setAsk({action:'cashout',amount:-value,what:`Kas keluar ${rupiah(-value)} · ${reason.trim()}`});return}
  await act(async()=>{await commands.cashMove(value,reason,approval);setCashDialog(false);setAmount('');setReason('')},'Mutasi kas tersimpan')}
 // POS-8: a cashier's gap over the limit needs a manager's PIN; the amount is bound to the approval, not shown to the cashier.
 async function close(approval?:Approval){const gap=Math.abs(Number(counted)-expected),limit=settings?.varianceLimit??10000
  if(!manager&&!approval&&gap>limit){setAsk({action:'variance',amount:gap,what:'Selisih kas di atas batas; manajer perlu menyetujui penutupan sif'});return}
  await act(async()=>{await commands.closeShift(Number(counted),approval);setClosing(false)},manager?'Sif ditutup. Jangan lupa ekspor dan backup.':'Sif ditutup. Hitungan tersimpan untuk diperiksa manajer. Jangan lupa ekspor dan backup.')}
 function reportExport(){const rows=[...new Set([...filtered,...orders.filter(o=>o.refund&&inRange(o.refund.at))])],jenis=(o:typeof rows[number])=>o.mode==='dinein'?'Makan di sini':o.mode==='takeaway'?'Bungkus':o.compliment?.kind==='family'?'Keluarga pemilik':'Staff meal'
  download(`takar-laporan-${from}-${to}.csv`,csv([['ID struk',`Waktu (${settings?.timezone||JAKARTA})`,'Kasir','Status','Metode','Subtotal','Diskon','Layanan','Pajak','Total','Jenis','Waktu refund','Nilai refund'],...rows.map(o=>[o.receiptId,stamp(o.payment?.at||o.createdAt,settings?.timezone),o.cashier,o.status,o.payment?.method||'',o.totals.subtotal,o.discount,o.totals.service,o.totals.tax,o.totals.total,jenis(o),o.refund?stamp(o.refund.at,settings?.timezone):'',o.refund?refundOf(o):''])]),'text/csv')}
 // PDF = the browser's print of a plain page with the same numbers as the screen.
 // Pilot rule: on the till with a shift open even a manager sees the cashier's view; the laptop shows everything.
 const boss=manager&&!(user.primary&&Boolean(shift))
 function printReport(){const rows=[['Penjualan tercatat',rupiah(sales)],['Pembayaran bersih',rupiah(sales-refunds)],['Transaksi lunas',String(paid.length)],['Belum dibayar',rupiah(outstanding)],['Total diskon',rupiah(discounts)],['Pengembalian dana',rupiah(refunds)],['Biaya bahan terpakai',rupiah(Math.round(cogs))],['Food cost',sales?pct(cogs/sales):'0%'],['Terbuang',rupiah(Math.round(waste))],['Selisih hitung stok',rupiah(Math.round(gap))]]
  const w=window.open('','_blank');if(!w)return;const esc=(s:string)=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'})[c]!)
  w.document.write(`<!doctype html><title>Laporan ${from} – ${to}</title><style>body{font-family:system-ui;padding:32px;color:#222}h1{font-size:22px}table{border-collapse:collapse;width:100%;max-width:640px}td{padding:8px 4px;border-bottom:1px solid #ddd}td:last-child{text-align:right;font-weight:600}</style><h1>${esc(settings?.name||'')} · Laporan ${from} – ${to}</h1><table>${rows.map(r=>`<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td></tr>`).join('')}</table><h2>Menu terlaris</h2><table>${best.map(b=>`<tr><td>${esc(b.name)}</td><td>${b.qty} porsi · ${rupiah(b.total)}</td></tr>`).join('')}</table><p>Dicetak ${when(Date.now(),settings?.timezone)} oleh ${esc(user.name)}.</p>`);w.document.close();w.focus();w.print()}
 // The till's Sif page with no shift open is where the day starts (Figma C1).
 if(!boss&&!shift&&user.primary&&can(user.role,'sell'))return <OpenShift/>
 return <section className={`page-content${boss?' reports-page':''}`}>
  {(boss||!till.edc||!shift)&&<div className="page-heading"><div><p className="eyebrow">Gambaran hari Anda</p><h1>{boss?'Laporan':till.edc?'Tutup sif':'Sif & kas'}</h1><p className="muted">{boss?range:till.edc?`Transaksi hari ini, hitung stok, lalu cocokkan ${till.cash?'laci dan ':''}settlement tiap EDC.`:'Modal laci, kas masuk dan keluar, dan tutup sif Anda.'}</p></div>
   {boss&&<div className="report-actions"><Select ariaLabel="Periode" value={period} onChange={pick} options={[{value:'day',label:'Hari ini'},{value:'week',label:'Minggu ini'},{value:'month',label:'Bulan ini'},{value:'custom',label:'Rentang lain'}]}/>
    <button type="button" className="icon-button" aria-label="Cetak / PDF" title="Cetak / PDF" onClick={printReport}><Printer size={18}/></button><button type="button" className="dark-button" title="Unduh CSV pesanan di rentang ini" disabled={loading} onClick={reportExport}>Ekspor</button></div>}</div>}
  {boss&&<>
   {period==='custom'&&<div className="report-filter"><label>Dari tanggal<input type="date" value={from} onChange={e=>{setFrom(e.target.value);setRemote(null)}}/></label><label>Sampai tanggal<input type="date" value={to} onChange={e=>{setTo(e.target.value);setRemote(null)}}/></label></div>}
   {notice&&<p className="callout" role="status">{notice}</p>}{loading&&<p className="muted small" role="status">Memuat pesanan dari server...</p>}
   {/* Figma M4: three tiles, sales per day and the best sellers; on the right what counts found, the biggest gaps and cash gaps. */}
   <div className="report-grid">
    <div className="report-main">
     <div className="metrics">
      <article className="metric tone-lavender"><span><ChartColumn size={16}/> Penjualan</span><strong>{rupiah(sales)}</strong><small>{paid.length} pesanan lunas</small></article>
      <article className="metric tone-sky"><span><Percent size={16}/> Food cost</span><strong>{sales?pct(cogs/sales):'0%'}</strong><small>bahan terpakai {rupiah(Math.round(cogs))}</small></article>
      <article className="metric tone-mint"><span><Trash2 size={16}/> Terbuang</span><strong>{rupiah(Math.round(waste))}</strong><small>{sales?`${pct(waste/sales)} dari penjualan`:'catatan buang, dinilai harga terakhir'}</small></article>
     </div>
     <article className="panel"><div className="panel-heading"><h2>Penjualan per hari</h2><span className="legend"><i className="kitchen"/>Dapur<i className="bar"/>Bar</span></div>
      {days.length&&days.length<367?<div className="hour-chart day-chart" role="img" aria-label={`Penjualan per hari, total ${rupiah(sales)}`}>
       <div className="hour-axis">{[4,3,2,1,0].map(i=><span key={i}>{short(step*i)}</span>)}</div>
       <div className="hour-plot">{days.map((d,i)=>{const b=byDay.get(d);return <div key={d} className={`hour-col ${b?'':'empty'}`} title={`${named(d)}: Dapur ${rupiah(b?.kitchen??0)}, Bar ${rupiah(b?.bar??0)}`}><div className="hour-bars"><i className="kitchen" style={{height:`${(b?.kitchen??0)/top*100}%`}}/><i className="bar" style={{height:`${(b?.bar??0)/top*100}%`}}/></div>
        <span>{i%every?'':days.length>7?Number(d.slice(8)):`${on(d,{weekday:'short'})}${d===today?', sejauh ini':''}`}</span></div>})}</div>
      </div>:<p className="muted">{days.length?'Grafik per hari untuk rentang sampai satu tahun.':'Pilih rentang tanggal yang benar.'}</p>}
     </article>
     <article className="panel"><div className="panel-heading"><h2>Menu terlaris</h2></div>
      {best.length?<div className="table-scroll" tabIndex={0}><table className="data-table plain-table top-items"><thead><tr><th>Menu</th><th className="num">Terjual</th><th className="num">Penjualan</th>{margins&&<th className="num">Margin</th>}</tr></thead><tbody>
       {best.map(b=>{const m=menu.find(x=>x.id===b.id),margin=b.known&&b.total?(b.total-b.cost)/b.total:undefined;return <tr key={b.id}><td><span className="top-item">{m&&<img src={menuPicture(m)} alt=""/>}<strong>{b.name}</strong></span></td><td className="num">{b.qty}</td><td className="num">{rupiah(b.total)}</td>{margins&&<td className={`num ${margin===undefined?'muted':margin<0?'neg':'pos'}`}>{margin===undefined?'—':`${Math.round(margin*100)}%`}</td>}</tr>})}
      </tbody></table></div>:<p className="muted">Menu terlaris muncul setelah pembayaran pertama.</p>}
     </article>
    </div>
    <aside className="report-side">
     <article className="cta-card report-cta"><h2>Terpakai di luar resep</h2><strong>{rupiah(Math.round(lost))}</strong><p>{lost?'Tidak ada yang mencatatnya sebagai terbuang. Hitungan menemukannya.':'Hitungan di rentang ini belum menemukan bahan yang hilang.'}</p><Link to="/counts" className="cta-button">Tinjau hitungan</Link></article>
     <article className="panel"><div className="panel-heading"><h2>Selisih terbesar</h2></div>
      {gaps.length?<div className="gap-list">{gaps.slice(0,3).map(g=><div key={g.s.id} className="gap-row"><span className="need-icon">{g.s.unit==='ml'?<Milk size={16}/>:<Package size={16}/>}</span><span><strong>{g.s.name}</strong><small>{g.qty>0?'+':'−'}{quantity(Math.abs(g.qty))} {g.s.unit}</small></span><strong className={g.value<0?'neg':'pos'}>{signed(g.value)}</strong></div>)}</div>:<p className="muted">Belum ada selisih hitung di rentang ini.</p>}
      {/* The net only says something new when some counts also found more than expected. */}
      <div className="report-foot">{gaps.some(g=>g.value>0)&&<div className="report-line"><span>Selisih bersih</span><strong>{signed(gap)}</strong></div>}<div className="report-line"><span>Nilai stok saat ini</span><strong>{rupiah(Math.round(stockValue))}</strong></div></div>
     </article>
     <article className="panel"><div className="panel-heading"><h2>Selisih kas</h2>{cashGaps.length>1&&<span className="muted small">{cashGaps.length} sif</span>}</div>
      {cashGaps.length?cashGaps.slice(0,5).map(s=><div key={s.id} className="report-line"><span>{cashGaps.length===1?'1 sif, ':''}{s.cashier} hari {on(day(s.closedAt!),{weekday:'long'})}{days.length>7?` ${Number(day(s.closedAt!).slice(8))} ${on(day(s.closedAt!),{month:'short'})}`:''}</span><strong className="warn">{signed(s.variance!)}</strong></div>):<p className="muted">Tidak ada selisih kas di rentang ini.</p>}
     </article>
    </aside>
   </div>
  </>}
  {till.edc&&<CloseShift heading={!boss}/>}
  <div className="report-columns">
   {till.cash&&<article className="panel"><div className="panel-heading"><h2>Laci kas</h2><span className="badge">{shift?'Sif aktif':'Tidak ada sif aktif'}</span></div>
    {shift?<><p className="small muted">Dibuka {when(shift.openedAt,settings?.timezone)} oleh {shift.cashier}</p><div className="bill-row"><span>Modal kas awal</span><strong>{rupiah(shift.opening)}</strong></div>
     {/* A cashier counts blind: with sales and the expected total on screen the count tends to match them. */}
     {boss&&<><div className="bill-row"><span>Penjualan tunai bersih</span><strong>{rupiah(shiftOrders.filter(o=>o.payment?.method==='cash'&&o.status!=='refunded').reduce((n,o)=>n+o.totals.total-refundOf(o),0))}</strong></div><div className="bill-row"><span>Kas masuk / keluar</span><strong>{rupiah(cash.filter(c=>c.shiftId===shift.id).reduce((n,c)=>n+c.amount,0))}</strong></div><div className="bill-total"><span>Kas yang seharusnya</span><strong>{rupiah(expected)}</strong></div></>}
     {shift.actor===user.id||manager?<div className="button-row"><Button variant="secondary" onClick={()=>setCashDialog(true)}>Catat kas masuk / keluar</Button>{!till.edc&&<Button onClick={()=>setClosing(true)}>Tutup sif</Button>}</div>:<p className="callout">Laci dipegang {shift.cashier}; hanya dia (atau manajer) yang bisa mencatat kas dan menutup sif.</p>}</>
    :<p className="muted">Buka sif dari kasir untuk mencatat modal dan penerimaan tunai.</p>}
    <div className="history-list">{shifts.filter(s=>s.status==='closed').slice(-3).reverse().map(s=><div key={s.id}><span>{when(s.closedAt!,settings?.timezone,{dateStyle:'medium'})}<small className="muted"> · {s.cashier}</small><br/>Dihitung {rupiah(s.counted||0)}</span>{boss&&<strong>Selisih {rupiah(s.variance||0)}{s.varianceApprovedBy?` · ${s.varianceApprovedBy}`:''}</strong>}</div>)}</div>
   </article>}
   {boss&&<>
    <article className="panel"><div className="panel-heading"><h2>Koreksi & persetujuan</h2><span className="badge">{audit.length}</span></div>
     {audit.length?<div className="audit-list">{audit.slice(0,50).map((a,i)=><div key={i}><span><strong>{a.what}</strong><small className="muted"> · {when(a.at,settings?.timezone)}</small><br/>{a.why} · kasir {a.who}{a.by?` · disetujui ${a.by}`:''}</span></div>)}</div>:<p className="muted">Belum ada pembatalan, diskon, refund, kas keluar, atau selisih kas di rentang ini.</p>}</article>
    <article className="panel"><div className="panel-heading"><h2>Metode pembayaran</h2></div>
     {(['cash','qris','card'] as const).filter(m=>m!=='cash'||till.cash||received.some(o=>o.payment?.method==='cash')).map(m=><div className="payment-row" key={m}><span>{m==='cash'?'Tunai':`${m==='qris'?'QRIS':'Kartu'}${till.edc?' di EDC':' · manual'}`}</span><strong>{rupiah(received.filter(o=>o.payment?.method===m).reduce((n,o)=>n+o.totals.total,0))}</strong></div>)}
     {staffPaid>0&&<p className="small muted">Termasuk makan staf yang dibayar, {rupiah(staffPaid)}: uang masuk di mesin dan laci, bukan penjualan.</p>}
     <div className="bill-row"><span>Rata-rata per pesanan</span><span>{rupiah(paid.length?Math.round(sales/paid.length):0)}</span></div><div className="bill-row"><span>Pembayaran bersih, setelah refund</span><span>{rupiah(sales-refunds)}</span></div><div className="bill-row"><span>Belum dibayar, {filtered.filter(o=>o.status==='open').length} pesanan terbuka</span><span>{rupiah(outstanding)}</span></div>
     <div className="bill-row"><span>Total diskon</span><span>{rupiah(discounts)}</span></div><div className="bill-row"><span>Pengembalian dana</span><span>{rupiah(refunds)}</span></div>
     <p className="small muted">Penjualan dan biaya bahan bukan laba bersih. Biaya operasional lain belum dihitung.</p></article>
    <article className="panel"><div className="panel-heading"><h2>Dasar laporan</h2>{!user.demo&&<Button variant="secondary" size="sm" onClick={()=>act(async()=>{const {data,error}=await supabase!.rpc('sales_report',{from_day:from,to_day:to});if(error)throw error;setRemote(data)},'Ringkasan server diperbarui')}>Ambil ringkasan server</Button>}</div>
     <p className="report-completeness"><AlertCircle size={16}/>{user.demo?'Data demo lokal':pending?`Termasuk transaksi lokal; ${pending} operasi belum tersinkron`:notice?'Hanya data perangkat ini':'Pesanan dibaca dari server'}. Sinkron terakhir: {lastSync?when(lastSync,settings?.timezone):'belum ada'}.</p>
     {remote&&<div className="callout">Server: {remote.transactions} transaksi · penjualan {rupiah(remote.sales)} · refund {rupiah(remote.refunds)} · tertagih {rupiah(remote.outstanding)}. Tidak termasuk operasi lokal yang belum tersinkron.</div>}
     <p className="muted">Hari usaha berganti pukul {String(settings?.cutoff??4).padStart(2,'0')}.00 ({settings?.timezone}). Penjualan dihitung saat pembayaran; pesanan terbuka berdasarkan waktu pesanan; refund pada hari refund.</p><p className="muted">Data operasional dimulai {settings?.goLive}. Ekspor CSV adalah laporan dari data yang tersedia di perangkat, bukan backup database lengkap.</p></article>
   </>}
  </div>
  <Dialog open={closing} onOpenChange={setClosing} title="Tutup sif" description={boss?'Hitung uang tunai di laci, lalu bandingkan dengan catatan.':'Hitung semua uang tunai di laci. Selisih di atas batas perlu PIN manajer.'}>
   {boss&&<div className="payment-total"><span>Kas yang seharusnya</span><strong>{rupiah(expected)}</strong></div>}
   <label>Uang tunai yang dihitung<Money value={counted} onChange={setCounted}/></label>
   {boss&&<div className="bill-total"><span>Selisih</span><strong>{rupiah(Number(counted)-expected)}</strong></div>}
   <p className="callout">Selesaikan semua pesanan terbuka. Setelah menutup, ekspor backup lokal dan periksa sinkronisasi di Lainnya.</p>
   <Button loading={busy} disabled={busy||counted===''} className="full btn-accent" onClick={()=>close()}>Konfirmasi tutup sif</Button>
  </Dialog>
  <Dialog open={cashDialog} onOpenChange={setCashDialog} title="Mutasi laci kas">
   <Select label="Jenis" value={direction} onChange={setDirection} options={[{value:'out',label:'Kas keluar'},{value:'in',label:'Kas masuk'}]}/>
   <label>Jumlah<Money value={amount} onChange={setAmount}/></label>
   <label>Alasan<input maxLength={300} value={reason} onChange={e=>setReason(e.target.value)}/></label>
   <p className="small muted">Pembelian yang sudah dicatat “dari laci kas” tidak perlu dicatat lagi.{!boss&&direction==='out'&&' Kas keluar memerlukan PIN manajer.'}</p>
   <Button className="full" loading={busy} disabled={busy||!reason.trim()||!amount} onClick={()=>moveCash()}>Simpan mutasi</Button>
  </Dialog>
  <ApprovalDialog request={ask} onClose={()=>setAsk(undefined)} onApproved={a=>{setAsk(undefined);if(a.action==='variance')void close(a);else void moveCash(a)}}/>
 </section>
}
// Axis steps a person reads at a glance, four of them reaching the peak. Finer than Today's 1/2/5 so a week's tallest
// bar does not stop halfway up the chart.
const num=(v:number)=>new Intl.NumberFormat('id-ID',{maximumFractionDigits:1}).format(v)
const signed=(v:number)=>`${v<0?'−':v>0?'+':''}${rupiah(Math.abs(Math.round(v)))}`
const short=(v:number)=>v>=1e6?`${num(v/1e6)}jt`:v>=1000?`${num(v/1000)}rb`:String(v)
const pct=(v:number)=>`${num(v*100)}%`
