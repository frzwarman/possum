import { useEffect, useRef, useState } from 'react'
import { Link, Navigate } from '@tanstack/react-router'
import { Bell, TrendingUp, Percent, Trash2, Scale, AlertTriangle, Ban, ClipboardList, ChefHat, Clock } from 'lucide-react'
import { useApp } from '../../app/context'
import { Button } from '../../components/ui/button'
import { businessDay, countsDue, daysLeft, expiring, quantity, rupiah, usagePerDay, when } from '../../domain/calculate'
import { can } from '../../domain/permissions'
// F7: one screen that says what needs the manager, each line linking to its fix.
export default function Today(){
 const {orders,movements,stockItems,menu,counts,settings,costs,balance,user}=useApp()
 const [permission,setPermission]=useState<NotificationPermission|'unsupported'>(()=>typeof Notification==='undefined'?'unsupported':Notification.permission)
 const notified=useRef(new Set<string>())
 if(!can(user.role,'backoffice'))return <Navigate to="/pos"/>
 const day=(iso:string)=>businessDay(iso,settings?.timezone,settings?.cutoff),today=day(new Date().toISOString())
 const paid=orders.filter(o=>o.payment&&day(o.payment.at)===today&&o.status!=='refunded'),sales=paid.reduce((n,o)=>n+o.totals.total,0)
 const value=(kind:string)=>movements.filter(m=>m.kind===kind&&day(m.at)===today).reduce((n,m)=>n+m.qty*(costs.get(m.stockId)??0),0)
 const cogs=-value('preparation'),waste=-value('waste'),gap=value('count')
 const low=stockItems.filter(s=>balance(s.id)<=s.threshold).map(s=>({item:s,days:daysLeft(balance(s.id),usagePerDay(movements,s.id))})).sort((a,b)=>a.days-b.days)
 const voids=orders.filter(o=>o.status==='void'&&day(o.updatedAt)===today)
 const gaps=movements.filter(m=>m.kind==='count'&&day(m.at)===today&&m.qty!==0).sort((a,b)=>Math.abs(b.qty*(costs.get(b.stockId)??0))-Math.abs(a.qty*(costs.get(a.stockId)??0)))
 const noRecipe=menu.filter(m=>m.active&&!m.recipe.length)
 const due=countsDue(stockItems,movements,counts),soon=expiring(stockItems,movements,2)
 const item=(id:string)=>stockItems.find(s=>s.id===id)
 // TDY-2: a browser notification for each ingredient that reaches par while this screen is open.
 useEffect(()=>{if(permission!=='granted')return;for(const l of low)if(!notified.current.has(l.item.id)){notified.current.add(l.item.id);try{new Notification(`${l.item.name} mencapai par`,{body:l.days===Infinity?`Sisa ${quantity(balance(l.item.id))} ${l.item.unit}`:`Sisa ${quantity(balance(l.item.id))} ${l.item.unit} · ±${l.days} hari lagi`})}catch{/* not supported here */}}},[low,permission,balance])
 const waiting=low.length+voids.length+gaps.length+noRecipe.length+due.weekly.length+soon.length
 return <section className="page-content">
  <div className="page-heading"><div><p className="eyebrow">{when(Date.now(),settings?.timezone,{weekday:'long',day:'numeric',month:'long'})}</p><h1>Hari ini</h1><p className="muted">{waiting?`${waiting} hal menunggu Anda.`:'Tidak ada yang menunggu. Hari yang tenang.'}</p></div>
   {permission==='default'&&<Button variant="secondary" onClick={()=>void Notification.requestPermission().then(setPermission)}><Bell size={16}/> Aktifkan notifikasi</Button>}
  </div>
  <div className="metrics">
   <article className="metric featured"><span><TrendingUp size={18}/> Penjualan</span><strong>{rupiah(sales)}</strong><small>{paid.length} transaksi lunas hari ini</small></article>
   <article className="metric"><span><Percent size={18}/> Food cost</span><strong>{sales?Math.round(cogs/sales*100):0}%</strong><small>bahan terpakai {rupiah(Math.round(cogs))}</small></article>
   <article className="metric"><span><Trash2 size={18}/> Terbuang</span><strong>{rupiah(Math.round(waste))}</strong><small>dari catatan buang hari ini</small></article>
   <article className="metric"><span><Scale size={18}/> Selisih hitung</span><strong>{rupiah(Math.round(gap))}</strong><small>hasil hitung dikurangi sistem</small></article>
  </div>
  <div className="report-columns">
   <article className="panel"><div className="panel-heading"><h2><AlertTriangle size={17}/> Stok di bawah par</h2><Link to="/inventory" className="text-button">Ke Stok</Link></div>
    {low.length?low.map(l=><div className="bill-row" key={l.item.id}><span>{l.item.name} · sisa {quantity(balance(l.item.id))} {l.item.unit}</span><strong>{l.days===Infinity?'belum terpakai':`±${l.days} hari`}</strong></div>):<p className="muted">Semua bahan di atas par.</p>}
   </article>
   <article className="panel"><div className="panel-heading"><h2><Ban size={17}/> Pembatalan hari ini</h2><Link to="/audit" className="text-button">Log audit</Link></div>
    {voids.length?voids.map(o=><div className="bill-row" key={o.id}><span>{o.label||o.receiptId} · {o.cashier} · {o.voidReason}</span><strong>{rupiah(o.totals.total)}</strong></div>):<p className="muted">Tidak ada pembatalan.</p>}
   </article>
   <article className="panel"><div className="panel-heading"><h2><ClipboardList size={17}/> Hitung stok</h2><Link to="/counts" className="text-button">Ke Hitung stok</Link></div>
    {gaps.map(m=><div className="bill-row" key={m.id}><span>{item(m.stockId)?.name} · {m.reason}</span><strong className={m.qty<0?'negative':'positive'}>{m.qty>0?'+':''}{quantity(m.qty)} {item(m.stockId)?.unit}</strong></div>)}
    {due.weekly.length>0&&<p className="callout">Hitungan mingguan jatuh tempo untuk {due.weekly.length} bahan terpakai tersering{due.monthly.length>due.weekly.length?`, bulanan untuk ${due.monthly.length} bahan`:''}.</p>}
    {!gaps.length&&!due.weekly.length&&<p className="muted">Tidak ada selisih dan tidak ada hitungan yang jatuh tempo.</p>}
   </article>
   <article className="panel"><div className="panel-heading"><h2><ChefHat size={17}/> Menu tanpa resep</h2><Link to="/settings" className="text-button">Ke Menu & resep</Link></div>
    {noRecipe.length?noRecipe.map(m=><div className="bill-row" key={m.id}><span>{m.name}</span><span className="badge badge-warning">tidak memotong stok</span></div>):<p className="muted">Setiap menu aktif punya resep.</p>}
   </article>
   <article className="panel"><div className="panel-heading"><h2><Clock size={17}/> Batch mendekati masa simpan</h2><Link to="/production" className="text-button">Ke Batch</Link></div>
    {soon.length?soon.map(e=><div className="bill-row" key={e.movement.id}><span>{e.item.name} · {when(e.movement.at,settings?.timezone,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</span><strong>{e.expired?'kedaluwarsa':when(e.expiresAt,settings?.timezone,{hour:'2-digit',minute:'2-digit'})}</strong></div>):<p className="muted">Tidak ada.</p>}
   </article>
  </div>
 </section>
}
