import Dexie, { type Table } from 'dexie'
import type { CashMovement,Draft,Identity,MenuItem,Movement,Operation,Order,PrintAttempt,Settings,Shift,StockItem } from '../domain/types'
export class MejaDB extends Dexie {
 menu!:Table<MenuItem,string>; stock!:Table<StockItem,string>; settings!:Table<Settings,string>; orders!:Table<Order,string>; shifts!:Table<Shift,string>; movements!:Table<Movement,string>; cash!:Table<CashMovement,string>; outbox!:Table<Operation,string>; drafts!:Table<Draft,string>; prints!:Table<PrintAttempt,string>; meta!:Table<{id:string;value:string},string>
 constructor(name:string){super(name);this.version(1).stores({menu:'id,category',stock:'id',settings:'id',orders:'id,status,shiftId,createdAt',shifts:'id,status',movements:'id,stockId,recordId',cash:'id,shiftId',outbox:'id,state,occurredAt',drafts:'id',prints:'id,orderId',meta:'id'});this.version(2).stores({outbox:'id,state,occurredAt,[state+nextAttempt]'}).upgrade(tx=>tx.table('outbox').toCollection().modify(op=>{op.nextAttempt??=0}))}
}
export const databaseFor=(identity:Identity)=>new MejaDB(`meja-${identity.demo?'demo':'live'}-${identity.restaurantId}-${identity.id}-${identity.deviceId}`)
export const uid=()=>crypto.randomUUID()
export async function exportData(db:MejaDB,recovery=false) {
 const tables=recovery?['outbox','orders','shifts','movements','cash']:['menu','stock','settings','orders','shifts','movements','cash','outbox','drafts','prints']
 const data:Record<string,unknown>={format:'meja-business-export',version:1,scope:recovery?'unsynchronized-recovery':'locally-available-only',exportedAt:new Date().toISOString()}
 for(const table of tables)data[table]=await db.table(table).toArray()
 return data
}
export function download(name:string,data:string,type='application/json'){const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
export function csv(rows:(string|number)[][]){return '\uFEFF'+rows.map(r=>r.map(v=>'"'+String(v).replace(/^[=+@\-]/,"'$&").replaceAll('"','""')+'"').join(',')).join('\r\n')}
