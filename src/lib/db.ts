import Dexie, { type Table } from 'dexie'
import type { CashMovement,Draft,Identity,MenuItem,Movement,Operation,Order,PrintAttempt,PurchaseOrder,SalesOrder,Settings,Shift,StockItem,Supplier,Transfer } from '../domain/types'
export class MejaDB extends Dexie {
 menu!:Table<MenuItem,string>; stock!:Table<StockItem,string>; settings!:Table<Settings,string>; orders!:Table<Order,string>; shifts!:Table<Shift,string>; movements!:Table<Movement,string>; cash!:Table<CashMovement,string>; outbox!:Table<Operation,string>; drafts!:Table<Draft,string>; prints!:Table<PrintAttempt,string>; meta!:Table<{id:string;value:string},string>; purchaseOrders!:Table<PurchaseOrder,string>; suppliers!:Table<Supplier,string>; salesOrders!:Table<SalesOrder,string>; transfers!:Table<Transfer,string>
 constructor(name:string){super(name);this.version(1).stores({menu:'id,category',stock:'id',settings:'id',orders:'id,status,shiftId,createdAt',shifts:'id,status',movements:'id,stockId,recordId',cash:'id,shiftId',outbox:'id,state,occurredAt',drafts:'id',prints:'id,orderId',meta:'id'});this.version(2).stores({outbox:'id,state,occurredAt,[state+nextAttempt]'}).upgrade(tx=>tx.table('outbox').toCollection().modify(op=>{op.nextAttempt??=0}));this.version(3).stores({purchaseOrders:'id,status,createdAt'});this.version(4).stores({suppliers:'id',salesOrders:'id,status,deliverAt',transfers:'id,status,sentAt'})}
}
export const databaseFor=(identity:Identity)=>new MejaDB(`meja-${identity.demo?'demo':'live'}-${identity.restaurantId}-${identity.id}-${identity.deviceId}`)
// randomUUID exists only on HTTPS and localhost: a phone opening the dev server at http://192.168.x.x
// got a blank page. getRandomValues works on any origin and yields the same v4 format.
export const uid=():string=>crypto.randomUUID?.()??'10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>(+c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>+c/4).toString(16))
export async function exportData(db:MejaDB,recovery=false) {
 const tables=recovery?['outbox','orders','shifts','movements','cash']:['menu','stock','settings','orders','shifts','movements','cash','outbox','drafts','prints','purchaseOrders','suppliers','salesOrders','transfers']
 const data:Record<string,unknown>={format:'meja-business-export',version:1,scope:recovery?'unsynchronized-recovery':'locally-available-only',exportedAt:new Date().toISOString()}
 for(const table of tables)data[table]=await db.table(table).toArray()
 return data
}
export function download(name:string,data:string,type='application/json'){const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
export function csv(rows:(string|number)[][]){return '\uFEFF'+rows.map(r=>r.map(v=>'"'+String(v).replace(/^[=+@\-]/,"'$&").replaceAll('"','""')+'"').join(',')).join('\r\n')}
