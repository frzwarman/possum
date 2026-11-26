import type { Table,Transaction } from 'dexie'
import { unitCosts } from '../domain/calculate'
import type { MejaDB } from './db'
import type { Order } from '../domain/types'
// QA PERF-5: the till kept every movement and the newest 500 orders in React state, and every write (one Bayar tap writes
// an order and its movements) re-read all of them from IndexedDB. These two keep the same figures up to date from what a
// write touched: a transaction that completes names the keys it changed (Dexie hooks), and only those are read again.
// Hooks see this tab's writes only: another tab's are caught by catchUp() when this tab is shown again.
export function touched<T>(table:Table<T,string>,keyOf:(pk:string,obj:T)=>string,fn:(keys:Set<string>)=>void){
 const seen=new WeakMap<Transaction,Set<string>>()
 const note=(pk:string,obj:T,tx:Transaction)=>{let s=seen.get(tx);if(!s){const mine=s=new Set<string>();seen.set(tx,mine);tx.on('complete',()=>fn(mine))}s.add(keyOf(pk,obj))}
 const create=function(this:unknown,pk:string,obj:T,tx:Transaction){note(pk,obj,tx)}
 const update=function(this:unknown,_m:object,pk:string,obj:T,tx:Transaction){note(pk,obj,tx)}
 const remove=function(this:unknown,pk:string,obj:T,tx:Transaction){note(pk,obj,tx)}
 table.hook('creating',create as never);table.hook('updating',update as never);table.hook('deleting',remove as never)
 return()=>{table.hook('creating').unsubscribe(create as never);table.hook('updating').unsubscribe(update as never);table.hook('deleting').unsubscribe(remove as never)}
}
class Serial{private chain:Promise<unknown>=Promise.resolve();run(f:()=>Promise<unknown>){this.chain=this.chain.then(f).catch(()=>undefined)}}
// Balance and latest unit cost per ingredient. Each ingredient's figures are summed from its own rows in the same order
// the whole table was (primary key), so they equal what the old whole-table pass gave.
export class Tally extends Serial{
 balances=new Map<string,number>();units=new Map<string,number>();private rows=new Map<string,number>();private total=0
 constructor(private db:MejaDB,private emit:(s:{balances:Map<string,number>;units:Map<string,number>})=>void){super()}
 private publish(){this.emit({balances:new Map(this.balances),units:new Map(this.units)})}
 async load(){
  const all=await this.db.movements.toArray(),b=new Map<string,number>(),r=new Map<string,number>()
  for(const m of all){b.set(m.stockId,(b.get(m.stockId)||0)+m.qty);r.set(m.stockId,(r.get(m.stockId)||0)+1)}
  this.balances=b;this.rows=r;this.total=all.length;this.units=unitCosts(all);this.publish()
 }
 async refresh(ids:Set<string>){
  for(const id of ids){
   const rows=await this.db.movements.where('stockId').equals(id).toArray()
   this.total+=rows.length-(this.rows.get(id)??0)
   if(rows.length){this.rows.set(id,rows.length);this.balances.set(id,rows.reduce((n,m)=>n+m.qty,0));const u=unitCosts(rows).get(id);if(u===undefined)this.units.delete(id);else this.units.set(id,u)}
   else{this.rows.delete(id);this.balances.delete(id);this.units.delete(id)}
  }
  this.publish()
 }
 // Rows another tab wrote change the table's size without passing through the hooks.
 async catchUp(){if(await this.db.movements.count()!==this.total)await this.load()}
 start(){const stop=touched(this.db.movements,(_,m)=>m.stockId,ids=>this.run(()=>this.refresh(ids)));this.run(()=>this.load());return stop}
}
// The newest `size` orders, newest first (ties by id, as the index reads them backwards).
export class Recent extends Serial{
 rows:Order[]=[]
 constructor(private db:MejaDB,private emit:(rows:Order[])=>void,private size=500){super()}
 async load(){this.rows=await this.db.orders.orderBy('createdAt').reverse().limit(this.size).toArray();this.emit(this.rows)}
 async refresh(ids:Set<string>){
  const list=[...ids]
  if(list.length>50)return this.load()
  const got=await this.db.orders.bulkGet(list),have=new Set(this.rows.map(o=>o.id))
  // An order that left the window by being deleted lets an older one in: only a read can say which.
  if(list.some((id,i)=>!got[i]&&have.has(id)))return this.load()
  const by=new Map(this.rows.map(o=>[o.id,o]));for(const o of got)if(o)by.set(o.id,o)
  this.rows=[...by.values()].sort((a,b)=>a.createdAt<b.createdAt?1:a.createdAt>b.createdAt?-1:a.id<b.id?1:-1).slice(0,this.size);this.emit(this.rows)
 }
 start(){const stop=touched(this.db.orders,pk=>pk,ids=>this.run(()=>this.refresh(ids)));this.run(()=>this.load());return stop}
}
