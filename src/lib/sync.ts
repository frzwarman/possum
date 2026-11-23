import type { CashMovement,CountSession,Identity,MenuItem,Movement,Operation,Order,Settings,Shift,StockItem } from '../domain/types'
import type { MejaDB } from './db'
import { supabase } from './supabase'
export type Transport=(op:Operation)=>Promise<{receivedAt:string}>
export interface PullResult { now:string; device?:{mode:string|null;enrolled:boolean;primary:boolean}; orders:Order[]; shifts:Shift[]; cash:CashMovement[]; movements:Movement[]; counts:CountSession[]; catalog?:{menu:MenuItem[];stock:StockItem[]}; settings?:Settings }
export type Puller=(since:string,deviceId:string)=>Promise<PullResult>
export const SESSION_GONE='Sesi masuk berakhir. Masuk lagi dengan PIN atau kata sandi agar antrean terkirim.'
// Whose session this device holds. 'gone': none is stored, or another account's, and only signing in again brings it
// back; 'wait': it expired and could not be refreshed yet (offline), which clears by itself.
export async function sessionState(userId:string):Promise<'ok'|'wait'|'gone'>{if(!supabase)return 'gone';const {data:{session},error}=await supabase.auth.getSession();return session?.user.id===userId?'ok':session||!error?'gone':'wait'}
// The server sees whoever holds that session, or anon without one, and answers 42501 to another person's operation:
// no verdict on the operation, so it stays pending (with back-off), never rejected, until the session is this person's.
async function signedIn(userId:string){const s=await sessionState(userId);if(s==='ok')return;const e=new Error(s==='gone'?SESSION_GONE:'Sesi masuk belum diperbarui; dicoba lagi otomatis');e.name='Network';throw e}
export const serverTransport:Transport=async op=>{if(!supabase)throw new Error('Supabase belum dikonfigurasi');await signedIn(op.actor);const {data,error}=await supabase.rpc('apply_operation',{operation:op});if(error){if(error.code==='42501')await signedIn(op.actor);const e=new Error(error.message);e.name=['P0001','23514','42501','23503','23505','22P02'].includes(error.code)?'Rejected':'Network';throw e}return {receivedAt:data.receivedAt}}
// The same person signs in again on this device: identity, local data and queue stay, only the session comes back, and
// what waited for it goes out on the next sync instead of after its back-off. The login is the one the team list keeps.
export async function signInAgain(db:MejaDB,user:Identity,login:string|undefined,secret:string){if(!supabase)return false;const email=login||(await supabase.auth.getSession()).data.session?.user.email;if(!email)return false;const {data,error}=await supabase.auth.signInWithPassword({email,password:secret});if(error||data.user?.id!==user.id)return false;await db.outbox.where('state').equals('pending').modify({nextAttempt:0});return true}
export const serverPull:Puller=async(since,deviceId)=>{if(!supabase)throw new Error('Supabase belum dikonfigurasi');const {data,error}=await supabase.rpc('pull',{since,device_id:deviceId});if(error)throw error;return data as unknown as PullResult}
// apply_operation serializes writes per restaurant on a row lock, so a write can commit after a pull
// that started later: ask again from a little before the last cursor. Pulled rows upsert by id.
export const PULL_OVERLAP=10000
export async function pull(db:MejaDB,user:Identity,puller:Puller){
 const cursor=(await db.meta.get('pullCursor'))?.value
 // An installation upgraded in place has no cursor yet: start from now, pull from the next tick on.
 if(!cursor){await db.meta.put({id:'pullCursor',value:new Date().toISOString()});return}
 const r=await puller(new Date(Date.parse(cursor)-PULL_OVERLAP).toISOString(),user.deviceId)
 await db.transaction('rw',[db.orders,db.shifts,db.cash,db.movements,db.counts,db.menu,db.stock,db.settings,db.meta,db.outbox],async()=>{
  // Anything this device still has to push wins over the server's older copy of the same record.
  const pending=await db.outbox.where('state').anyOf('pending','rejected').toArray()
  const busy=new Set(pending.flatMap(op=>[op.payload.id,(op.payload.order as {id?:string}|undefined)?.id].filter((x):x is string=>typeof x==='string')))
  await db.orders.bulkPut(r.orders.filter(o=>!busy.has(o.id)));await db.shifts.bulkPut(r.shifts.filter(s=>!busy.has(s.id)))
  await db.cash.bulkPut(r.cash);await db.movements.bulkPut(r.movements);await db.counts.bulkPut(r.counts)
  if(r.catalog&&!pending.some(op=>op.kind==='catalog.publish')){await db.menu.clear();await db.menu.bulkPut(r.catalog.menu);await db.stock.bulkPut(r.catalog.stock)}
  if(r.settings&&!pending.some(op=>op.kind==='settings.update'))await db.settings.put(r.settings)
  await db.meta.put({id:'pullCursor',value:r.now});if(r.device)await db.meta.put({id:'device',value:JSON.stringify(r.device)})
 })
}
export async function synchronize(db:MejaDB,user:Identity,transport:Transport=serverTransport,puller:Puller=serverPull){
 if(user.demo)return
 if(!navigator.locks)throw new Error('Browser perlu mendukung Web Locks untuk kasir utama')
 return navigator.locks.request(`meja-sync-${user.restaurantId}-${user.deviceId}`,{ifAvailable:true},async lock=>{
 if(!lock)return
 const ops=(await db.outbox.where('state').equals('pending').sortBy('occurredAt')).slice(0,25)
 for(const op of ops){if(op.actor!==user.id)throw new Error('Operasi milik akun lain dikunci');if(op.nextAttempt>Date.now())break
 // Never skip a rejected dependency or reorder later operations.
 if(await db.outbox.where('state').equals('rejected').count())break
 try{const receipt=await transport(op);await db.transaction('rw',db.outbox,db.meta,async()=>{await db.outbox.update(op.id,{state:'synced',receivedAt:receipt.receivedAt,error:undefined});await db.meta.put({id:'lastSync',value:receipt.receivedAt})})}
 catch(error){const e=error instanceof Error?error:new Error(String(error));const attempts=op.attempts+1
 await db.outbox.update(op.id,{attempts,state:e.name==='Rejected'?'rejected':'pending',error:e.message,nextAttempt:Date.now()+Math.min(300000,1000*2**Math.min(attempts,8))*(0.75+Math.random()*0.5)});break}
 }
 // A failed pull (offline, old server) waits for the next tick; it is noted, never thrown at the operator.
 try{await pull(db,user,puller)}catch(e){await db.meta.put({id:'pullError',value:`${new Date().toISOString()} ${e instanceof Error?e.message:String(e)}`})}
 if(puller===serverPull)await refreshLogo(db,user).catch(()=>{/* the logo waits for the next tick */})
 })
}
// The store's logo lives on the restaurant row, not in the pull: ask when it last changed (a few bytes), download it
// only when that differs from the copy on this device. The copy keeps the receipt and sidebar right offline.
async function refreshLogo(db:MejaDB,user:Identity){
 if(!supabase)return
 const {data,error}=await supabase.from('restaurants').select('logo_at').eq('id',user.restaurantId).maybeSingle();if(error||!data)return
 const at=(data as {logo_at:string|null}).logo_at??'';if(at===((await db.meta.get('logoAt'))?.value??''))return
 const {data:row,error:e}=await supabase.from('restaurants').select('logo').eq('id',user.restaurantId).maybeSingle();if(e||!row)return
 const logo=(row as {logo:string|null}).logo
 await db.transaction('rw',db.meta,async()=>{if(logo)await db.meta.put({id:'logo',value:logo});else await db.meta.delete('logo');await db.meta.put({id:'logoAt',value:at})})
}
