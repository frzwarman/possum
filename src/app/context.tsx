import { createContext,useContext,useEffect,useMemo,useState,type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Identity,MenuItem,Outlet,Station } from '../domain/types'
import { databaseFor,uid } from '../lib/db'
import { Commands } from '../lib/commands'
import { defaultSettings,demoOutlet,demoTransfer,sampleMenu,stock } from '../domain/sample'
import { availability,unitCosts } from '../domain/calculate'
import { can } from '../domain/permissions'
import { synchronize } from '../lib/sync'
import { supabase } from '../lib/supabase'
function useModel(user:Identity){
 const db=useMemo(()=>databaseFor(user),[user]);const commands=useMemo(()=>new Commands(db,user),[db,user]);const [notice,setNotice]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [online,setOnline]=useState(navigator.onLine)
 // Which station this tablet shows is a choice made on the tablet itself.
 const [station,pickStation]=useState<Station>(()=>{try{return (localStorage.getItem('takar-station')as Station)||'kitchen'}catch{return 'kitchen'}})
 const setStation=(s:Station)=>{try{localStorage.setItem('takar-station',s)}catch{/* private mode */}pickStation(s)}
 // Ids are random UUIDs, so table order is arbitrary: list shifts and the queue by time. Every screen
 // shows only unsynced work, and synced operations pile up forever; reading them all on each write won't last.
 const menuRows=useLiveQuery(()=>db.menu.toArray(),[db]);const menu=menuRows||[];const settings=useLiveQuery(()=>db.settings.get('settings'),[db]);const orders=useLiveQuery(()=>db.orders.orderBy('createdAt').reverse().limit(500).toArray(),[db])||[];const shifts=useLiveQuery(()=>db.shifts.toCollection().sortBy('openedAt'),[db])||[];const movements=useLiveQuery(()=>db.movements.toArray(),[db])||[];const stockItems=useLiveQuery(()=>db.stock.toArray(),[db])||[];const cash=useLiveQuery(()=>db.cash.toArray(),[db])||[];const outbox=useLiveQuery(()=>db.outbox.where('state').anyOf('pending','rejected').sortBy('occurredAt'),[db])||[];const lastSync=useLiveQuery(()=>db.meta.get('lastSync'),[db]);const purchaseOrders=useLiveQuery(()=>db.purchaseOrders.orderBy('createdAt').reverse().toArray(),[db])||[];const suppliers=useLiveQuery(()=>db.suppliers.toArray(),[db])||[];const salesOrders=useLiveQuery(()=>db.salesOrders.orderBy('deliverAt').reverse().toArray(),[db])||[];const transfers=useLiveQuery(()=>db.transfers.orderBy('sentAt').reverse().toArray(),[db])||[];const counts=useLiveQuery(()=>db.counts.toArray(),[db])||[];const outletRow=useLiveQuery(()=>db.meta.get('outlets'),[db]);const outlets:Outlet[]=JSON.parse(outletRow?.value||'[]');const costRow=useLiveQuery(()=>db.meta.get('costs'),[db]);const costs=useMemo(()=>unitCosts(movements,JSON.parse(costRow?.value||'{}')),[movements,costRow]);const shift=shifts.find(s=>s.status==='open')
 const deviceRow=useLiveQuery(()=>db.meta.get('device'),[db]);const device=useMemo(()=>deviceRow?JSON.parse(deviceRow.value) as {mode:string|null;enrolled:boolean;primary:boolean}:null,[deviceRow])
 // Stock on hand = sum of movements; "can make" per menu item follows from it (POS-7, TDY-3).
 const balances=useMemo(()=>{const m=new Map<string,number>();for(const x of movements)m.set(x.stockId,(m.get(x.stockId)||0)+x.qty);return m},[movements])
 const balance=(id:string)=>balances.get(id)||0
 const canMake=(item:MenuItem)=>availability(item,balance,settings?.lowAt??5)
 async function sync(){try{await synchronize(db,user)}catch(e){setError(e instanceof Error?e.message:'Sinkronisasi gagal')}}
 useEffect(()=>{let active=true;void(async()=>{if(user.demo&&!await db.meta.get('initialized')){await db.transaction('rw',db.tables,async()=>{await db.settings.put(defaultSettings);await db.menu.bulkPut(sampleMenu);await db.stock.bulkPut(stock);for(const item of stock)await db.movements.add({id:uid(),stockId:item.id,qty:item.unit==='pcs'?50000:10000000,kind:'opening',reason:'Saldo awal contoh demo',actor:user.id,at:new Date().toISOString(),recordId:'demo-opening',cost:0});await db.meta.put({id:'initialized',value:'yes'})})}
 // Demo installs made before the sample pictures existed get them filled in; anything the demo user set stays.
 if(user.demo)await db.transaction('rw',db.menu,db.stock,async()=>{for(const m of sampleMenu)if(m.photo)await db.menu.where('id').equals(m.id).modify(x=>{if(!x.photo)x.photo=m.photo});for(const s of stock)if(s.photo)await db.stock.where('id').equals(s.id).modify(x=>{if(!x.photo)x.photo=s.photo})})
 if(user.demo&&!await db.meta.get('outlets')){const here=(await db.settings.get('settings'))?.name||'';await db.transaction('rw',db.meta,db.transfers,async()=>{await db.meta.put({id:'outlets',value:JSON.stringify([demoOutlet])});await db.transfers.put(demoTransfer(user.restaurantId,here,new Date().toISOString()))})}if(active)await sync()})().catch(e=>setError(String(e)));const foreground=()=>{if(document.visibilityState==='visible')void sync()};const network=()=>{setOnline(navigator.onLine);if(navigator.onLine)void sync()};window.addEventListener('online',network);window.addEventListener('offline',network);document.addEventListener('visibilitychange',foreground)
 // A station tablet polls fast so a ticket shows within seconds; the till a little slower; a laptop idles.
 const timer=setInterval(()=>{if(document.visibilityState==='visible')void sync()},user.mode==='station'?5000:user.primary?10000:30000);return()=>{active=false;clearInterval(timer);window.removeEventListener('online',network);window.removeEventListener('offline',network);document.removeEventListener('visibilitychange',foreground)}},[db,user])
 async function act<T>(action:()=>Promise<T>,message?:string):Promise<T|undefined>{if(busy)return;setBusy(true);setError('');try{const value=await action();if(!user.demo)await sync();if(message)setNotice(message);return value}catch(e){setError(e instanceof Error?e.message:'Tindakan gagal. Data belum tersimpan.');return undefined}finally{setBusy(false)}}
 useEffect(()=>{if(notice){const t=setTimeout(()=>setNotice(''),4500);return()=>clearTimeout(t)}},[notice])
 return {user,db,commands,menu,hydrating:menuRows===undefined,settings,orders,purchaseOrders,suppliers,salesOrders,transfers,counts,outlets,costs,shifts,shift,movements,stockItems,cash,outbox,lastSync:lastSync?.value,device,balances,balance,canMake,station,setStation,notice,error,busy,online,act,sync,setNotice,setError,
  // manager = may approve (owner, manager); office = may open the back office (owner, manager, admin, chef).
  manager:can(user.role,'approve'),office:can(user.role,'backoffice')}
}
const Context=createContext<ReturnType<typeof useModel>|null>(null)
export function AppProvider({user,children}:{user:Identity;children:ReactNode}){const value=useModel(user);return <Context.Provider value={value}>{children}</Context.Provider>}
export function useApp(){const ctx=useContext(Context);if(!ctx)throw new Error('AppProvider required');return ctx}
export async function logout(){await supabase?.auth.signOut();localStorage.removeItem('meja-identity');location.assign('/')}
