import { createContext,useContext,useEffect,useMemo,useRef,useState,type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Identity,MenuItem,Movement,Order,Outlet,Station } from '../domain/types'
import { databaseFor,uid,type MejaDB } from '../lib/db'
import { Commands } from '../lib/commands'
import { defaultSettings,demoOutlet,demoTransfer,sampleMenu,stock } from '../domain/sample'
import { availability } from '../domain/calculate'
import { can } from '../domain/permissions'
import { SKEW_MS,byOrder,sessionState,synchronize } from '../lib/sync'
import { supabase } from '../lib/supabase'
import { Recent,Tally } from '../lib/tally'
function useModel(base:Identity){
 // AUTH-05, STN-05: the identity cached at sign-in, with what the last pull said about this device and its person laid over it
 // (meta 'stale', written by pull). The database name does not change with it, so nothing is reloaded: the till stops selling,
 // the menu follows the new role, and what is queued stays. The merged identity is kept for the next start.
 const db=useMemo(()=>databaseFor(base),[base]);const stale=useLiveQuery(async()=>(await db.meta.get('stale'))?.value??'',[db])
 const moved=useMemo(()=>{try{return stale?JSON.parse(stale) as {identity:Partial<Identity>;note:string}:null}catch{return null}},[stale])
 const user=useMemo(()=>moved?{...base,...moved.identity}:base,[base,moved])
 useEffect(()=>{if(moved&&!base.demo)try{localStorage.setItem('meja-identity',JSON.stringify(user))}catch{/* private mode */}},[moved,base,user])
 const pullFailed=Boolean(useLiveQuery(async()=>(await db.meta.get('pullError'))?.value,[db]))
 const commands=useMemo(()=>new Commands(db,user),[db,user]);const [notice,setNotice]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [online,setOnline]=useState(navigator.onLine)
 // Which station this tablet shows is a choice made on the tablet itself.
 const [station,pickStation]=useState<Station>(()=>{try{return (localStorage.getItem('takar-station')as Station)||'kitchen'}catch{return 'kitchen'}})
 const setStation=(s:Station)=>{try{localStorage.setItem('takar-station',s)}catch{/* private mode */}pickStation(s)}
 // Ids are random UUIDs, so table order is arbitrary: list shifts and the queue by time. Every screen
 // shows only unsynced work, and synced operations pile up forever; reading them all on each write won't last.
 // `orders` is only the newest 500 (the recent list): a total never sums it (QA RPT-1). Close screens read a shift's own orders and
 // Laporan, Penjualan, Hari ini and Pesanan the range's, from features/reports/range.ts or the store.
 const menuRows=useLiveQuery(()=>db.menu.toArray(),[db]);const menu=menuRows||[];const settings=useLiveQuery(()=>db.settings.get('settings'),[db]);const [orderRows,setOrderRows]=useState<Order[]>();const orders=useMemo(()=>orderRows||[],[orderRows]);const shiftRows=useLiveQuery(()=>db.shifts.toCollection().sortBy('openedAt'),[db]);const shifts=shiftRows||[];const [ledger,setLedger]=useState<{balances:Map<string,number>;units:Map<string,number>}>()
 // QA PERF-5: the newest orders and the stock figures follow the writes (lib/tally.ts); no screen holds every movement here (useMovements).
 useEffect(()=>{setOrderRows(undefined);setLedger(undefined);const t=new Tally(db,setLedger),r=new Recent(db,setOrderRows),stops=[t.start(),r.start()];const shown=()=>{if(document.visibilityState==='visible'){r.run(()=>r.load());t.run(()=>t.catchUp())}};document.addEventListener('visibilitychange',shown);return()=>{stops.forEach(f=>f());document.removeEventListener('visibilitychange',shown)}},[db]);const stockRows=useLiveQuery(()=>db.stock.toArray(),[db]);const stockItems=stockRows||[];const cash=useLiveQuery(()=>db.cash.toArray(),[db])||[];const outbox=useLiveQuery(()=>db.outbox.where('state').anyOf('pending','rejected').toArray().then(a=>a.sort(byOrder)),[db])||[];const clockMs=useLiveQuery(async()=>Number((await db.meta.get('clockOffset'))?.value)||0,[db])??0;const skew=Math.abs(clockMs)>SKEW_MS?clockMs:0;const lastSync=useLiveQuery(()=>db.meta.get('lastSync'),[db]);const purchaseOrders=useLiveQuery(()=>db.purchaseOrders.orderBy('createdAt').reverse().toArray(),[db])||[];const suppliers=useLiveQuery(()=>db.suppliers.toArray(),[db])||[];const salesOrders=useLiveQuery(()=>db.salesOrders.orderBy('deliverAt').reverse().toArray(),[db])||[];const transfers=useLiveQuery(()=>db.transfers.orderBy('sentAt').reverse().toArray(),[db])||[];const counts=useLiveQuery(()=>db.counts.toArray(),[db])||[];const outletRow=useLiveQuery(()=>db.meta.get('outlets'),[db]);const outlets:Outlet[]=JSON.parse(outletRow?.value||'[]');const costRow=useLiveQuery(()=>db.meta.get('costs'),[db]);const costs=useMemo(()=>{const m=new Map<string,number>(Object.entries(JSON.parse(costRow?.value||'{}')));for(const [id,u] of ledger?.units??[])m.set(id,u);return m},[ledger,costRow]);const shift=shifts.find(s=>s.status==='open')
 const deviceRow=useLiveQuery(async()=>(await db.meta.get('device'))?.value??'',[db]);const logo=useLiveQuery(()=>db.meta.get('logo'),[db])?.value;const device=useMemo(()=>deviceRow?JSON.parse(deviceRow) as {mode:string|null;enrolled:boolean;primary:boolean}:null,[deviceRow])
 // Stock on hand = sum of movements; "can make" per menu item follows from it (POS-7, TDY-3).
 const balances=useMemo(()=>ledger?.balances??new Map<string,number>(),[ledger])
 const balance=(id:string)=>balances.get(id)||0
 const canMake=(item:MenuItem)=>availability(item,balance,settings?.lowAt??5)
 // A session that is really gone (ended elsewhere, revoked) holds this person's work pending until they sign in again on
 // this device, from the lock screen or Lainnya; one that only waits for the network clears by itself.
 const [gone,setGone]=useState(false)
 // A refusal comes after the tap (the action never waits for the network), so it is told here, once per operation.
 const told=useRef(new Set<string>())
 async function sync(){try{await synchronize(db,user)}catch(e){setError(e instanceof Error?e.message:'Sinkronisasi gagal')}if(!user.demo&&supabase){setGone(await sessionState(user.id).then(s=>s==='gone',()=>false));const refused=await db.outbox.where('state').equals('rejected').first().catch(()=>undefined);if(refused&&!told.current.has(refused.id)){told.current.add(refused.id);setError(`Server menolak operasi: ${refused.error??refused.kind}. Buka Lainnya → Sinkron & backup.`)}}}
 useEffect(()=>{let active=true;void(async()=>{if(user.demo&&!await db.meta.get('initialized')){await db.transaction('rw',db.tables,async()=>{await db.settings.put(defaultSettings);await db.menu.bulkPut(sampleMenu);await db.stock.bulkPut(stock);for(const item of stock)await db.movements.add({id:uid(),stockId:item.id,qty:item.unit==='pcs'?50000:10000000,kind:'opening',reason:'Saldo awal contoh demo',actor:user.id,at:new Date().toISOString(),recordId:'demo-opening',cost:0});await db.meta.put({id:'initialized',value:'yes'})})}
 // Demo installs made before the sample pictures existed get them filled in; anything the demo user set stays.
 if(user.demo)await db.transaction('rw',db.menu,db.stock,async()=>{for(const m of sampleMenu)if(m.photo)await db.menu.where('id').equals(m.id).modify(x=>{if(!x.photo)x.photo=m.photo});for(const s of stock)if(s.photo)await db.stock.where('id').equals(s.id).modify(x=>{if(!x.photo)x.photo=s.photo})})
 if(user.demo&&!await db.meta.get('outlets')){const here=(await db.settings.get('settings'))?.name||'';await db.transaction('rw',db.meta,db.transfers,async()=>{await db.meta.put({id:'outlets',value:JSON.stringify([demoOutlet])});await db.transfers.put(demoTransfer(user.restaurantId,here,new Date().toISOString()))})}if(active)await sync()})().catch(e=>setError(String(e)));const foreground=()=>{if(document.visibilityState==='visible')void sync()};const network=()=>{setOnline(navigator.onLine);if(navigator.onLine)void sync()};window.addEventListener('online',network);window.addEventListener('offline',network);document.addEventListener('visibilitychange',foreground)
 // A station tablet polls fast so a ticket shows within seconds; the till a little slower; a laptop idles.
 const timer=setInterval(()=>{if(document.visibilityState==='visible')void sync()},user.mode==='station'?5000:user.primary?10000:30000);return()=>{active=false;clearInterval(timer);window.removeEventListener('online',network);window.removeEventListener('offline',network);document.removeEventListener('visibilitychange',foreground)}},[db,user])
 async function act<T>(action:()=>Promise<T>,message?:string):Promise<T|undefined>{if(busy)return;setBusy(true);setError('');try{const value=await action();if(!user.demo)void sync();if(message)setNotice(message);return value}catch(e){setError(e instanceof Error?e.message:'Tindakan gagal. Data belum tersimpan.');return undefined}finally{setBusy(false)}}
 useEffect(()=>{if(notice){const t=setTimeout(()=>setNotice(''),4500);return()=>clearTimeout(t)}},[notice])
 // D6: an error toast sits over the buttons at the bottom; it closes itself so the next tap lands on the button.
 useEffect(()=>{if(error){const t=setTimeout(()=>setError(''),6000);return()=>clearTimeout(t)}},[error])
 return {user,db,commands,movedNote:moved?.note??'',pullFailed,logo,menu,hydrating:[menuRows,orderRows,shiftRows,ledger,stockRows].includes(undefined),settings,orders,purchaseOrders,suppliers,salesOrders,transfers,counts,outlets,costs,shifts,shift,stockItems,cash,outbox,lastSync:lastSync?.value,device,balances,balance,canMake,station,setStation,notice,error,busy,online,gone,act,sync,skew,setNotice,setError,
  // manager = may approve (owner, manager); office = may open the back office (owner, manager, admin, chef).
  manager:can(user.role,'approve'),office:can(user.role,'backoffice')}
}
const Context=createContext<ReturnType<typeof useModel>|null>(null)
export function AppProvider({user,children}:{user:Identity;children:ReactNode}){const value=useModel(user);return <Context.Provider value={value}>{children}</Context.Provider>}
// Every movement on this device, for the screens that read the history (Hari ini, Stok, Laporan, ...): only they pay for it.
export function useMovements(){const {db}=useApp();return useLiveQuery(()=>db.movements.toArray(),[db])??NONE}
const NONE:Movement[]=[]
export function useApp(){const ctx=useContext(Context);if(!ctx)throw new Error('AppProvider required');return ctx}
// What signing out on this device would strand: this person's open shift (nobody else can sell until it closes),
// a new order still in the cart, and operations only this person's session can send: unsent ones wait for the network,
// rejected ones (the server said no) only leave through 'Buang operasi ini' in Sinkron & backup (AUTH-01, SYNC-01). The demo has no server.
export async function signOutBlockers(db:MejaDB,user:Identity){
 if(user.demo)return {shift:false,cart:false,unsent:0,rejected:0}
 const s=await db.shifts.where('status').equals('open').first(),d=await db.drafts.get('current')
 return {shift:Boolean(s&&s.actor===user.id),cart:Boolean(d&&!d.orderId&&d.lines.some(l=>!l.cancelled)),unsent:await db.outbox.where('state').equals('pending').count(),rejected:await db.outbox.where('state').equals('rejected').count()}
}
// Only this device's session ends: the default (global) would also sign the same person out on the laptop. The PIN hash
// goes too: it would crack offline to the account password long after its owner left the device. SEC-5: so does this
// person's database (both callers refuse while anything is unsent; bootstrap refills it at the next sign-in). A delete
// another tab still blocks is not waited for: the device must sign out either way.
export async function logout(db?:MejaDB){await supabase?.auth.signOut({scope:'local'});localStorage.removeItem('meja-identity');localStorage.removeItem('takar-locked');localStorage.removeItem('takar-pin-hash');if(db&&!db.name.startsWith('meja-demo'))await Promise.race([db.delete(),new Promise(r=>setTimeout(r,3000))]).catch(()=>undefined);location.assign('/')}
