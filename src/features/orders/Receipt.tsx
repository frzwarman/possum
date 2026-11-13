import { useEffect,useRef,useState } from 'react'
import { Printer,Copy,Check } from 'lucide-react'
import { useApp } from '../../app/context'
import type { Order,Station } from '../../domain/types'
import { Dialog } from '../../components/ui/dialog'
import { Button } from '../../components/ui/button'
import { browserPrinter,receiptText } from '../../lib/printer'
import { rupiah } from '../../domain/calculate'
import { uid } from '../../lib/db'
import { Mark } from '../../components/logo'
export const modeLabel=(o:Pick<Order,'mode'|'compliment'>)=>o.mode==='dinein'?'Makan di sini':o.mode==='takeaway'?'Bungkus':o.compliment?.kind==='family'?'Compliment · keluarga pemilik':'Compliment · staff meal'
export const payLabel=(o:Order)=>!o.payment?'Belum dibayar':o.payment.method==='none'?'Compliment, tanpa pembayaran':o.payment.method==='cash'?'Tunai':`${o.payment.method==='card'?'Kartu':'QRIS'}${o.payment.edc?`, EDC ${o.payment.edc}`:''}`
// auto: the cashless pilot has no print switch, the receipt prints as soon as the payment is confirmed.
export function Receipt({order,onClose,kitchen=false,reprint=false,station,auto=false}:{order:Order;onClose:()=>void;kitchen?:boolean;reprint?:boolean;station?:Station;auto?:boolean}){
 const s=order.settings
 // A station ticket carries only that station's lines; the full kitchen ticket carries all of them.
 const mine=order.lines.filter(l=>!l.cancelled&&(!station||(l.station??'kitchen')===station))
 const {db,act,busy,setNotice}=useApp();const [attempt,setAttempt]=useState<string>();const [fallback,setFallback]=useState('');const [printedLines,setPrintedLines]=useState<string[]>([]);const [copy,setCopy]=useState(false)
 const text=receiptText(order,reprint)
 // A kitchen ticket is a copy only when every line was on an earlier kitchen ticket. Marking the
 // first one SALINAN, next to "do not prepare a copy twice", tells the kitchen to skip it.
 async function print(){await act(async()=>{const old=await db.prints.where('orderId').equals(order.id).toArray();const known=new Set(old.filter(p=>p.kind==='kitchen').flatMap(p=>p.lineIds));const lines=mine.filter(l=>!known.has(l.id));const again=kitchen?!lines.length:reprint;setPrintedLines(lines.map(l=>l.id));setCopy(again);const id=uid();await db.prints.add({id,orderId:order.id,kind:kitchen?'kitchen':'receipt',at:new Date().toISOString(),status:'requested',reprint:again,lineIds:lines.map(l=>l.id)});setAttempt(id);await new Promise(resolve=>setTimeout(resolve,50));await browserPrinter.requestPrint()},'Permintaan cetak dicatat. Periksa hasil kertas.')}
 const printed=useRef(false);useEffect(()=>{if(auto&&!printed.current){printed.current=true;void print()}},[auto])// eslint-disable-line react-hooks/exhaustive-deps
 async function share(){try{if(navigator.share)await navigator.share({text});else{await navigator.clipboard.writeText(text);setNotice('Teks struk disalin')}}catch{setFallback(text)}}
 return <Dialog open onOpenChange={onClose} title={kitchen?'Tiket dapur':reprint?'Salinan struk':'Pembayaran tercatat'} description="Pratinjau cetak. Hasil kertas perlu diperiksa oleh operator."><div id="print-area" className="receipt-paper" style={{'--paper-width':`${order.settings.receiptWidth}mm`,'--printable-width':`${order.settings.printableWidth}mm`} as React.CSSProperties}>{kitchen?<><h2>{order.status==='void'?'PEMBATALAN':station==='bar'?'BAR':'DAPUR'} {copy?'— SALINAN':''}</h2><h2>{order.label||order.receiptId.slice(-8)}</h2><p>{modeLabel(order)} · {new Date(order.updatedAt).toLocaleTimeString('id-ID',{timeZone:order.settings.timezone})}</p>{mine.map(l=><div className="kitchen-line" key={l.id}><strong>{l.qty}× {l.name}</strong>{printedLines.includes(l.id)&&<b> [BARU]</b>}<p>{l.modifiers.map(m=>m.name).join(', ')}</p><b>{l.note}</b></div>)}{order.voidReason&&<p>Alasan: {order.voidReason}</p>}<p>Periksa tambahan terhadap tiket sebelumnya. Jangan menyiapkan salinan dua kali.</p></>:<div className="receipt">
  <header className="receipt-head"><h2>{s.name}</h2>{s.address&&<p>{s.address}</p>}{s.phone&&<p>Telp. {s.phone}</p>}</header>
  {order.mode==='compliment'&&<p className="receipt-kind">Compliment</p>}
  {(reprint||order.status!=='paid')&&<p className="receipt-kind">{reprint?'Salinan struk':order.status==='refunded'?'Dana dikembalikan':order.status==='void'?'Pesanan dibatalkan':'Belum dibayar'}</p>}
  {/* The pager box is what the guest looks at: big number, one line on what it does. */}
  {order.label&&<div className="receipt-pager"><div><strong>{/^meja/i.test(order.label)?'Meja Anda':'Pager Anda'}</strong><small>{/^meja/i.test(order.label)?'Pesanan diantar ke meja Anda':'Berbunyi saat pesanan Anda siap'}</small></div><b>{order.label.replace(/^(pager|meja)\s*/i,'')}</b></div>}
  <dl className="receipt-meta">
   <div><dt>Pesanan</dt><dd>#{order.receiptId.slice(-6).toUpperCase()}</dd></div>
   <div><dt>Tipe</dt><dd>{modeLabel(order)}</dd></div>
   <div><dt>Kasir</dt><dd>{order.cashier}</dd></div>
   <div><dt>{order.payment?'Dibayar':'Dibuat'}</dt><dd>{new Date(order.payment?.at??order.createdAt).toLocaleString('id-ID',{timeZone:s.timezone,dateStyle:'medium',timeStyle:'short'})}</dd></div>
  </dl>
  <div className="receipt-items">
   {order.lines.filter(l=>!l.cancelled).map(l=><div className="receipt-item" key={l.id}>
    <span className="receipt-name"><strong>{l.qty}× {l.name}</strong>{l.modifiers.length>0&&<small>{l.modifiers.map(m=>m.price?`${m.name} +${rupiah(m.price)}`:m.name).join(', ')}</small>}{l.note&&<small>Catatan: {l.note}</small>}</span>
    <span className="receipt-price">{rupiah((l.price+l.modifiers.reduce((n,m)=>n+m.price,0))*l.qty)}</span></div>)}</div>
  <div className="receipt-sums">
   <div className="receipt-row"><span>Subtotal</span><span>{rupiah(order.totals.subtotal)}</span></div>
   {order.totals.discount>0&&<div className="receipt-row"><span>Diskon{order.discountReason&&` · ${order.discountReason}`}</span><span>−{rupiah(order.totals.discount)}</span></div>}
   {order.totals.service>0&&<div className="receipt-row"><span>Layanan {s.serviceBps/100}%</span><span>{rupiah(order.totals.service)}</span></div>}
   {order.totals.tax>0&&<div className="receipt-row"><span>Pajak {s.taxBps/100}%</span><span>{rupiah(order.totals.tax)}</span></div>}
   <div className="receipt-total"><span>Total</span><strong>{rupiah(order.totals.total)}</strong></div>
   {order.payment?<>
    <div className="receipt-row"><span>{payLabel(order)}</span><span>{rupiah(order.payment.tendered)}</span></div>
    {order.payment.method==='cash'&&<div className="receipt-row receipt-strong"><span>Kembalian</span><span>{rupiah(order.payment.change)}</span></div>}
    {order.payment.approvalCode&&<div className="receipt-row receipt-strong"><span>Kode approval</span><span>{order.payment.approvalCode}</span></div>}
    {(order.payment.method==='card'||order.payment.method==='qris')&&!order.payment.edc&&<div className="receipt-row"><span>Verifikasi</span><span>manual oleh kasir</span></div>}
   </>:<div className="receipt-row"><span>Pembayaran</span><span>belum dibayar</span></div>}
   {order.status==='refunded'&&<div className="receipt-row receipt-flag"><span>Dana dikembalikan</span><span>{order.refund?.reason}</span></div>}
   {order.status==='void'&&<div className="receipt-row receipt-flag"><span>Pesanan dibatalkan</span><span>{order.voidReason}</span></div>}
  </div>
  <footer className="receipt-foot"><p className="receipt-thanks">{s.footer||'Terima kasih. Tanyakan ke kasir dengan struk ini bila ada yang keliru dengan pesanan Anda.'}</p><p className="receipt-brand"><Mark size={14} mono/> Powered by Takar</p><p className="receipt-id">{order.receiptId}</p></footer>
 </div>}</div><div className="button-row"><Button disabled={busy} onClick={()=>void print()}><Printer size={17}/> Cetak {kitchen?'tiket':'struk'}</Button>{!kitchen&&<Button variant="secondary" onClick={()=>void share()}><Copy size={16}/> Bagikan teks</Button>}</div>{attempt&&<><p className="callout">Cetak diminta, belum berarti kertas tercetak. Jika dialog dibatalkan, transaksi tetap tersimpan.</p><Button variant="secondary" disabled={busy} className="full" onClick={()=>void act(async()=>{await db.prints.update(attempt,{status:'confirmed'});setAttempt(undefined)},'Hasil cetak dikonfirmasi operator')}><Check size={17}/> Saya sudah melihat hasil cetak</Button></>}{fallback&&<label>Salin teks struk<textarea readOnly value={fallback} rows={6}/></label>}</Dialog>
}
