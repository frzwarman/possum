import { useLiveQuery } from 'dexie-react-hooks'
import { useApp } from '../../app/context'
import { businessDay,rupiah,when } from '../../domain/calculate'
import type { Order } from '../../domain/types'
import { lineTotal } from './Receipt'

// Figma Cashier 4 "Orders: voided, totals per person" (reviewer: "perlu diliat cashier berapa kali voidnya"): who
// voided, how often and how much, today and this month. A void is made on the order's own shift, so it counts for the
// cashier whose order it was. A voided item is one void; a whole order voided is one too.
type Void={who:string;items:number;amount:number;what:string;no:string}
const voidsOf=(o:Order):Void[]=>{
 const no=o.receiptId.slice(-6).toUpperCase()
 if(o.status==='void')return [{who:o.cashier,items:o.lines.filter(l=>!l.cancelled).reduce((n,l)=>n+l.qty,0),amount:o.totals.total,what:'seluruh pesanan',no}]
 return o.lines.filter(l=>l.cancelled).map(l=>({who:o.cashier,items:l.qty,amount:lineTotal(l),what:`${l.qty}× ${l.name}`,no}))
}
const byPerson=(list:Void[])=>[...list.reduce((m,v)=>{const p=m.get(v.who)??{who:v.who,count:0,items:0,amount:0,what:[] as string[],nos:[] as string[]};p.count++;p.items+=v.items;p.amount+=v.amount;p.what.push(v.what);p.nos.push(v.no);return m.set(v.who,p)},new Map<string,{who:string;count:number;items:number;amount:number;what:string[];nos:string[]}>()).values()].sort((a,b)=>b.count-a.count||b.amount-a.amount)
const initials=(name:string)=>name.split(/\s+/).filter(Boolean).map(w=>w[0]).join('').slice(0,2).toUpperCase()

export function VoidSummary(){
 const {orders,db,settings}=useApp()
 const tz=settings?.timezone,day=(iso:string)=>businessDay(iso,tz,settings?.cutoff),today=day(new Date().toISOString())
 // The till keeps its newest 500 orders in memory; a month is read from the device's store (a day early, for the cutoff).
 const since=new Date(new Date(`${today.slice(0,7)}-01T00:00:00Z`).getTime()-86400000).toISOString()
 const month=useLiveQuery(()=>db.orders.where('createdAt').aboveOrEqual(since).toArray(),[db,since])??[]
 const todays=orders.filter(o=>day(o.createdAt)===today).flatMap(voidsOf),people=byPerson(todays)
 const monthly=byPerson(month.filter(o=>day(o.createdAt).slice(0,7)===today.slice(0,7)).flatMap(voidsOf))
 const top=monthly.length>1&&monthly[0].count>monthly[1].count?monthly[0].who:undefined
 return <aside className="panel void-summary" aria-label="Pembatalan hari ini">
  <h2>Pembatalan hari ini</h2>
  <p className="small muted">{when(Date.now(),tz,{weekday:'long',day:'numeric',month:'long'})}. Siapa, berapa kali, berapa nilainya.</p>
  <div className="void-stats"><div><strong>{todays.length} pembatalan</strong><small>{todays.reduce((n,v)=>n+v.items,0)} item</small></div><div><strong>{rupiah(todays.reduce((n,v)=>n+v.amount,0))}</strong><small>dipotong dari tagihan</small></div></div>
  <h3>Per orang, hari ini</h3>
  {people.length?people.map(p=><div className="void-person" key={p.who}><span className="avatar">{initials(p.who)}</span><div><strong>{p.who}</strong><small>{p.count} pembatalan · {p.what.join(', ')}</small></div><div className="num"><strong>{rupiah(p.amount)}</strong><small>{p.nos.join(', ')}</small></div></div>):<p className="small muted">Belum ada pembatalan hari ini.</p>}
  <h3>Per orang, bulan ini</h3>
  {monthly.length?monthly.map(p=><div className="void-person" key={p.who}><span className={`avatar${p.who===top?' critical':''}`}>{initials(p.who)}</span><div><strong>{p.who}</strong><small className={p.who===top?'critical-text':undefined}>{p.count} pembatalan{p.who===top?' · terbanyak bulan ini':''}</small></div><div className="num"><strong>{rupiah(p.amount)}</strong><small>{p.items} item</small></div></div>):<p className="small muted">Belum ada pembatalan bulan ini.</p>}
  <p className="small muted void-note">Setiap pembatalan disetujui manajer, dengan PIN atau lewat Telegram. Alasannya tercatat di Log audit.</p>
 </aside>
}
