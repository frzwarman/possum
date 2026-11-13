import { useMemo,useState } from 'react'
import { Download,ArrowUpRight,Wallet,ReceiptText,TrendingUp,AlertCircle,Printer,Percent,Trash2,Scale } from 'lucide-react'
import { useApp } from '../../app/context'
import { JAKARTA,businessDay,expectedCash,isSale,rupiah,stamp,when } from '../../domain/calculate'
import { CloseShift } from './CloseShift'
import { Button } from '../../components/ui/button'
import { Money } from '../../components/ui/money'
import { Select } from '../../components/ui/select'
import { Dialog } from '../../components/ui/dialog'
import { csv,download } from '../../lib/db'
import { supabase } from '../../lib/supabase'
import { ApprovalDialog,type ApprovalRequest } from '../../app/Approval'
import type { Approval } from '../../domain/types'
export default function Reports(){
 const {orders,settings,shift,shifts,cash,commands,act,manager,busy,outbox,lastSync,user,movements,costs,stockItems}=useApp()
 const day=(iso:string)=>businessDay(iso,settings?.timezone,settings?.cutoff),today=day(new Date().toISOString())
 const [from,setFrom]=useState(today);const [to,setTo]=useState(today);const [closing,setClosing]=useState(false);const [counted,setCounted]=useState('');const [cashDialog,setCashDialog]=useState(false);const [amount,setAmount]=useState('');const [direction,setDirection]=useState('out');const [reason,setReason]=useState('');const [remote,setRemote]=useState<Record<string,number>|null>(null);const [ask,setAsk]=useState<ApprovalRequest>()
 const inRange=(at:string)=>{const d=day(at);return d>=from&&d<=to}
 const filtered=orders.filter(o=>inRange(o.payment?.at||o.createdAt))
 // Compliments are not sales; they live in the compliment budget on Today.
 const paid=filtered.filter(o=>o.payment&&isSale(o));const sales=paid.reduce((n,o)=>n+o.totals.total,0);const refunds=orders.filter(o=>o.refund&&inRange(o.refund.at)).reduce((n,o)=>n+o.totals.total,0);const outstanding=filtered.filter(o=>o.status==='open').reduce((n,o)=>n+o.totals.total,0);const discounts=paid.reduce((n,o)=>n+o.discount,0)
 // TDY-4: food cost, waste and the usage gap for the same period, valued at the latest ingredient prices.
 const value=(kind:string)=>movements.filter(m=>m.kind===kind&&inRange(m.at)).reduce((n,m)=>n+m.qty*(costs.get(m.stockId)??0),0)
 const cogs=-value('preparation'),waste=-value('waste'),gap=value('count')
 const expected=shift?expectedCash(shift,orders,cash):0
 const best=useMemo(()=>{const m=new Map<string,{name:string;qty:number;total:number}>();for(const o of paid)for(const l of o.lines.filter(l=>!l.cancelled)){const a=m.get(l.itemId)||{name:l.name,qty:0,total:0};a.qty+=l.qty;a.total+=l.qty*l.price;m.set(l.itemId,a)}return [...m.values()].sort((a,b)=>b.qty-a.qty).slice(0,5)},[paid])
 const pending=outbox.filter(o=>o.state!=='synced').length
 // A preset sets both dates: today, this week (Monday), this month.
 const preset=(p:'day'|'week'|'month')=>{const d=new Date(today+'T12:00:00Z');if(p==='week')d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));if(p==='month')d.setUTCDate(1);setFrom(p==='day'?today:d.toISOString().slice(0,10));setTo(today)}
 // Exception report: every correction in the range, who asked and who approved it.
 const audit=[...filtered.filter(o=>o.status==='void').map(o=>({at:o.updatedAt,what:`Batal ${o.label||o.receiptId} · ${rupiah(o.totals.total)}`,why:o.voidReason||'',who:o.cashier,by:o.voidApprovedBy})),...filtered.filter(o=>o.discount>0).map(o=>({at:o.updatedAt,what:`Diskon ${rupiah(o.discount)} · ${o.label||o.receiptId}`,why:o.discountReason,who:o.cashier,by:o.discountApprovedBy})),...orders.filter(o=>o.refund&&inRange(o.refund.at)).map(o=>({at:o.refund!.at,what:`Refund ${rupiah(o.totals.total)} · ${o.label||o.receiptId}`,why:o.refund!.reason,who:o.cashier,by:o.refund!.approvedBy})),...cash.filter(c=>c.amount<0&&inRange(c.at)).map(c=>({at:c.at,what:`Kas keluar ${rupiah(-c.amount)}`,why:c.reason,who:shifts.find(s=>s.id===c.shiftId)?.cashier||'',by:c.approvedBy})),...shifts.filter(s=>s.status==='closed'&&s.variance&&inRange(s.closedAt!)).map(s=>({at:s.closedAt!,what:`Selisih ${s.settlements?'EDC':'kas'} ${rupiah(s.variance!)}`,why:s.settlements?s.settlements.map(x=>`EDC ${x.edc}: slip ${rupiah(x.slip)}, Takar ${rupiah(x.expected)}`).join(' · '):`Dihitung ${rupiah(s.counted||0)}, seharusnya ${rupiah(s.expected||0)}`,who:s.cashier,by:s.varianceApprovedBy}))].sort((a,b)=>b.at.localeCompare(a.at))
 async function moveCash(approval?:Approval){const value=Number(amount)*(direction==='out'?-1:1)
  if(value<0&&!manager&&!approval){setAsk({action:'cashout',amount:-value,what:`Kas keluar ${rupiah(-value)} · ${reason.trim()}`});return}
  await act(async()=>{await commands.cashMove(value,reason,approval);setCashDialog(false);setAmount('');setReason('')},'Mutasi kas tersimpan')}
 // POS-8: a cashier's gap over the limit needs a manager's PIN; the amount is bound to the approval, not shown to the cashier.
 async function close(approval?:Approval){const gap=Math.abs(Number(counted)-expected),limit=settings?.varianceLimit??10000
  if(!manager&&!approval&&gap>limit){setAsk({action:'variance',amount:gap,what:'Selisih kas di atas batas; manajer perlu menyetujui penutupan sif'});return}
  await act(async()=>{await commands.closeShift(Number(counted),approval);setClosing(false)},manager?'Sif ditutup. Jangan lupa ekspor dan backup.':'Sif ditutup. Hitungan tersimpan untuk diperiksa manajer. Jangan lupa ekspor dan backup.')}
 function reportExport(){download(`takar-laporan-${from}-${to}.csv`,csv([['ID struk',`Waktu (${settings?.timezone||JAKARTA})`,'Kasir','Status','Metode','Subtotal','Diskon','Layanan','Pajak','Total'],...filtered.map(o=>[o.receiptId,stamp(o.payment?.at||o.createdAt,settings?.timezone),o.cashier,o.status,o.payment?.method||'',o.totals.subtotal,o.discount,o.totals.service,o.totals.tax,o.totals.total])]),'text/csv')}
 // PDF = the browser's print of a plain page with the same numbers as the screen.
 // Pilot rule: on the till with a shift open even a manager sees the cashier's view; the laptop shows everything.
 const boss=manager&&!(user.primary&&Boolean(shift))
 function printReport(){const rows=[['Penjualan tercatat',rupiah(sales)],['Pembayaran bersih',rupiah(sales-refunds)],['Transaksi lunas',String(paid.length)],['Belum dibayar',rupiah(outstanding)],['Total diskon',rupiah(discounts)],['Pengembalian dana',rupiah(refunds)],['Biaya bahan terpakai',rupiah(Math.round(cogs))],['Food cost',`${sales?Math.round(cogs/sales*100):0}%`],['Terbuang',rupiah(Math.round(waste))],['Selisih hitung stok',rupiah(Math.round(gap))]]
  const w=window.open('','_blank');if(!w)return;const esc=(s:string)=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'})[c]!)
  w.document.write(`<!doctype html><title>Laporan ${from} – ${to}</title><style>body{font-family:system-ui;padding:32px;color:#222}h1{font-size:22px}table{border-collapse:collapse;width:100%;max-width:640px}td{padding:8px 4px;border-bottom:1px solid #ddd}td:last-child{text-align:right;font-weight:600}</style><h1>${esc(settings?.name||'')} · Laporan ${from} – ${to}</h1><table>${rows.map(r=>`<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td></tr>`).join('')}</table><h2>Menu terlaris</h2><table>${best.map(b=>`<tr><td>${esc(b.name)}</td><td>${b.qty} porsi · ${rupiah(b.total)}</td></tr>`).join('')}</table><p>Dicetak ${when(Date.now(),settings?.timezone)} oleh ${esc(user.name)}.</p>`);w.document.close();w.focus();w.print()}
 return <section className="page-content">
  <div className="page-heading"><div><p className="eyebrow">Gambaran hari Anda</p><h1>{boss?'Laporan & kas':settings?.cashless?'Tutup sif':'Sif & kas'}</h1><p className="muted">{boss?'Angka yang bisa ditelusuri, sampai ke pesanan.':settings?.cashless?'Transaksi hari ini, hitung stok, lalu cocokkan settlement tiap EDC.':'Modal laci, kas masuk dan keluar, dan tutup sif Anda.'}</p></div>
   {boss&&<div className="button-row"><Button variant="secondary" onClick={reportExport}><Download size={17}/> Ekspor CSV</Button><Button variant="secondary" onClick={printReport}><Printer size={17}/> Cetak / PDF</Button></div>}</div>
  {boss&&<>
   <div className="category-tabs">{([['day','Hari ini'],['week','Minggu ini'],['month','Bulan ini']] as const).map(([id,label])=><button key={id} onClick={()=>preset(id)}>{label}</button>)}</div>
   <div className="report-filter"><label>Dari tanggal<input type="date" value={from} onChange={e=>{setFrom(e.target.value);setRemote(null)}}/></label><label>Sampai tanggal<input type="date" value={to} onChange={e=>{setTo(e.target.value);setRemote(null)}}/></label>
    {!user.demo&&<Button variant="secondary" onClick={()=>void act(async()=>{const {data,error}=await supabase!.rpc('sales_report',{from_day:from,to_day:to});if(error)throw error;setRemote(data)},'Ringkasan server diperbarui')}>Ambil ringkasan server</Button>}</div>
   <p className="report-completeness"><AlertCircle size={16}/>{user.demo?'Data demo lokal':pending?`Termasuk transaksi lokal; ${pending} operasi belum tersinkron`:'Riwayat lokal maksimal 500 pesanan; gunakan ringkasan server untuk angka lengkap'}. Sinkron terakhir: {lastSync?when(lastSync,settings?.timezone):'belum ada'}.</p>
   {remote&&<div className="callout">Server: {remote.transactions} transaksi · penjualan {rupiah(remote.sales)} · refund {rupiah(remote.refunds)} · tertagih {rupiah(remote.outstanding)}. Tidak termasuk operasi lokal yang belum tersinkron.</div>}
   <div className="metrics">
    <article className="metric featured"><span><TrendingUp size={18}/> Penjualan tercatat</span><strong>{rupiah(sales)}</strong><small>Tagihan lunas sebelum pengembalian</small></article>
    <article className="metric"><span><Wallet size={18}/> Pembayaran bersih</span><strong>{rupiah(sales-refunds)}</strong><small>Uang diterima dikurangi refund</small></article>
    <article className="metric"><span><ReceiptText size={18}/> Transaksi lunas</span><strong>{paid.length}</strong><small>Rata-rata {rupiah(paid.length?Math.round(sales/paid.length):0)}</small></article>
    <article className="metric"><span><ArrowUpRight size={18}/> Belum dibayar</span><strong>{rupiah(outstanding)}</strong><small>{filtered.filter(o=>o.status==='open').length} pesanan terbuka</small></article>
    <article className="metric"><span><Percent size={18}/> Food cost</span><strong>{sales?Math.round(cogs/sales*100):0}%</strong><small>bahan terpakai {rupiah(Math.round(cogs))}</small></article>
    <article className="metric"><span><Trash2 size={18}/> Terbuang</span><strong>{rupiah(Math.round(waste))}</strong><small>catatan buang, dinilai harga terakhir</small></article>
    <article className="metric"><span><Scale size={18}/> Selisih hitung stok</span><strong>{rupiah(Math.round(gap))}</strong><small>hasil hitung dikurangi sistem</small></article>
    <article className="metric"><span><Wallet size={18}/> Nilai stok</span><strong>{rupiah(stockItems.reduce((n,s)=>n+Math.max(0,movements.filter(m=>m.stockId===s.id).reduce((q,m)=>q+m.qty,0))*(costs.get(s.id)??0),0))}</strong><small>stok saat ini, harga terakhir</small></article>
   </div>
  </>}
  {settings?.cashless&&<CloseShift/>}
  <div className="report-columns">
   {!settings?.cashless&&<article className="panel"><div className="panel-heading"><h2>Laci kas</h2><span className="badge">{shift?'Sif aktif':'Tidak ada sif aktif'}</span></div>
    {shift?<><p className="small muted">Dibuka {when(shift.openedAt,settings?.timezone)} oleh {shift.cashier}</p><div className="bill-row"><span>Modal kas awal</span><strong>{rupiah(shift.opening)}</strong></div>
     {/* A cashier counts blind: with sales and the expected total on screen the count tends to match them. */}
     {boss&&<><div className="bill-row"><span>Penjualan tunai bersih</span><strong>{rupiah(orders.filter(o=>o.shiftId===shift.id&&o.payment?.method==='cash'&&o.status!=='refunded').reduce((n,o)=>n+o.totals.total,0))}</strong></div><div className="bill-row"><span>Kas masuk / keluar</span><strong>{rupiah(cash.filter(c=>c.shiftId===shift.id).reduce((n,c)=>n+c.amount,0))}</strong></div><div className="bill-total"><span>Kas yang seharusnya</span><strong>{rupiah(expected)}</strong></div></>}
     {shift.actor===user.id||manager?<div className="button-row"><Button variant="secondary" onClick={()=>setCashDialog(true)}>Catat kas masuk / keluar</Button><Button onClick={()=>setClosing(true)}>Tutup sif</Button></div>:<p className="callout">Laci dipegang {shift.cashier}; hanya dia (atau manajer) yang bisa mencatat kas dan menutup sif.</p>}</>
    :<p className="muted">Buka sif dari kasir untuk mencatat modal dan penerimaan tunai.</p>}
    <div className="history-list">{shifts.filter(s=>s.status==='closed').slice(-3).reverse().map(s=><div key={s.id}><span>{when(s.closedAt!,settings?.timezone,{dateStyle:'medium'})}<small className="muted"> · {s.cashier}</small><br/>Dihitung {rupiah(s.counted||0)}</span>{boss&&<strong>Selisih {rupiah(s.variance||0)}{s.varianceApprovedBy?` · ${s.varianceApprovedBy}`:''}</strong>}</div>)}</div>
   </article>}
   {boss&&<>
    <article className="panel"><div className="panel-heading"><h2>Koreksi & persetujuan</h2><span className="badge">{audit.length}</span></div>
     {audit.length?<div className="audit-list">{audit.slice(0,50).map((a,i)=><div key={i}><span><strong>{a.what}</strong><small className="muted"> · {when(a.at,settings?.timezone)}</small><br/>{a.why} · kasir {a.who}{a.by?` · disetujui ${a.by}`:''}</span></div>)}</div>:<p className="muted">Belum ada pembatalan, diskon, refund, kas keluar, atau selisih kas di rentang ini.</p>}</article>
    <article className="panel"><div className="panel-heading"><h2>Metode pembayaran</h2></div>
     {(['cash','qris','card'] as const).map(m=><div className="payment-row" key={m}><span>{m==='cash'?'Tunai':m==='qris'?'QRIS · manual':'Kartu · manual'}</span><strong>{rupiah(paid.filter(o=>o.payment?.method===m).reduce((n,o)=>n+o.totals.total,0))}</strong></div>)}
     <div className="bill-row"><span>Total diskon</span><span>{rupiah(discounts)}</span></div><div className="bill-row"><span>Pengembalian dana</span><span>{rupiah(refunds)}</span></div>
     <p className="small muted">Penjualan dan biaya bahan bukan laba bersih. Biaya operasional lain belum dihitung.</p></article>
    <article className="panel"><div className="panel-heading"><h2>Menu paling laris</h2><span className="muted small">Jumlah terjual</span></div>
     {best.length?best.map((b,i)=><div className="bestseller" key={b.name}><span className="rank">{i+1}</span><div><strong>{b.name}</strong><div className="bar-track"><div style={{width:`${b.qty/best[0].qty*100}%`}}/></div></div><strong>{b.qty}</strong></div>):<p className="muted">Menu terlaris muncul setelah pembayaran pertama.</p>}</article>
    <article className="panel"><h2>Dasar laporan</h2><p className="muted">Hari usaha berganti pukul {String(settings?.cutoff??4).padStart(2,'0')}.00 ({settings?.timezone}). Penjualan dihitung saat pembayaran; pesanan terbuka berdasarkan waktu pesanan; refund pada hari refund.</p><p className="muted">Data operasional dimulai {settings?.goLive}. Ekspor CSV adalah laporan dari data yang tersedia di perangkat, bukan backup database lengkap.</p></article>
   </>}
  </div>
  <Dialog open={closing} onOpenChange={setClosing} title="Tutup sif" description={boss?'Hitung uang tunai di laci, lalu bandingkan dengan catatan.':'Hitung semua uang tunai di laci. Selisih di atas batas perlu PIN manajer.'}>
   {boss&&<div className="payment-total"><span>Kas yang seharusnya</span><strong>{rupiah(expected)}</strong></div>}
   <label>Uang tunai yang dihitung<Money value={counted} onChange={setCounted}/></label>
   {boss&&<div className="bill-total"><span>Selisih</span><strong>{rupiah(Number(counted)-expected)}</strong></div>}
   <p className="callout">Selesaikan semua pesanan terbuka. Setelah menutup, ekspor backup lokal dan periksa sinkronisasi di Lainnya.</p>
   <Button loading={busy} disabled={busy||counted===''} className="full btn-accent" onClick={()=>void close()}>Konfirmasi tutup sif</Button>
  </Dialog>
  <Dialog open={cashDialog} onOpenChange={setCashDialog} title="Mutasi laci kas">
   <Select label="Jenis" value={direction} onChange={setDirection} options={[{value:'out',label:'Kas keluar'},{value:'in',label:'Kas masuk'}]}/>
   <label>Jumlah<Money value={amount} onChange={setAmount}/></label>
   <label>Alasan<input value={reason} onChange={e=>setReason(e.target.value)}/></label>
   <p className="small muted">Pembelian yang sudah dicatat “dari laci kas” tidak perlu dicatat lagi.{!boss&&direction==='out'&&' Kas keluar memerlukan PIN manajer.'}</p>
   <Button className="full" loading={busy} disabled={busy||!reason.trim()||!amount} onClick={()=>void moveCash()}>Simpan mutasi</Button>
  </Dialog>
  <ApprovalDialog request={ask} onClose={()=>setAsk(undefined)} onApproved={a=>{setAsk(undefined);if(a.action==='variance')void close(a);else void moveCash(a)}}/>
 </section>
}
