import { databaseFor,uid } from '../../src/lib/db'
import { Commands } from '../../src/lib/commands'
import { defaultSettings,sampleMenu,stock } from '../../src/domain/sample'
import type { Draft,Identity,Line,Operation } from '../../src/domain/types'
import type { Transport } from '../../src/lib/sync'
let seq=0
// Unique restaurant/device per call so fake-indexeddb never shares a database between tests.
export function identity(over:Partial<Identity>={}):Identity{const n=++seq;return {id:`kasir-${n}`,name:'Siti',role:'manager',restaurantId:`resto-${n}-${Date.now()}`,deviceId:`dev-${n}`,primary:true,demo:false,...over}}
export async function seed(user:Identity){
 const db=databaseFor(user)
 await db.settings.put(defaultSettings);await db.menu.bulkPut(sampleMenu);await db.stock.bulkPut(stock)
 for(const item of stock)await db.movements.add({id:uid(),stockId:item.id,qty:item.unit==='g'?10_000_000:50_000,kind:'opening',reason:'Saldo awal uji',actor:user.id,at:new Date().toISOString(),recordId:'seed-opening',cost:0})
 return {db,commands:new Commands(db,user)}
}
export const line=(over:Partial<Line>={}):Line=>({id:uid(),itemId:'nasi-goreng',name:'Nasi goreng kampung',price:25000,qty:1,modifiers:[],note:'',recipe:[{stockId:'rice',qty:100000}],catalogVersion:1,prepared:false,cancelled:false,...over})
export const tea=()=>line({itemId:'es-teh',name:'Es teh manis',price:6000,recipe:[{stockId:'tea',qty:1000}]})
export const draft=(lines:Line[],over:Partial<Draft>={}):Draft=>({id:'current',revision:0,label:'Meja 1',mode:'dinein',lines,discount:0,discountReason:'',...over})
// Commands stamp occurredAt in milliseconds; a real gap keeps the outbox draining in causal order.
export const tick=()=>new Promise(r=>setTimeout(r,3))
// A fake server: records every operation it receives, then lets the test decide what goes wrong.
export function recorder(behaviour:(op:Operation,call:number)=>void=()=>{}){
 const sent:Operation[]=[]
 const transport:Transport=async op=>{sent.push({...op});behaviour(op,sent.length);return {receivedAt:new Date().toISOString()}}
 return {sent,transport}
}
export const boom=(message:string,name:string)=>{const e=new Error(message);e.name=name;return e}
export async function sale(commands:Commands,lines=[line(),tea()]){
 await commands.openShift(200000);await tick()
 const order=await commands.save(draft(lines));await tick()
 await commands.prepare(order.id);await tick()
 await commands.pay(order.id,'cash',100000,true);await tick()
 return order
}
