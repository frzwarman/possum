import Dexie, { type Table } from 'dexie'
import type { CashMovement,CountSession,Draft,Identity,MenuItem,Movement,Operation,Order,PrintAttempt,PurchaseOrder,SalesOrder,Settings,Shift,StockItem,Supplier,Transfer } from '../domain/types'
export class MejaDB extends Dexie {
 menu!:Table<MenuItem,string>; stock!:Table<StockItem,string>; settings!:Table<Settings,string>; orders!:Table<Order,string>; shifts!:Table<Shift,string>; movements!:Table<Movement,string>; cash!:Table<CashMovement,string>; outbox!:Table<Operation,string>; drafts!:Table<Draft,string>; prints!:Table<PrintAttempt,string>; meta!:Table<{id:string;value:string},string>; purchaseOrders!:Table<PurchaseOrder,string>; suppliers!:Table<Supplier,string>; salesOrders!:Table<SalesOrder,string>; transfers!:Table<Transfer,string>; counts!:Table<CountSession,string>
 constructor(name:string){super(name);this.version(1).stores({menu:'id,category',stock:'id',settings:'id',orders:'id,status,shiftId,createdAt',shifts:'id,status',movements:'id,stockId,recordId',cash:'id,shiftId',outbox:'id,state,occurredAt',drafts:'id',prints:'id,orderId',meta:'id'});this.version(2).stores({outbox:'id,state,occurredAt,[state+nextAttempt]'}).upgrade(tx=>tx.table('outbox').toCollection().modify(op=>{op.nextAttempt??=0}));this.version(3).stores({purchaseOrders:'id,status,createdAt'});this.version(4).stores({suppliers:'id',salesOrders:'id,status,deliverAt',transfers:'id,status,sentAt'});this.version(5).stores({counts:'id,status,area'})}
}
export const databaseFor=(identity:Identity)=>new MejaDB(`meja-${identity.demo?'demo':'live'}-${identity.restaurantId}-${identity.id}-${identity.deviceId}`)
// randomUUID exists only on HTTPS and localhost: a phone opening the dev server at http://192.168.x.x
// got a blank page. getRandomValues works on any origin and yields the same v4 format.
export const uid=():string=>crypto.randomUUID?.()??'10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>(+c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>+c/4).toString(16))
// SEC-2: an operation's deviceId is what apply_operation trusts as "the till", and the server shows device ids to owners
// and managers only. `devices` says the person exporting may see them; for everyone else the exported copy leaves it out.
export async function exportData(db:MejaDB,recovery=false,devices=false) {
 const data:Record<string,unknown>={format:'meja-business-export',version:1,scope:recovery?'unsynchronized-recovery':'locally-available-only',exportedAt:new Date().toISOString()}
 if(recovery){
  // PERF-2: only what is not on the server yet: the pending and rejected operations and the records they touch, so the
  // file stays small on a till with months of history (synced operations are never pruned).
  const ops=await db.outbox.where('state').anyOf('pending','rejected').toArray(),touched=touchedBy(ops),ids=[...touched.orders,...touched.shifts],opIds=ops.map(o=>o.id)
  const ofOp=(id:string)=>opIds.some(o=>id===o||id.startsWith(o+'-'))
  data.outbox=ops
  data.orders=await db.orders.bulkGet([...touched.orders]).then(r=>r.filter(Boolean))
  data.shifts=await db.shifts.bulkGet([...touched.shifts]).then(r=>r.filter(Boolean))
  data.movements=await db.movements.filter(m=>ofOp(m.id)||ids.includes(m.recordId??'')).toArray()
  data.cash=await db.cash.filter(m=>ofOp(m.id)||ids.includes(m.recordId??'')).toArray()
  data.counts=await db.counts.bulkGet(ops.filter(o=>o.kind.startsWith('count.')&&typeof o.payload.id==='string').map(o=>o.payload.id as string)).then(r=>r.filter(Boolean))
 }else for(const table of ['menu','stock','settings','orders','shifts','movements','cash','outbox','drafts','prints','purchaseOrders','suppliers','salesOrders','transfers','counts'])data[table]=await db.table(table).toArray()
 if(!devices)data.outbox=(data.outbox as Operation[]).map(({deviceId:_,...op})=>op)
 return data
}
// The orders and shifts an operation names (its own id, the order it saves, the shift it opens), for the recovery file and
// for putting the device back in line with the server after a refused operation is released (discardRejected, sync.ts).
export function touchedBy(ops:Operation[]){
 const orders=new Set<string>(),shifts=new Set<string>()
 for(const op of ops){const p=op.payload,o=p.order as {id?:string;shiftId?:string}|undefined
  if(op.kind==='shift.open'&&typeof p.id==='string')shifts.add(p.id)
  else if(o?.id){orders.add(o.id);if(o.shiftId)shifts.add(o.shiftId)}
  else if(/^(order|payment|refund)\./.test(op.kind)&&typeof p.id==='string')orders.add(p.id)
  if(typeof p.shiftId==='string')shifts.add(p.shiftId)}
 return {orders,shifts}
}
// A JSON file as many small strings: one giant string of a till's whole history throws RangeError (PERF-2); a Blob takes the pieces.
export function jsonParts(data:Record<string,unknown>,chunk=500){
 const parts:string[]=['{'];let first=true
 for(const [k,v] of Object.entries(data)){parts.push((first?'':',')+JSON.stringify(k)+':');first=false
  if(!Array.isArray(v)){parts.push(JSON.stringify(v)??'null');continue}
  parts.push('[');for(let i=0;i<v.length;i+=chunk)parts.push((i?',':'')+v.slice(i,i+chunk).map(x=>JSON.stringify(x)).join(','));parts.push(']')}
 parts.push('}');return parts
}
export function download(name:string,data:BlobPart|BlobPart[],type='application/json'){const url=URL.createObjectURL(new Blob(Array.isArray(data)?data:[data],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
// Text that a spreadsheet would run as a formula (OWASP: = + - @ tab CR) gets a leading apostrophe; a number cannot be
// one, and an apostrophe would turn a negative into text that SUM skips.
export function csv(rows:(string|number)[][]){return '﻿'+rows.map(r=>r.map(v=>'"'+(typeof v==='number'?String(v):String(v).replace(/^[=+@\-\t\r]/,"'$&")).replaceAll('"','""')+'"').join(',')).join('\r\n')}
