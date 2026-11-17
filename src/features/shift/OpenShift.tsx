import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Check, CircleCheck, CircleAlert, Info } from 'lucide-react'
import { useApp } from '../../app/context'
import { Button } from '../../components/ui/button'
import { Money } from '../../components/ui/money'
import { rupiah, tills, when } from '../../domain/calculate'
import type { ReactNode } from 'react'
// Figma C1 "Open shift": greet the cashier, check what takes payments today, see what is not ready, open.
// Every status on the right comes from the store's own data; nothing here claims a check the app cannot make.
export function OpenShift(){
 const {user,settings,menu,canMake,stockItems,balance,online,outbox,commands,act,busy,shifts}=useApp()
 const navigate=useNavigate()
 const {cash,edcs,edc}=tills(settings)
 const [opening,setOpening]=useState('200000')
 const [checked,setChecked]=useState<string[]>([])
 const hour=Number(new Date().toLocaleString('en-GB',{timeZone:settings?.timezone,hour:'2-digit',hourCycle:'h23'}))
 const greeting=hour<11?'Selamat pagi':hour<15?'Selamat siang':hour<18?'Selamat sore':'Selamat malam'
 const first=user.name.split(/\s+/)[0]
 const soldOut=menu.filter(m=>m.active&&canMake(m).soldOut).map(m=>m.name)
 const low=stockItems.filter(s=>balance(s.id)<=s.threshold).length
 const unsent=outbox.filter(o=>o.state!=='synced').length
 // Continuity with the shift before: when it closed, who closed it, the cash they counted (never the expected amount).
 const last=shifts.filter(s=>s.status==='closed'&&s.closedAt).sort((a,b)=>b.closedAt!.localeCompare(a.closedAt!)).at(0)
 const drawer=last&&(last.settlements?(last.counted??0)-last.settlements.reduce((n,x)=>n+x.slip,0):(last.counted??0))
 const list=(names:string[])=>names.length<=2?names.join(' dan '):`${names.slice(0,2).join(', ')} dan ${names.length-2} lagi`
 async function open(){
  await act(async()=>{await commands.openShift(cash?Number(opening):0);await navigate({to:'/pos'})},'Sif dibuka. Selamat melayani.')
 }
 return <section className="page-content open-shift">
  <header className="open-shift-head"><span className="avatar">{user.name.split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase()}</span>
   <h1>{greeting}, {first}</h1><p className="muted">{user.primary?'Tablet kasir':'Perangkat ini'}, {when(Date.now(),settings?.timezone,{weekday:'long',day:'numeric',month:'long'})}</p>
   {last&&<p className="small muted last-shift">Sif terakhir ditutup {when(last.closedAt!,settings?.timezone,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})} oleh {last.cashier}{cash?` · uang tunai dihitung ${rupiah(drawer??0)}`:''}</p>}</header>
  <div className="open-shift-grid">
   <article className="panel"><h2>Pembayaran hari ini</h2>
    <p className="small muted">{edc&&!cash?`${settings?.name||'Toko ini'} tanpa tunai. Tamu bayar kartu atau QRIS di mesin EDC.`:edc?'Tunai di laci, kartu dan QRIS di mesin EDC.':'Tunai di laci, kartu dan QRIS dicek manual.'}</p>
    {edc&&<div className="ready-list">{edcs.map(e=>{const on=checked.includes(e);return <button type="button" key={e} className={`ready-row ${on?'ok':''}`} aria-pressed={on} onClick={()=>setChecked(on?checked.filter(x=>x!==e):[...checked,e])}>
     {on?<CircleCheck size={20}/>:<span className="ready-dot"/>}<span><strong>EDC {e}</strong><small>{on?'Kartu dan QRIS, kertas terisi':'Ketuk bila menyala dan kertas terisi'}</small></span></button>})}</div>}
    {cash&&<label>Modal kas awal<Money value={opening} onChange={setOpening}/></label>}
    <Button className="full btn-accent" loading={busy} disabled={busy||!user.primary} onClick={()=>open()}><Check size={18}/> Buka sif sekarang</Button>
    {!user.primary&&<p className="small muted center">Sif hanya bisa dibuka di perangkat kasir utama.</p>}
   </article>
   <article className="panel"><h2>Siap mulai</h2>
    <div className="ready-list">
     <Status title="Printer struk" text={<>Dicetak lewat browser · <Link to="/settings" className="text-button">tes cetak</Link></>}/>
     <Status ok={online&&!unsent} title="Internet" text={!online?'Offline: membuka sif perlu internet':unsent?`${unsent} operasi menunggu terkirim`:'Tersambung dan tersinkron'}/>
     {/* An empty list is not "all good": with nothing set up yet the row says so, in the neutral style. */}
     <Status ok={menu.some(m=>m.active)?!soldOut.length:undefined} title="Menu" text={!menu.some(m=>m.active)?'Belum ada menu aktif':soldOut.length?`${list(soldOut)} habis`:'Semua menu tersedia'}/>
     <Status ok={stockItems.length?!low:undefined} title="Stok" text={!stockItems.length?'Belum ada bahan tercatat':low?<>{low} bahan di bawah par · <Link to="/inventory" className="text-button">lihat</Link></>:'Semua bahan di atas par'}/>
    </div>
   </article>
  </div>
 </section>
}
// A check on the left: green when fine, amber when the cashier should know, grey for information only.
function Status({ok,title,text}:{ok?:boolean;title:string;text:ReactNode}){
 return <div className={`ready-row ${ok===undefined?'info':ok?'ok':'warn'}`}>{ok===undefined?<Info size={20}/>:ok?<CircleCheck size={20}/>:<CircleAlert size={20}/>}<span><strong>{title}</strong><small>{text}</small></span></div>
}
