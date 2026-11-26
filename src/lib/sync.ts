import type { CashMovement,CountSession,Identity,MenuItem,Movement,OpKind,Operation,Order,Outlet,PurchaseOrder,Role,SalesOrder,Settings,Shift,StockItem,Supplier,Transfer } from '../domain/types'
import { touchedBy, type MejaDB } from './db'
import { supabase } from './supabase'
export type Transport=(op:Operation)=>Promise<{receivedAt:string}>
export interface PullResult { now:string; device?:{mode:string|null;enrolled:boolean;primary:boolean}; member?:{role:Role;active:boolean}; orders:Order[]; shifts:Shift[]; cash:CashMovement[]; movements:Movement[]; counts:CountSession[]; purchaseOrders?:PurchaseOrder[]; suppliers?:Supplier[]; salesOrders?:SalesOrder[]; catalog?:{menu:MenuItem[];stock:StockItem[]}; settings?:Settings }
// refresh: send the catalog and settings whatever the cursor (after a skipped copy, below).
export type Puller=(since:string,deviceId:string,refresh?:boolean)=>Promise<PullResult>
// What the bootstrap RPC answers at sign-in; Identity is read from it in Login.tsx.
export interface Bootstrap { now?:string; device?:PullResult['device']; settings:Settings; menu:MenuItem[]; stock:StockItem[]; orders:Order[]; shifts:Shift[]; cash:CashMovement[]; movements:Movement[]; counts?:CountSession[]; purchaseOrders?:PurchaseOrder[]; suppliers?:Supplier[]; salesOrders?:SalesOrder[]; outletData?:{outlets:Outlet[];transfers:Transfer[]}|null; costs?:Record<string,number> }
// Keeps the server's bootstrap on this device: at sign-in (Login.tsx) and when a signed-in device lost its database
// (pull, below). The server is authoritative for what it sends whole: the catalog, the stock history (the movements of
// the last 8 days and a baseline per item for older ones) and the catering orders, which only owner, manager and admin
// receive (SEC-1): any other role's copy goes.
// The device clock is not trusted (SYNC-02, AUTH-09, CT-10, TILL-10): meta 'clockOffset' is how many milliseconds the
// server is ahead of this device (negative: behind), learned from the 'now' of bootstrap and pull and, refining it, from a
// receipt. Operations are stamped with Date.now()+offset (Commands.run); the till warns when |offset| passes SKEW_MS.
export const SKEW_MS=60000
// sentAt: when the request left, so the answer is taken to be from the middle of the round trip.
export const offsetFrom=(server:string|undefined,sentAt=Date.now())=>{const t=Date.parse(server??'');return Number.isFinite(t)?Math.round(t-(sentAt+Date.now())/2):undefined}
export const clockOffset=async(db:MejaDB)=>Number((await db.meta.get('clockOffset'))?.value)||0
// A receipt of an operation the server already had comes back with the time of its first receipt, so it only refines.
async function learnReceipt(db:MejaDB,receivedAt:string,sentAt:number){const off=offsetFrom(receivedAt,sentAt);if(off!==undefined&&Math.abs(off-await clockOffset(db))<5000)await db.meta.put({id:'clockOffset',value:String(off)})}
// Operations go out in the order they were made (SYNC-04): by seq, which Commands.run counts up and no clock can reorder.
// What the old client queued has none: it keeps sorting by occurredAt, ahead of anything that has one.
export const byOrder=(a:Operation,b:Operation)=>a.seq!==undefined&&b.seq!==undefined?a.seq-b.seq:a.seq!==undefined?1:b.seq!==undefined?-1:a.occurredAt.localeCompare(b.occurredAt)||a.id.localeCompare(b.id)
export async function store(db:MejaDB,boot:Bootstrap){
 await db.transaction('rw',db.tables,async()=>{await db.settings.put(boot.settings);await db.menu.clear();await db.menu.bulkPut(boot.menu);await db.stock.clear();await db.stock.bulkPut(boot.stock);await db.orders.bulkPut(boot.orders);await db.shifts.bulkPut(boot.shifts);await db.cash.bulkPut(boot.cash);await db.movements.clear();await db.movements.bulkPut(boot.movements);await db.counts.bulkPut(boot.counts??[]);await db.purchaseOrders.bulkPut(boot.purchaseOrders??[]);await db.suppliers.bulkPut(boot.suppliers??[]);await db.salesOrders.clear();await db.salesOrders.bulkPut(boot.salesOrders??[]);await db.transfers.bulkPut(boot.outletData?.transfers??[]);await db.meta.put({id:'outlets',value:JSON.stringify(boot.outletData?.outlets??[])});await db.meta.put({id:'costs',value:JSON.stringify(boot.costs??{})});await db.meta.put({id:'pullCursor',value:boot.now??new Date().toISOString()});await db.meta.put({id:'clockOffset',value:String(offsetFrom(boot.now)??0)});await db.meta.put({id:'device',value:JSON.stringify(boot.device??{})});await db.meta.put({id:'initialized',value:'yes'})})
}
// SYNC-03, AUTH-09: PostgREST answers 401 'JWT expired' when the server's clock says the token ran out, and auth-js,
// which only reads the device clock, may never refresh it (a clock that runs behind). Refresh the session once, retry once.
const jwtExpired=(e:{code?:string;message?:string}|null|undefined)=>Boolean(e&&(e.code==='PGRST303'||/jwt expired/i.test(e.message??'')))
export async function refreshing<T extends {error:{code?:string;message?:string}|null}>(call:()=>PromiseLike<T>):Promise<T>{
 const first=await call()
 if(!jwtExpired(first.error)||!supabase)return first
 const {error}=await supabase.auth.refreshSession().catch(e=>({error:e as Error}))
 return error?first:call()
}
export const SESSION_GONE='Sesi masuk berakhir. Masuk lagi dengan PIN atau kata sandi agar antrean terkirim.'
// Whose session this device holds. 'gone': none is stored, or another account's, and only signing in again brings it
// back; 'wait': it expired and could not be refreshed yet (offline), which clears by itself.
export async function sessionState(userId:string):Promise<'ok'|'wait'|'gone'>{if(!supabase)return 'gone';const {data:{session},error}=await supabase.auth.getSession();return session?.user.id===userId?'ok':session||!error?'gone':'wait'}
// The server sees whoever holds that session, or anon without one, and answers 42501 to another person's operation:
// no verdict on the operation, so it stays pending (with back-off), never rejected, until the session is this person's.
async function signedIn(userId:string){const s=await sessionState(userId);if(s==='ok')return;const e=new Error(s==='gone'?SESSION_GONE:'Sesi masuk belum diperbarui; dicoba lagi otomatis');e.name='Network';throw e}
// Which refusals are final (Rejected: the server says the same to every retry, so the operation waits to be discarded or
// fixed) and which are not (Network: it stays pending and goes out again, with back-off). By SQLSTATE class: P0001 (an
// exception the SQL raised on purpose), class 22 (data exception: a NUL character, a number out of range, a bad date),
// class 23 (integrity: not null, foreign key, unique, check) and 42501 (not allowed) are final; so is HTTP 413 (too large for
// the gateway). Everything else is the network or the server being unwell (08, 40001, 40P01, 53, 57, PGRST, 5xx) or a server
// not yet updated (42883 no such function), and waits.
export const isFinal=(code:string|undefined,status?:number)=>status===413||code==='P0001'||code==='42501'||/^2[23]/.test(code??'')
export const serverTransport:Transport=async op=>{if(!supabase)throw new Error('Supabase belum dikonfigurasi');await signedIn(op.actor);const {data,error,status}=await refreshing(()=>supabase!.rpc('apply_operation',{operation:op}));if(error){if(error.code==='42501')await signedIn(op.actor);const e=new Error(error.message||'Operasi terlalu besar');e.name=isFinal(error.code,status)?'Rejected':'Network';throw e}return {receivedAt:data.receivedAt}}
// The same person signs in again on this device: identity, local data and queue stay, only the session comes back, and
// what waited for it goes out on the next sync instead of after its back-off. The login is the one the team list keeps.
export async function signInAgain(db:MejaDB,user:Identity,login:string|undefined,secret:string){if(!supabase)return false;const email=login||(await supabase.auth.getSession()).data.session?.user.email;if(!email)return false;const {data,error}=await supabase.auth.signInWithPassword({email,password:secret});if(error?.name==='AuthRetryableFetchError')throw error;if(error||data.user?.id!==user.id)return false;await db.outbox.where('state').equals('pending').modify({nextAttempt:0});return true}
export const serverPull:Puller=async(since,deviceId,refresh)=>{if(!supabase)throw new Error('Supabase belum dikonfigurasi');const {data,error}=await refreshing(()=>supabase!.rpc('pull',{since,device_id:deviceId,...(refresh&&{refresh:true})}));if(error)throw error;return data as unknown as PullResult}
// apply_operation serializes writes per restaurant on a row lock, so a write can commit after a pull
// that started later: ask again from a little before the last cursor. Pulled rows upsert by id.
export const PULL_OVERLAP=10000
// A pulled catalog or settings is skipped while one of these waits in the outbox (the device's own edit would be undone,
// then refused as stale). meta 'held' remembers that one waited, and the first pull after they are gone asks for both
// again (F1): one that was discarded leaves its edit on the device, and the server may have nothing newer to send.
const HOLDS:Record<OpKind,'catalog'|'settings'|undefined>={'catalog.publish':'catalog','catalog.remove':'catalog','settings.update':'settings'} as Record<OpKind,'catalog'|'settings'|undefined>
// AUTH-05, STN-05: what a pull says about this device and its person, against the identity cached at sign-in. Anything that
// differs is kept in meta 'stale' ({identity: the fields to take over, note: what to tell the person}) and the app acts on it
// (context.tsx) before more is sold; a device that never was paired is not told off for being unenrolled. What is queued stays.
export function movedBy(device:PullResult['device'],member:{role?:Role;active:boolean}|undefined,user:Pick<Identity,'primary'|'mode'|'role'>){
 const identity:Partial<Identity>={},notes:string[]=[],primary=Boolean(user.primary),mode=user.mode??null
 if(device){
  if(!device.enrolled){if(primary||mode){identity.primary=false;identity.mode=null;notes.push('Perangkat ini sudah dicabut dari restoran, jadi penjualan dihentikan. Yang belum terkirim tetap tersimpan.')}}
  else if(device.primary!==primary||(device.mode??null)!==mode){identity.primary=device.primary;identity.mode=device.mode as Identity['mode'];notes.push(primary&&!device.primary?'Kasir utama dipindahkan ke perangkat lain, jadi penjualan di sini dihentikan. Yang belum terkirim tetap tersimpan.':'Pasangan perangkat ini diubah oleh pemilik.')}
 }
 if(member){
  if(!member.active){identity.primary=false;identity.mode=null;notes.push('Akun ini dinonaktifkan, jadi penjualan dihentikan. Yang belum terkirim tetap tersimpan.')}
  else if(member.role&&member.role!==user.role){identity.role=member.role;notes.push(`Peran Anda diubah menjadi ${member.role}.`)}
 }
 return notes.length?JSON.stringify({identity,note:notes.join(' ')}):undefined
}
let persistAsked=false
export async function pull(db:MejaDB,user:Identity,puller:Puller){
 // SYNC-09: the till and a station ask the browser to keep their database out of best-effort eviction, once per page load.
 if(!persistAsked&&(user.primary||user.mode==='pos'||user.mode==='station')){persistAsked=true;try{void navigator.storage?.persist?.().catch(()=>{/* not offered */})}catch{/* no storage manager */}}
 const cursor=(await db.meta.get('pullCursor'))?.value
 if(!cursor){
  // SYNC-09: a signed-in device without a cursor lost its database (the browser evicted it). With nothing queued, load
  // everything again as sign-in does, not from "now" with an empty menu. With a queue (an installation upgraded in
  // place) start from now and pull from the next tick on.
  if(supabase&&!await db.outbox.where('state').anyOf('pending','rejected').count()){const {data,error}=await supabase.rpc('bootstrap',{device_id:user.deviceId});if(error)throw error;await store(db,data as Bootstrap);return}
  await db.meta.put({id:'pullCursor',value:new Date().toISOString()});return}
 const held=(await db.meta.get('held'))!==undefined&&!(await db.outbox.where('state').anyOf('pending','rejected').toArray()).some(op=>HOLDS[op.kind])
 let r:PullResult;const sentAt=Date.now()
 try{r=await puller(new Date(Date.parse(cursor)-PULL_OVERLAP).toISOString(),user.deviceId,held||undefined)}
 catch(e){if((e as {code?:string}).code==='42501'&&/membership/.test((e as Error).message??'')){await db.meta.put({id:'member',value:JSON.stringify({active:false})});await db.meta.put({id:'stale',value:movedBy(undefined,{active:false},user)!})};throw e}
 await db.transaction('rw',[db.orders,db.shifts,db.cash,db.movements,db.counts,db.purchaseOrders,db.suppliers,db.salesOrders,db.menu,db.stock,db.settings,db.meta,db.outbox],async()=>{
  // Anything this device still has to push wins over the server's older copy of the same record.
  const pending=await db.outbox.where('state').anyOf('pending','rejected').toArray()
  const busy=new Set(pending.flatMap(op=>[op.payload.id,(op.payload.order as {id?:string}|undefined)?.id,(op.payload.supplier as {id?:string}|undefined)?.id].filter((x):x is string=>typeof x==='string')))
  const free=<T extends {id:string}>(rows:T[]|undefined)=>(rows??[]).filter(x=>!busy.has(x.id))
  await db.orders.bulkPut(free(r.orders));await db.shifts.bulkPut(free(r.shifts));await db.counts.bulkPut(free(r.counts))
  await db.purchaseOrders.bulkPut(free(r.purchaseOrders));await db.suppliers.bulkPut(free(r.suppliers));await db.salesOrders.bulkPut(free(r.salesOrders))
  await db.cash.bulkPut(r.cash);await db.movements.bulkPut(r.movements)
  const holding=new Set(pending.map(op=>HOLDS[op.kind]).filter(Boolean))
  if(r.catalog&&!holding.has('catalog')){await db.menu.clear();await db.menu.bulkPut(r.catalog.menu);await db.stock.clear();await db.stock.bulkPut(r.catalog.stock)}
  if(r.settings&&!holding.has('settings'))await db.settings.put(r.settings)
  // Held whenever such an operation waits, even when no catalog came: a discarded one leaves its edit on the device.
  if(holding.size)await db.meta.put({id:'held',value:'1'});else if(held)await db.meta.delete('held')
  await db.meta.put({id:'pullCursor',value:r.now});{const off=offsetFrom(r.now,sentAt);if(off!==undefined)await db.meta.put({id:'clockOffset',value:String(off)})};if(r.device){const v=JSON.stringify(r.device);if((await db.meta.get('device'))?.value!==v)await db.meta.put({id:'device',value:v})};if(r.member)await db.meta.put({id:'member',value:JSON.stringify(r.member)});{const moved=movedBy(r.device,r.member,user);if(moved!==(await db.meta.get('stale'))?.value){if(moved)await db.meta.put({id:'stale',value:moved});else await db.meta.delete('stale')}}
 })
}
// SYNC-10: releasing a refused operation puts the device back in line with the server. The operation, and the later ones
// made on what it refused (the same order; after a refused shift.open, everything of that shift), leave the queue (the
// recovery file holds them); the orders and shifts they touched are dropped from the device, their movements too, and the
// pull cursor goes back to before the earliest of them so the server's copy comes back on the next pull. A refused
// payment thus leaves the order open and payable again; an order the server never had is gone, with its cart.
export async function discardRejected(db:MejaDB,id:string){
 const op=await db.outbox.get(id);if(!op||op.state!=='rejected')return {dropped:0,paid:false,order:false}
 const mine=touchedBy([op]),shiftDown=op.kind==='shift.open'
 const queue=(await db.outbox.where('state').anyOf('pending','rejected').toArray()).filter(o=>o.id!==id&&byOrder(o,op)>0)
 const later=queue.filter(o=>shiftDown?/^(shift|order|payment|refund)\./.test(o.kind):[...touchedBy([o]).orders].some(x=>mine.orders.has(x)))
 const gone=[op,...later],orders=new Set([...gone.flatMap(o=>[...touchedBy([o]).orders])]),shifts=new Set(shiftDown?mine.shifts:[])
 if(/^shift\.(cash|close)$/.test(op.kind)){const last=(await db.shifts.toCollection().sortBy('openedAt')).pop();if(last)shifts.add(last.id)}
 const rows=[...(await db.orders.bulkGet([...orders])).filter(Boolean).map(o=>o!.createdAt),...(await db.shifts.bulkGet([...shifts])).filter(Boolean).map(x=>x!.openedAt)].sort()
 const ofOp=(x:string)=>gone.some(o=>x===o.id||x.startsWith(o.id+'-'))
 const fresh=op.kind==='order.save'&&op.payload.expectedRevision===0
 await db.transaction('rw',[db.outbox,db.orders,db.shifts,db.movements,db.cash,db.drafts,db.meta],async()=>{
  await db.outbox.bulkDelete(gone.map(o=>o.id));await db.orders.bulkDelete([...orders]);await db.shifts.bulkDelete([...shifts])
  await db.movements.filter(m=>ofOp(m.id)).delete();await db.cash.filter(m=>ofOp(m.id)).delete()
  const d=await db.drafts.get('current');if(fresh&&d?.orderId&&orders.has(d.orderId))await db.drafts.delete('current')
  const cursor=(await db.meta.get('pullCursor'))?.value,back=rows[0]?new Date(Date.parse(rows[0])-PULL_OVERLAP).toISOString():undefined
  if(cursor&&back&&back<cursor)await db.meta.put({id:'pullCursor',value:back})})
 return {dropped:gone.length,paid:gone.some(o=>o.kind==='payment.record'),order:orders.size>0}
}
// The queue drains as fast as the server accepts (PERF-8): every pending operation goes out in one round, then the pull, and
// another round follows while something is left (added meanwhile, or a back-off that the pull just proved needless, SYNC-14).
// A round that failed ends the sync: the next tick tries again after the back-off.
export async function synchronize(db:MejaDB,user:Identity,transport:Transport=serverTransport,puller:Puller=serverPull){
 if(user.demo)return
 if(!navigator.locks)throw new Error('Browser perlu mendukung Web Locks untuk kasir utama')
 return navigator.locks.request(`meja-sync-${user.restaurantId}-${user.deviceId}`,{ifAvailable:true},async lock=>{
 if(!lock)return
 let pulled=false
 for(let round=0;round<20;round++){
 let failed=false
 const ops=(await db.outbox.where('state').equals('pending').toArray()).sort(byOrder)
 for(const op of ops){if(op.actor!==user.id)throw new Error('Operasi milik akun lain dikunci');if(op.nextAttempt>Date.now())break
 // Never skip a rejected dependency or reorder later operations.
 if(await db.outbox.where('state').equals('rejected').count()){failed=true;break}
 // A time more than the server's 2 minutes ahead (queued by a till whose clock ran fast) is refused for good: send it as now.
 const ahead=Date.now()+await clockOffset(db)+110000;if(Date.parse(op.occurredAt)>ahead){op.occurredAt=new Date(ahead-110000).toISOString();await db.outbox.update(op.id,{occurredAt:op.occurredAt})}
 const sentAt=Date.now()
 try{const receipt=await transport(op);await db.transaction('rw',db.outbox,db.meta,async()=>{await db.outbox.update(op.id,{state:'synced',receivedAt:receipt.receivedAt,error:undefined});await db.meta.put({id:'lastSync',value:receipt.receivedAt})});await learnReceipt(db,receipt.receivedAt,sentAt).catch(()=>{/* only a refinement */})}
 catch(error){const e=error instanceof Error?error:new Error(String(error));const attempts=op.attempts+1
 await db.outbox.update(op.id,{attempts,state:e.name==='Rejected'?'rejected':'pending',error:e.message,nextAttempt:Date.now()+Math.min(300000,1000*2**Math.min(attempts,8))*(0.75+Math.random()*0.5)});failed=true;break}
 }
 // A failed pull (offline, old server) waits for the next tick; it is noted, never thrown at the operator.
 pulled=false
 try{await pull(db,user,puller);pulled=true;await db.meta.delete('pullError')}catch(e){await db.meta.put({id:'pullError',value:`${new Date().toISOString()} ${(e as {message?:string})?.message??String(e)}`})}
 if(failed||!pulled)break
 // The server answered: a back-off kept from an outage (up to 5 minutes) is over. Only when this round sent without failing,
 // so an operation the server keeps failing is not retried in a tight loop.
 await db.outbox.where('state').equals('pending').filter(op=>op.nextAttempt>0).modify({nextAttempt:0})
 if(!await db.outbox.where('state').equals('pending').count())break
 }
 if(puller===serverPull&&pulled)await refreshLogo(db,user).catch(()=>{/* the logo waits for the next tick */})
 })
}
// The store's logo lives on the restaurant row, not in the pull: ask when it last changed (a few bytes), download it
// only when that differs from the copy on this device. The copy keeps the receipt and sidebar right offline.
async function refreshLogo(db:MejaDB,user:Identity){
 if(!supabase)return
 const {data,error}=await supabase.from('restaurants').select('logo_at').eq('id',user.restaurantId).retry(false).maybeSingle();if(error||!data)return
 const at=(data as {logo_at:string|null}).logo_at??'';if(at===((await db.meta.get('logoAt'))?.value??''))return
 const {data:row,error:e}=await supabase.from('restaurants').select('logo').eq('id',user.restaurantId).retry(false).maybeSingle();if(e||!row)return
 const logo=(row as {logo:string|null}).logo
 await db.transaction('rw',db.meta,async()=>{if(logo)await db.meta.put({id:'logo',value:logo});else await db.meta.delete('logo');await db.meta.put({id:'logoAt',value:at})})
}
