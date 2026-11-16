import { useEffect, useRef, useState } from 'react'
import { Link, Navigate } from '@tanstack/react-router'
import { Bell, ChartColumn, Percent, Trash2, CircleAlert, Milk, Ban, Scale, ChefHat, Clock, ArrowRight, ClipboardList } from 'lucide-react'
import { useApp } from '../../app/context'
import { businessDay, countsDue, daysLeft, expiring, isSale, itemStation, niceStep, quantity, rupiah, usagePerDay, when } from '../../domain/calculate'
import { can } from '../../domain/permissions'
import type { ReactNode } from 'react'
// Figma M1 "Today": three numbers, sales by hour, what needs the manager, what runs low; on the right the count that
// is due, the compliment budget and who is on shift. Every line links to where it is fixed.
export default function Today(){
 const {orders,movements,stockItems,menu,counts,settings,costs,balance,user,shift}=useApp()
 const [permission,setPermission]=useState<NotificationPermission|'unsupported'>(()=>typeof Notification==='undefined'?'unsupported':Notification.permission)
 const [all,setAll]=useState(false)
 const notified=useRef(new Set<string>())
 if(!can(user.role,'backoffice'))return <Navigate to="/pos"/>
 const tz=settings?.timezone
 const day=(iso:string)=>businessDay(iso,tz,settings?.cutoff),today=day(new Date().toISOString())
 const paid=orders.filter(o=>o.payment&&day(o.payment.at)===today&&o.status!=='refunded'&&isSale(o)),sales=paid.reduce((n,o)=>n+o.totals.total,0)
 const value=(kind:string)=>movements.filter(m=>m.kind===kind&&day(m.at)===today).reduce((n,m)=>n+m.qty*(costs.get(m.stockId)??0),0)
 const cogs=-value('preparation'),wasted=movements.filter(m=>m.kind==='waste'&&day(m.at)===today),waste=-value('waste'),gap=value('count')
 const low=stockItems.filter(s=>balance(s.id)<=s.threshold).map(s=>({item:s,out:balance(s.id)<=0,days:daysLeft(balance(s.id),usagePerDay(movements,s.id))})).sort((a,b)=>Number(b.out)-Number(a.out)||a.days-b.days)
 const soldOut=menu.filter(m=>m.active&&m.soldOut)
 const voids=orders.filter(o=>o.status==='void'&&day(o.updatedAt)===today)
 const gaps=movements.filter(m=>m.kind==='count'&&day(m.at)===today&&m.qty!==0)
 const noRecipe=menu.filter(m=>m.active&&!m.recipe.length)
 const due=countsDue(stockItems,movements,counts),soon=expiring(stockItems,movements,2)
 const item=(id:string)=>stockItems.find(s=>s.id===id)
 // Compliment budget: what staff meals and the owner's family took this calendar month, against the manager's budget.
 const month=today.slice(0,7),given=orders.filter(o=>o.mode==='compliment'&&o.status==='paid'&&day(o.payment!.at).startsWith(month)),budget=settings?.complimentBudget??0
 const by=(k:string)=>given.filter(o=>o.compliment?.kind===k),worth=(list:typeof given)=>list.reduce((n,o)=>n+o.discount,0),used=worth(given)
 const now=new Date(),monthEnd=new Date(now.getFullYear(),now.getMonth()+1,0).getDate()-now.getDate()
 // TDY-2: a browser notification for each ingredient that reaches par while this screen is open.
 useEffect(()=>{if(permission!=='granted')return;for(const l of low)if(!notified.current.has(l.item.id)){notified.current.add(l.item.id);try{new Notification(`${l.item.name} mencapai par`,{body:l.days===Infinity?`Sisa ${quantity(balance(l.item.id))} ${l.item.unit}`:`Sisa ${quantity(balance(l.item.id))} ${l.item.unit} · ±${l.days} hari lagi`})}catch{/* not supported here */}}},[low,permission,balance])
 // Sales by hour, split by the station that makes the item (kitchen or bar), from the first to the last trading hour.
 const hourOf=(iso:string)=>Number(new Date(iso).toLocaleString('en-GB',{timeZone:tz,hour:'2-digit',hourCycle:'h23'}))
 const station=(id:string)=>{const m=menu.find(x=>x.id===id);return m?itemStation(m):'kitchen'}
 const byHour=new Map<number,{kitchen:number;bar:number}>()
 for(const o of paid)for(const l of o.lines)if(!l.cancelled){const h=hourOf(o.payment!.at),v=(l.price+l.modifiers.reduce((n,m)=>n+m.price,0))*l.qty,s=station(l.itemId)==='bar'?'bar':'kitchen',b=byHour.get(h)??{kitchen:0,bar:0};b[s]+=v;byHour.set(h,b)}
 const seen=[...byHour.keys(),hourOf(now.toISOString())],first=Math.min(7,...seen),last=Math.max(first+8,...seen)
 const hours=Array.from({length:last-first+1},(_,i)=>first+i),peak=Math.max(0,...[...byHour.values()].flatMap(b=>[b.kitchen,b.bar]))||400_000
 const step=niceStep(peak),top=step*4
 // Needs you: one row per thing to fix, most urgent first.
 const needs:{key:string;icon:ReactNode;text:string;to:string;tone:string}[]=[
  ...soldOut.map(m=>({key:`so-${m.id}`,icon:<CircleAlert size={16}/>,text:`${m.name} habis`,to:'/inventory',tone:'critical'})),
  ...low.map(l=>({key:`low-${l.item.id}`,icon:<Milk size={16}/>,text:`${l.item.name} ${l.out?'habis':'hampir habis'}`,to:'/inventory',tone:'warning'})),
  ...voids.map(o=>({key:`void-${o.id}`,icon:<Ban size={16}/>,text:`Pembatalan ${o.label||o.receiptId}`,to:'/audit',tone:'critical'})),
  ...gaps.map(m=>({key:`gap-${m.id}`,icon:<Scale size={16}/>,text:`Selisih hitung ${item(m.stockId)?.name??''}`,to:'/counts',tone:'info'})),
  ...soon.map(e=>({key:`exp-${e.movement.id}`,icon:<Clock size={16}/>,text:`${e.item.name} ${e.expired?'kedaluwarsa':'segera kedaluwarsa'}`,to:'/production',tone:'warning'})),
  ...noRecipe.map(m=>({key:`rec-${m.id}`,icon:<ChefHat size={16}/>,text:`${m.name} belum punya resep`,to:'/settings',tone:'info'})),
 ]
 const runsOut=(out:boolean,d:number)=>out?['critical','Habis']:d===Infinity?['neutral','Belum terpakai']:d<1?['warning','Hari ini']:d===1?['warning','Besok']:['warning',`${d} hari`]
 const opened=shift?when(shift.openedAt,tz,{hour:'2-digit',minute:'2-digit'}):''
 const initials=(n:string)=>n.split(/\s+/).slice(0,2).map(w=>w[0]??'').join('').toUpperCase()
 return <section className="page-content today">
  <div className="page-heading"><div><h1>Hari ini</h1><p className="muted">{when(Date.now(),tz,{weekday:'long',day:'numeric',month:'long'})}{shift?`, buka sejak ${opened}`:''}</p></div>
   {permission==='default'&&<button type="button" className="icon-button" aria-label="Aktifkan notifikasi" onClick={()=>void Notification.requestPermission().then(setPermission)}><Bell size={18}/></button>}
  </div>
  <div className="today-grid">
   <div className="today-main">
    <div className="metrics">
     <article className="metric"><span><ChartColumn size={16}/> Penjualan</span><strong>{rupiah(sales)}</strong><small>{paid.length} transaksi lunas hari ini</small></article>
     <article className="metric"><span><Percent size={16}/> Food cost</span><strong>{sales?Math.round(cogs/sales*100):0}%</strong><small>bahan terpakai {rupiah(Math.round(cogs))}</small></article>
     <article className="metric"><span><Trash2 size={16}/> Terbuang</span><strong>{rupiah(Math.round(waste))}</strong><small>{wasted.length} catatan{gap?`, selisih hitung ${rupiah(Math.round(gap))}`:''}</small></article>
    </div>
    <div className="today-row">
     <article className="panel hour-panel"><div className="panel-heading"><h2>Penjualan per jam</h2><span className="legend"><i className="kitchen"/>Dapur<i className="bar"/>Bar</span></div>
      <div className="hour-chart" role="img" aria-label={`Penjualan per jam hari ini, total ${rupiah(sales)}`}>
       <div className="hour-axis">{[4,3,2,1,0].map(i=><span key={i}>{short(step*i)}</span>)}</div>
       <div className="hour-plot">{hours.map(h=>{const b=byHour.get(h);return <div key={h} className={`hour-col ${b?'':'empty'}`}><div className="hour-bars"><i className="kitchen" style={{height:`${(b?.kitchen??0)/top*100}%`}}/><i className="bar" style={{height:`${(b?.bar??0)/top*100}%`}}/></div><span>{String(h).padStart(2,'0')}</span></div>})}</div>
      </div>
     </article>
     <article className="panel needs-panel"><div className="panel-heading"><h2>Perlu Anda</h2>{needs.length>3&&<button type="button" className="text-link" onClick={()=>setAll(!all)}>{all?'Lebih sedikit':`Lihat semua ${needs.length}`}</button>}</div>
      {needs.length?<div className="need-list">{(all?needs:needs.slice(0,3)).map(n=><Link key={n.key} to={n.to} className={`need-row ${n.tone}`}><span className="need-icon">{n.icon}</span><span>{n.text}</span><ArrowRight size={16}/></Link>)}</div>:<p className="muted">Tidak ada yang menunggu. Hari yang tenang.</p>}
     </article>
    </div>
    <article className="panel"><div className="panel-heading"><h2>Hampir habis</h2>{can(user.role,'documents')&&<Link to="/purchases" className="dark-button">Pesan stok</Link>}</div>
     {low.length?<div className="table-scroll"><table className="data-table plain-table"><thead><tr><th>Bahan</th><th>Area</th><th>Sisa</th><th>Habis</th></tr></thead><tbody>{low.map(l=>{const [tone,label]=runsOut(l.out,l.days);return <tr key={l.item.id}><td><strong>{l.item.name}</strong></td><td className="muted">{l.item.area||'-'}</td><td className="muted">{quantity(balance(l.item.id))} {l.item.unit}</td><td><span className={`dot-chip ${tone}`}>{label}</span></td></tr>})}</tbody></table></div>:<p className="muted">Semua bahan di atas par.</p>}
    </article>
   </div>
   <aside className="today-side">
    {(due.weekly.length>0||due.monthly.length>0)&&<article className="cta-card"><ClipboardList/><h2>{due.weekly.length?'Hitungan mingguan hari ini':'Hitungan bulanan jatuh tempo'}</h2><p>{(due.weekly.length||due.monthly.length)} bahan, sekitar {Math.max(5,Math.round((due.weekly.length||due.monthly.length)*0.75))} menit</p><Link to="/counts" className="cta-button">Mulai hitung</Link></article>}
    <article className="panel budget-panel"><div className="panel-heading"><h2>Anggaran compliment</h2><span className="month-chip">{when(Date.now(),tz,{month:'long'})}</span></div>
     <strong className="budget-used">{rupiah(used)}</strong>
     <p className="small muted">{budget?`terpakai dari anggaran ${rupiah(budget)}`:'Belum ada anggaran (Lainnya → Restoran)'}</p>
     {budget>0&&<div className="budget-track" role="meter" aria-label="Anggaran compliment terpakai" aria-valuenow={used} aria-valuemin={0} aria-valuemax={budget}><i style={{width:`${Math.min(100,Math.round(used/budget*100))}%`}}/></div>}
     <div className="budget-line"><span><strong>Staff meal</strong><small>{by('staff').length} pesanan</small></span><strong>{rupiah(worth(by('staff')))}</strong></div>
     <div className="budget-line"><span><strong>Keluarga pemilik</strong><small>{by('family').length} pesanan, semua gratis</small></span><strong>{rupiah(worth(by('family')))}</strong></div>
     {budget>0&&<p className="small muted">{used>budget?`Melewati anggaran ${rupiah(used-budget)}.`:`Sisa ${Math.round((budget-used)/budget*100)}% untuk ${monthEnd} hari lagi.`}</p>}
    </article>
    <article className="panel"><div className="panel-heading"><h2>Sedang bertugas</h2></div>
     {shift?<Link to="/reports" className="person-row"><span className="avatar">{initials(shift.cashier)}</span><span><strong>{shift.cashier}</strong><small>Kasir, sejak {opened}</small></span><ArrowRight size={16}/></Link>:<p className="muted">Belum ada sif terbuka.</p>}
    </article>
   </aside>
  </div>
 </section>
}
// Axis steps a person reads at a glance: 1, 2 or 5 times a power of ten, four of them reaching the peak.
const short=(v:number)=>v>=1_000_000?`${+(v/1_000_000).toFixed(1)}jt`:v>=1000?`${Math.round(v/1000)}rb`:String(v)
