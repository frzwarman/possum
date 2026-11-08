import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Check, ChefHat, Coffee, CookingPot, Moon, Printer, Sun, Trash2, Clock } from 'lucide-react'
import { useApp } from '../../app/context'
import { Button } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { Select } from '../../components/ui/select'
import { convert, expiring, prepList, quantity, when } from '../../domain/calculate'
import type { Order, Station as Kind, StockItem } from '../../domain/types'
import { Receipt } from '../orders/Receipt'
// STN-4: waste in three taps: item, amount, reason.
const REASONS=['Rusak','Jatuh','Salah pesanan','Kedaluwarsa','Makan staf']
// F2: a station tablet sees only its own tickets, oldest first, big enough to read from 1.5 m.
export default function Station(){
 const {orders,settings,station,setStation,commands,act,busy,stockItems,balance,movements,user}=useApp()
 const [dark,setDarkState]=useState(()=>{try{return localStorage.getItem('takar-dark')==='1'}catch{return false}})
 const setDark=(v:boolean)=>{try{localStorage.setItem('takar-dark',v?'1':'0')}catch{/* private mode */}setDarkState(v)}
 const [now,setNow]=useState(Date.now())
 useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),15000);return()=>clearInterval(t)},[])
 const [waste,setWaste]=useState<{stockId:string;amount:string;unit:string;reason:string}>()
 const [printing,setPrinting]=useState<Order>()
 const mine=(l:{station?:Kind})=>(l.station??'kitchen')===station
 const sentAt=(o:Order)=>o.lines.filter(l=>l.prepared&&!l.cancelled&&!l.readyAt&&mine(l)).map(l=>l.preparedAt??o.updatedAt).sort()[0]??o.updatedAt
 const tickets=orders.filter(o=>(o.status==='open'||o.status==='paid')&&o.lines.some(l=>l.prepared&&!l.cancelled&&!l.readyAt&&mine(l))).sort((a,b)=>sentAt(a).localeCompare(sentAt(b)))
 const target=settings?.stations?.[station]??(station==='bar'?8:15)
 const minutes=(o:Order)=>Math.floor((now-Date.parse(sentAt(o)))/60000)
 const here=stockItems.filter(s=>(s.station??'kitchen')===station)
 const prep=prepList(here,balance)
 const expiringPrep=expiring(here,movements,2,now)
 const item=(id:string)=>stockItems.find(s=>s.id===id)
 function openWaste(s?:StockItem){setWaste({stockId:s?.id??'',amount:'',unit:s?.unit??'',reason:''})}
 async function saveWaste(){if(!waste)return;const s=item(waste.stockId);if(!s)return
  await act(async()=>{await commands.stockRecord(s.id,'waste',convert(waste.amount,waste.unit||s.unit,s.unit,s.packs),waste.reason);setWaste(undefined)},`${s.name} dicatat terbuang`)}
 return <section className={`page-content station ${dark?'dark':''}`}>
  <div className="page-heading"><div><p className="eyebrow">Stasiun</p><h1>{station==='bar'?'Bar':'Dapur'}</h1><p className="muted">{tickets.length} tiket menunggu · target {target} menit</p></div>
   <span className="badge"><Clock size={15}/>{when(now,settings?.timezone,{hour:'2-digit',minute:'2-digit'})}</span></div>
  <div className="station-bar">
   <div className="segmented" aria-label="Pilih stasiun">
    <button className={station==='kitchen'?'active':''} onClick={()=>setStation('kitchen')}><ChefHat size={16}/> Dapur</button>
    <button className={station==='bar'?'active':''} onClick={()=>setStation('bar')}><Coffee size={16}/> Bar</button>
   </div>
   <Button variant="secondary" onClick={()=>setDark(!dark)} aria-label={dark?'Mode terang':'Mode gelap'}>{dark?<Sun size={17}/>:<Moon size={17}/>} {dark?'Terang':'Gelap'}</Button>
   <Button variant="secondary" onClick={()=>openWaste()}><Trash2 size={17}/> Catat buang</Button>
  </div>
  <div className="station-grid">
   {tickets.map(o=><article className={`ticket ${minutes(o)>target?'late':''}`} key={o.id}>
    <div className="ticket-head"><h2>{o.label||o.receiptId.slice(-6)}</h2><span className="ticket-age">{minutes(o)} mnt{minutes(o)>target?' · terlambat':''}</span></div>
    <p className="muted small">{o.mode==='dinein'?'Makan di sini':'Bungkus'} · {when(sentAt(o),settings?.timezone,{hour:'2-digit',minute:'2-digit'})}</p>
    <div>{o.lines.filter(l=>l.prepared&&!l.cancelled&&!l.readyAt&&mine(l)).map(l=><div className="ticket-line" key={l.id}><strong>{l.qty}× {l.name}</strong>{l.modifiers.length>0&&<small>{l.modifiers.map(m=>m.name).join(', ')}</small>}{l.note&&<small className="line-note">{l.note}</small>}</div>)}</div>
    <div className="button-row">
     <Button className="full" disabled={busy} onClick={()=>void act(()=>commands.ready(o.id,station),'Tiket siap; kasir bisa memanggil pager')}><Check size={18}/> Siap</Button>
     <Button variant="secondary" size="icon" aria-label="Cetak tiket" onClick={()=>setPrinting(o)}><Printer size={17}/></Button>
    </div>
   </article>)}
  </div>
  {!tickets.length&&<div className="empty-state"><ChefHat size={42} strokeWidth={1.3}/><h2>Tidak ada tiket</h2><p>Tiket muncul di sini beberapa detik setelah kasir mengirim pesanan.</p></div>}
  <div className="station-side">
   <article className="panel"><div className="panel-heading"><h2><CookingPot size={17}/> Perlu dibuat</h2><span className="badge">{prep.length}</span></div>
    {prep.length?prep.map(p=><div className="bill-row" key={p.item.id}><span>{p.item.name} · sisa {quantity(p.balance)} {p.item.unit}</span><strong>{p.batches} batch</strong></div>):<p className="muted">Semua bahan olahan di atas par.</p>}
    <Button asChild variant="secondary" className="mt"><Link to="/production">Buat batch</Link></Button>
   </article>
   <article className="panel"><div className="panel-heading"><h2><Clock size={17}/> Segera kedaluwarsa</h2><span className="badge">{expiringPrep.length}</span></div>
    {expiringPrep.length?expiringPrep.map(e=><div className="bill-row" key={e.movement.id}><span>{e.item.name} · batch {when(e.movement.at,settings?.timezone,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}{e.expired?' · kedaluwarsa':` · sampai ${when(e.expiresAt,settings?.timezone,{hour:'2-digit',minute:'2-digit'})}`}</span>
     <Button size="sm" variant="secondary" disabled={busy||balance(e.item.id)<=0} onClick={()=>void act(()=>commands.stockRecord(e.item.id,'waste',e.remaining,'Kedaluwarsa'),'Sisa batch dicatat terbuang')}>Buang sisa {quantity(e.remaining)} {e.item.unit}</Button></div>):<p className="muted">Tidak ada batch yang mendekati masa simpan.</p>}
   </article>
  </div>
  {user.mode!=='station'&&!user.primary&&<p className="callout">Perangkat ini belum dipasangkan sebagai stasiun (Lainnya → Perangkat), jadi tombol Siap dan catat buang belum bisa dipakai.</p>}
  <Dialog open={Boolean(waste)} onOpenChange={()=>setWaste(undefined)} title="Catat buang" description="Bahan, jumlah, alasan. Dicatat atas nama Anda.">
   {waste&&<>
    <Select label="Bahan" value={waste.stockId} onChange={v=>setWaste({...waste,stockId:v,unit:item(v)?.unit??''})} options={[{value:'',label:'Pilih bahan'},...[...here,...stockItems.filter(s=>!here.includes(s))].map(s=>({value:s.id,label:`${s.name} (${s.unit})`}))]}/>
    <div className="form-grid">
     <label>Jumlah<input inputMode="decimal" value={waste.amount} onChange={e=>setWaste({...waste,amount:e.target.value})} placeholder="0"/></label>
     <Select label="Satuan" value={waste.unit} onChange={v=>setWaste({...waste,unit:v})} options={(()=>{const s=item(waste.stockId);return s?[{value:s.unit,label:s.unit},...(s.unit==='g'?[{value:'kg',label:'kg'}]:s.unit==='ml'?[{value:'l',label:'liter'}]:[]),...(s.packs??[]).map(p=>({value:p.name,label:`${p.name} (${quantity(p.qty)} ${s.unit})`}))]:[{value:'',label:'Pilih bahan dulu'}]})()}/>
    </div>
    <div className="reason-chips">{REASONS.map(r=><button key={r} className={waste.reason===r?'active':''} onClick={()=>setWaste({...waste,reason:r})}>{r}</button>)}</div>
    <Button className="full" loading={busy} disabled={busy||!waste.stockId||!waste.amount||!waste.reason} onClick={()=>void saveWaste()}><Trash2 size={17}/> Simpan</Button>
   </>}
  </Dialog>
  {printing&&<Receipt order={printing} kitchen station={station} reprint onClose={()=>setPrinting(undefined)}/>}
 </section>
}
