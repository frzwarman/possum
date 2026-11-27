import { useCallback,useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from '@tanstack/react-router'
import { ArrowUpRight,Check,Printer,ReceiptText,Search } from 'lucide-react'
import { useApp } from '../../app/context'
import { businessDay,isSale,onBoard,orderNo,rupiah,when } from '../../domain/calculate'
import type { Approval,Order } from '../../domain/types'
import { Button } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { Select } from '../../components/ui/select'
import { Receipt,lineTotal,payLabel } from './Receipt'
import { ApprovalDialog,type ApprovalRequest } from '../../app/Approval'
import { VoidSummary } from './VoidSummary'
// Figma C11: every order in one table, the chosen one beside it. Where both do not fit (tablet portrait, phone, a
// laptop narrowed by the sidebar) a tap opens the order as a dialog instead.
const no=(o:Order)=>orderNo(o)
const kind=(o:Order)=>o.mode==='dinein'?'Makan di sini':o.mode==='takeaway'?'Bungkus':o.compliment?.kind==='family'?'Keluarga pemilik':'Staff meal'
// Find any order by number (typed as printed, with its #), pager or name, item, or the approval code on the EDC slip.
const words=(o:Order)=>[o.label,o.name,o.receiptId,orderNo(o),o.compliment?.who,o.payment?.approvalCode,o.payment?.edc,...o.lines.map(l=>l.name)].join(' ').toLowerCase()
// One pill per order: what still needs doing (unpaid) or what happened to it (voided, refunded, items taken off).
function Status({o,tablets}:{o:Order;tablets?:boolean}){const cut=o.lines.filter(l=>l.cancelled).length,[text,tone]=o.status==='open'?['Belum dibayar','warning']:o.status==='void'?['Dibatalkan','']:o.status==='refunded'?['Dikembalikan','']:o.mode==='compliment'?['Compliment','lavender']:cut?[`${cut} item dibatalkan`,'critical']:['Lunas','good'];const ready=tablets&&o.prep==='ready'&&(o.status==='open'||o.status==='paid');return <><span className={`order-status ${tone}`}>{text}</span>{ready&&<span className="order-status good">Siap</span>}</>}
export default function Orders(){const {orders,settings,db,commands,act,manager,busy,outbox,shift,user}=useApp();const tablets=Boolean(settings?.stationTablets);const navigate=useNavigate();const [wide,setWide]=useState(()=>innerWidth>1180);const [tab,setTab]=useState('all');const [picked,setPicked]=useState<string>();const [printing,setPrinting]=useState<{order:Order;kitchen:boolean}>();const [reason,setReason]=useState('');const [action,setAction]=useState<{id:string;kind:'void'|'refund'|'line'}>();const [lineId,setLineId]=useState('');const [rq,setRq]=useState<Record<string,number>>({});const [amt,setAmt]=useState('');const [search,setSearch]=useState('');const [sort,setSort]=useState<'new'|'old'|'amount'>('new');const [ask,setAsk]=useState<ApprovalRequest>()
 // QA PERF-4, CAT-3, ORD-1: the list is the app's newest orders, but a search reads the whole store on this device, and the
 // line under the title counts today's orders from the store, never from that window.
 const q=search.trim().replace(/^#/,'').toLowerCase(),recent=new Date(Date.now()-3*864e5).toISOString().slice(0,10)
 const hits=useLiveQuery(()=>q?db.orders.filter(o=>words(o).includes(q)).toArray():[],[db,q])
 const daily=useLiveQuery(()=>db.orders.where('createdAt').aboveOrEqual(recent).toArray(),[db,recent])??[]
 // Measured on the page, not the screen: the till's rail and the manager's sidebar leave different room.
 const fit=useCallback((el:HTMLElement|null)=>{if(!el)return;const ro=new ResizeObserver(([e])=>setWide(e.contentRect.width>=1000));ro.observe(el);return()=>ro.disconnect()},[])
 // A cashier works the current shift only; older orders and their totals are for managers.
 const pool=q?(hits??orders):orders,visible=manager?pool:pool.filter(o=>o.shiftId===shift?.id),mine=manager?daily:daily.filter(o=>o.shiftId===shift?.id)
 const tz=settings?.timezone,day=(iso:string)=>businessDay(iso,tz,settings?.cutoff),today=day(new Date().toISOString())
 const at=(iso:string)=>when(iso,tz,day(iso)===today?{hour:'2-digit',minute:'2-digit'}:{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})
 // The line under the title: today's orders and today's takings, counted as on the Hari ini page.
 const todays=mine.filter(o=>day(o.createdAt)===today).length,takings=mine.filter(o=>o.payment&&day(o.payment.at)===today&&isSale(o)).reduce((n,o)=>n+o.totals.total,0)
 const inTab=(o:Order,t:string)=>t==='kitchen'?(o.status==='open'||o.status==='paid')&&o.prep!=='ready'&&onBoard(o,shift,settings,Date.now()):t==='compliment'?o.mode==='compliment':t==='paid'?o.status==='paid'&&isSale(o):t==='void'?o.status==='void'||o.lines.some(l=>l.cancelled):t==='all'||o.status===t
 const order=(a:Order,b:Order)=>sort==='amount'?b.totals.total-a.totals.total:sort==='old'?a.createdAt.localeCompare(b.createdAt):b.createdAt.localeCompare(a.createdAt)
 const filtered=visible.filter(o=>inTab(o,tab)&&words(o).includes(q)).sort(order)
 const o=filtered.find(x=>x.id===picked)??(wide&&tab!=='void'?filtered[0]:undefined)
 // A correction belongs to the order it was started on: picking another order never carries a half-typed void over.
 const open=action&&action.id===o?.id?action.kind:undefined,start=(k:'void'|'refund'|'line')=>{setReason('');setLineId('');setRq(Object.fromEntries(o!.lines.filter(l=>!l.cancelled).map(l=>[l.id,l.qty])));setAmt(String(o!.totals.total));setAction({id:o!.id,kind:k})}
 // D3/D4: a refund is the whole order or a part: tick how many of each item goes back, the amount follows (the share of what was paid, discount and tax included) and can be typed over.
 const share=(q:Record<string,number>)=>{if(!o)return 0;const live=o.lines.filter(l=>!l.cancelled),gross=live.reduce((n,l)=>n+lineTotal(l),0),part=live.reduce((n,l)=>n+lineTotal(l)*Math.min(q[l.id]??0,l.qty)/l.qty,0);return gross?Math.min(o.totals.total,Math.round(part/gross*o.totals.total)):0}
 const setQty=(id:string,v:number)=>{const q={...rq,[id]:v};setRq(q);setAmt(String(share(q)))},refundAmt=Number(amt),refundBad=open==='refund'&&o&&!(Number.isInteger(refundAmt)&&refundAmt>=1&&refundAmt<=o.totals.total)
 async function correct(approval?:Approval){const target=visible.find(x=>x.id===action?.id);if(!target||!action)return;const line=target.lines.find(l=>l.id===lineId),k=action.kind
  // Said as on C6 ("… ingin membatalkan 2× Seasalt Latte (Rp84.000) di pesanan #A-1043"), with the number the screens show.
  if(!manager&&!approval){setAsk({action:k==='line'?'voidline':k,orderId:target.id,...(k==='line'&&line&&{lineId:line.id,amount:lineTotal(line)}),...(k==='void'&&{amount:target.totals.total}),...(k==='refund'&&Number(amt)<target.totals.total&&{amount:Number(amt)}),what:k==='line'?`Batalkan ${line?.qty}× ${line?.name}${line?` (${rupiah(lineTotal(line))})`:''} di pesanan #${no(target)}${target.label?` (${target.label})`:''} · ${reason.trim()}`:`${k==='refund'?`Kembalikan dana ${rupiah(Number(amt))} dari`:'Batalkan'} pesanan #${no(target)} (${[target.label,rupiah(target.totals.total)].filter(Boolean).join(', ')}) · ${reason.trim()}`});return}
  await act(async()=>{if(k==='refund'){const a=Number(amt),part=a<target.totals.total;await commands.refund(target.id,reason,approval,part?a:undefined,part?target.lines.filter(l=>(rq[l.id]??0)>0&&!l.cancelled).map(l=>({id:l.id,qty:Math.min(rq[l.id],l.qty)})):undefined)}else if(k==='line')await commands.voidLine(target.id,lineId,reason,approval);else await commands.voidOrder(target.id,reason,approval);setAction(undefined)},k==='line'?'Item dibatalkan':k==='refund'?`Pengembalian ${rupiah(Number(amt))} tercatat. Kembalikan juga lewat ${target.payment?.method==='cash'?'laci kas':'EDC / QRIS'}.`:'Koreksi tersimpan di perangkat')}
 // The cart gets the order back with its saved or manual discount, which goes on following the lines by its rule. A
 // compliment's discount is its own rule's, not a discount: switched to dine-in, the order is priced in full (TILL-06).
 async function reopen(o:Order){await act(async()=>{const draft=await db.drafts.get('current');if(draft?.lines.length&&draft.orderId!==o.id)throw new Error('Simpan pesanan di keranjang, lalu tekan "Mulai pesanan baru" sebelum membuka pesanan lain.');const comp=o.mode==='compliment';await db.drafts.put({id:'current',orderId:o.id,revision:o.revision,label:o.label,mode:o.mode,...(o.name&&{name:o.name}),...(o.compliment&&{compliment:o.compliment}),lines:o.lines,discount:comp?0:o.discount,discountReason:comp?'':o.discountReason,...(!comp&&o.discountId&&{discountId:o.discountId}),...(!comp&&o.discountRule&&{discountRule:o.discountRule})});await navigate({to:'/pos'})})}
 // On a phone the detail is a dialog: close it before the receipt dialog opens over it.
 const print=(kitchen:boolean)=>{if(!o)return;setPrinting({order:o,kitchen});if(!wide)setPicked(undefined)}
 // Void an item: a made line off an open or paid order of this shift, with a manager's PIN.
 const voidable=o?o.lines.filter(l=>!l.cancelled&&l.prepared&&['open','paid'].includes(o.status)&&o.shiftId===shift?.id&&o.lines.filter(x=>!x.cancelled).length>1):[]
 const detail=o&&<>
  {/* The status pill sits beside the title and the line under it, centred on both (C11). */}
  <div className="detail-head"><div>{wide&&<h2>Pesanan {no(o)}</h2>}<p className="detail-sub">{[o.label,o.name].filter(Boolean).join(', ')||'Tanpa label'}. {kind(o)}{o.compliment?.who?` (${o.compliment.who})`:''}, {at(o.createdAt)}, {o.cashier}</p>
  {tablets&&<p className="detail-sub">{o.prep==='new'?'Belum dikirim ke stasiun':o.prep==='preparing'?'Sedang disiapkan':'Siap disajikan'}</p>}</div><Status o={o}/></div>
  <div className="detail-body" role="region" aria-label="Rincian pesanan" tabIndex={0}>
   {/* Voiding an item: the lines that may go become the choice, so the cashier taps the item itself. */}
   {o.lines.map(l=>{const pick=open==='line'&&voidable.includes(l),body=<><div><span>{l.qty}× {l.name}</span>{l.modifiers.length>0&&<small>{l.modifiers.map(m=>m.name).join(', ')}</small>}{l.note&&<small>{l.note}</small>}{l.cancelled&&<small>Dibatalkan: {l.voidReason}{l.voidApprovedBy&&` · disetujui ${l.voidApprovedBy}`}</small>}</div><strong>{rupiah(lineTotal(l))}</strong></>
    return pick?<label key={l.id} className={`detail-line pick${lineId===l.id?' on':''}`}><input type="radio" name="void-line" checked={lineId===l.id} onChange={()=>setLineId(l.id)}/>{body}</label>:<div key={l.id} className={`detail-line${l.cancelled?' cancelled':''}`}>{body}</div>})}
   <div className="detail-total"><span>Total{o.totals.tax>0?', termasuk pajak':''}</span><strong>{rupiah(o.totals.total)}</strong></div>
   {o.discount>0&&<p className="detail-note">Diskon {rupiah(o.discount)}: {o.discountReason}{o.discountApprovedBy&&` · disetujui ${o.discountApprovedBy}`}</p>}
   {o.payment?<div className="detail-box">{payLabel(o).replace(', EDC',' di EDC')}<small>{o.payment.approvalCode?`Approval ${o.payment.approvalCode}, d`:'D'}ibayar {at(o.payment.at)}</small></div>:o.status==='open'&&<div className="detail-box">Belum dibayar<small>Buka pesanan di Kasir untuk menerima pembayaran.</small></div>}
   {o.voidReason&&<div className="detail-box critical">Dibatalkan: {o.voidReason}{o.voidApprovedBy&&` · disetujui ${o.voidApprovedBy}`}</div>}
   {o.refund&&<div className="detail-box critical">Refund {rupiah(o.refund.amount??o.totals.total)}{o.refund.amount!==undefined&&o.refund.amount<o.totals.total?' (sebagian)':''}: {o.refund.reason}{o.refund.approvedBy&&` · disetujui ${o.refund.approvedBy}`}</div>}
   {/* Only what needs attention: the full receipt ID is on the printed receipt and still finds the order in search. */}
   {outbox.some(op=>op.state!=='synced'&&(op.payload.id===o.id||(op.payload.order as Order|undefined)?.id===o.id))&&<p className="detail-id">Belum tersinkron</p>}
  </div>
  {open?<div className="detail-form"><p className="callout">{open==='line'?'Pilih item di atas. ':''}{open==='refund'?'Pengembalian uang tidak mengembalikan makanan ke stok.':open==='line'&&o.status==='paid'?'Bahan tetap tercatat terpakai. Batalkan atau refund selisihnya juga di EDC, supaya settlement cocok.':'Bahan yang sudah disiapkan tetap tercatat terpakai.'} {manager?'Tindakan dicatat dengan akun Anda.':'Perlu PIN manajer; dicatat atas nama Anda dan yang menyetujui.'}</p>
   {open==='refund'&&<><div className="refund-lines">{o.lines.filter(l=>!l.cancelled).map(l=><label key={l.id} className="detail-line"><span>{l.name}</span><span><input type="number" min={0} max={l.qty} aria-label={`Jumlah ${l.name} dikembalikan`} value={rq[l.id]??0} onChange={e=>setQty(l.id,Math.max(0,Math.min(l.qty,Math.floor(Number(e.target.value)||0))))}/> dari {l.qty}</span></label>)}</div>
    <label>Jumlah dikembalikan (Rp), maksimal {rupiah(o.totals.total)}<input inputMode="numeric" value={amt} onChange={e=>setAmt(e.target.value.replace(/\D/g,''))}/></label>
    {o.payment&&<p className="small muted">Dikembalikan lewat cara bayar asal: {payLabel(o).replace(', EDC',' di EDC')}.</p>}</>}
   <label>Alasan wajib<textarea value={reason} onChange={e=>setReason(e.target.value)}/></label>
   <div className="detail-actions pair"><Button variant="secondary" onClick={()=>setAction(undefined)}>Batal</Button><Button variant="destructive" loading={busy} disabled={busy||!reason.trim()||(open==='line'&&!lineId)||Boolean(refundBad)} onClick={()=>correct()}>Konfirmasi {open==='refund'?'pengembalian':open==='line'?'pembatalan item':'pembatalan'}</Button></div></div>
  :<><div className="detail-more"><Button size="sm" variant="secondary" onClick={()=>print(true)}><Printer size={16}/> Cetak tiket dapur</Button>
    {tab==='kitchen'&&(['kitchen','bar'] as const).filter(s=>o.lines.some(l=>l.prepared&&!l.cancelled&&!l.readyAt&&(l.station??'kitchen')===s)).map(s=><Button key={s} size="sm" variant="secondary" disabled={busy} onClick={()=>act(()=>commands.ready(o.id,s),'Tiket ditandai siap')}><Check size={16}/> Siap · {s==='bar'?'Bar':'Dapur'}</Button>)}
    {user.primary&&o.status==='open'&&voidable.length>0&&<Button size="sm" variant="secondary" onClick={()=>start('line')}>Batalkan item</Button>}
    {user.primary&&o.status==='paid'&&!o.refund&&<Button size="sm" variant="ghost" className="danger-link" onClick={()=>start('refund')}>Kembalikan dana</Button>}</div>
   {/* ORD-2: selling operations go through the one till (Commands.run), so another device offers none of them. */}
   {!user.primary&&['open','paid'].includes(o.status)&&<p className="small muted">Koreksi pesanan (buka, batalkan, kembalikan dana) hanya di perangkat kasir utama.</p>}
   <div className="detail-actions">{user.primary&&o.status==='open'&&<Button className="btn-accent" onClick={()=>reopen(o)}>Buka pesanan <ArrowUpRight size={18}/></Button>}
    {o.payment&&<Button variant="secondary" onClick={()=>print(false)}><Printer size={18}/> Cetak ulang struk</Button>}
    {user.primary&&o.status==='open'&&<Button variant="destructive" onClick={()=>start('void')}>Batalkan pesanan</Button>}
    {/* A paid order's item is not cancelled alone (the payment would change with no refund on record): Kembalikan dana. */}</div></>}
 </>
 return <section ref={fit} className="page-content orders-page"><div className="page-heading"><div><h1>Pesanan</h1><p className="muted">{when(Date.now(),tz,{weekday:'long'})} {when(Date.now(),tz,{day:'numeric',month:'long'})}: {todays} pesanan, {rupiah(takings)}</p></div><div className="search-box"><Search size={20}/><input aria-label="Cari pesanan" placeholder="Cari no. pesanan, nama, menu atau kode approval" value={search} onChange={e=>setSearch(e.target.value)}/></div></div>
  <div className="orders-filters"><div className="category-tabs">{[['all','Semua'],['paid','Lunas'],['open','Belum dibayar'],['void','Dibatalkan'],['compliment','Compliment'],...(tablets?[['kitchen','Stasiun']]:[])].map(([id,label])=><button className={tab===id?'active':''} key={id} aria-pressed={tab===id} onClick={()=>{setTab(id);setPicked(undefined)}}>{label}<span>{visible.filter(o=>inTab(o,id)).length}</span></button>)}</div><div className="filter-select"><Select ariaLabel="Urutkan" value={sort} onChange={v=>setSort(v as typeof sort)} options={[{value:'new',label:'Terbaru dulu'},{value:'old',label:'Terlama dulu'},{value:'amount',label:'Nominal terbesar'}]}/></div></div>
  {!wide&&tab==='void'&&<VoidSummary/>}
  <div className="orders-columns"><div className="panel orders-list">{filtered.length?<table className="orders-table"><thead><tr><th>Pesanan</th><th>Waktu</th><th>Untuk</th><th className="col-type">Tipe</th><th>Pembayaran</th><th>Total</th><th>Status</th></tr></thead><tbody>
   {filtered.map(r=>{const head=r.label||r.name||r.compliment?.who||'Tanpa label',sub=[r.name,r.compliment?.who].find(v=>v&&v!==head)??kind(r),[how,via]=!r.payment?['—']:r.payment.method==='none'?['Gratis','Compliment']:payLabel(r).split(', '),on=r.id===o?.id
    return <tr key={r.id} className={`order-row${on?' selected':''}`} onClick={()=>setPicked(r.id)}><td className="col-no"><button type="button" aria-current={on||undefined}>{no(r)}</button></td><td className="col-time">{at(r.createdAt)}</td><td className="col-for">{head}<small>{sub}</small></td><td className="col-type">{kind(r)}</td><td className="col-pay">{how}{via&&<small>{via}</small>}</td><td className={`col-total${r.status==='void'?' line-voided':''}`}>{rupiah(r.totals.total)}</td><td className="col-status"><Status o={r} tablets={tablets}/></td></tr>})}
  </tbody></table>:<div className="empty-state"><ReceiptText size={42} strokeWidth={1.3}/><h2>{tab==='open'?'Semua pesanan sudah beres':'Belum ada pesanan di sini'}</h2><p>Pesanan baru akan muncul setelah disimpan dari kasir.</p><Button variant="secondary" onClick={()=>navigate({to:'/pos'})}>Ke kasir</Button></div>}</div>
  {wide&&(o?<aside className="panel order-detail" aria-label={`Pesanan ${no(o)}`}>{detail}</aside>:tab==='void'&&<VoidSummary/>)}</div>
  {!wide&&<Dialog open={Boolean(o)} onOpenChange={()=>setPicked(undefined)} title={o?`Pesanan ${no(o)}`:'Pesanan'} className="order-dialog"><div className="order-detail">{detail}</div></Dialog>}
  <ApprovalDialog request={ask} onClose={()=>setAsk(undefined)} onApproved={a=>{setAsk(undefined);void correct(a)}}/>{printing&&<Receipt order={printing.order} kitchen={printing.kitchen} reprint onClose={()=>setPrinting(undefined)}/>}</section>
}
