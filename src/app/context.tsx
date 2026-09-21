import { createContext,useContext,useEffect,useMemo,useState,type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Identity } from '../domain/types'
import { databaseFor,uid } from '../lib/db'
import { Commands } from '../lib/commands'
import { defaultSettings,sampleMenu,stock } from '../domain/sample'
import { synchronize } from '../lib/sync'
import { supabase } from '../lib/supabase'
function useModel(user:Identity){
 const db=useMemo(()=>databaseFor(user),[user]);const commands=useMemo(()=>new Commands(db,user),[db,user]);const [notice,setNotice]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [online,setOnline]=useState(navigator.onLine)
 const menuRows=useLiveQuery(()=>db.menu.toArray(),[db]);const menu=menuRows||[];const settings=useLiveQuery(()=>db.settings.get('settings'),[db]);const orders=useLiveQuery(()=>db.orders.orderBy('createdAt').reverse().limit(500).toArray(),[db])||[];const shifts=useLiveQuery(()=>db.shifts.toArray(),[db])||[];const movements=useLiveQuery(()=>db.movements.toArray(),[db])||[];const stockItems=useLiveQuery(()=>db.stock.toArray(),[db])||[];const cash=useLiveQuery(()=>db.cash.toArray(),[db])||[];const outbox=useLiveQuery(()=>db.outbox.toArray(),[db])||[];const lastSync=useLiveQuery(()=>db.meta.get('lastSync'),[db]);const shift=shifts.find(s=>s.status==='open')
 async function sync(){try{await synchronize(db,user)}catch(e){setError(e instanceof Error?e.message:'Sinkronisasi gagal')}}
 useEffect(()=>{let active=true;void(async()=>{if(user.demo&&!await db.meta.get('initialized')){await db.transaction('rw',db.tables,async()=>{await db.settings.put(defaultSettings);await db.menu.bulkPut(sampleMenu);await db.stock.bulkPut(stock);for(const item of stock)await db.movements.add({id:uid(),stockId:item.id,qty:item.unit==='g'?10000000:50000,kind:'opening',reason:'Saldo awal contoh demo',actor:user.id,at:new Date().toISOString(),recordId:'demo-opening',cost:0});await db.meta.put({id:'initialized',value:'yes'})})}if(active)await sync()})().catch(e=>setError(String(e)));const foreground=()=>{if(document.visibilityState==='visible')void sync()};const network=()=>{setOnline(navigator.onLine);if(navigator.onLine)void sync()};window.addEventListener('online',network);window.addEventListener('offline',network);document.addEventListener('visibilitychange',foreground);const timer=setInterval(()=>{if(document.visibilityState==='visible')void sync()},30000);return()=>{active=false;clearInterval(timer);window.removeEventListener('online',network);window.removeEventListener('offline',network);document.removeEventListener('visibilitychange',foreground)}},[db,user])
 async function act<T>(action:()=>Promise<T>,message?:string):Promise<T|undefined>{if(busy)return;setBusy(true);setError('');try{const value=await action();if(!user.demo)await sync();if(message)setNotice(message);return value}catch(e){setError(e instanceof Error?e.message:'Tindakan gagal. Data belum tersimpan.');return undefined}finally{setBusy(false)}}
 useEffect(()=>{if(notice){const t=setTimeout(()=>setNotice(''),4500);return()=>clearTimeout(t)}},[notice])
 return {user,db,commands,menu,hydrating:menuRows===undefined,settings,orders,shifts,shift,movements,stockItems,cash,outbox,lastSync:lastSync?.value,notice,error,busy,online,act,sync,setNotice,setError,manager:user.role!=='cashier'}
}
const Context=createContext<ReturnType<typeof useModel>|null>(null)
export function AppProvider({user,children}:{user:Identity;children:ReactNode}){const value=useModel(user);return <Context.Provider value={value}>{children}</Context.Provider>}
export function useApp(){const ctx=useContext(Context);if(!ctx)throw new Error('AppProvider required');return ctx}
export async function logout(){await supabase?.auth.signOut();localStorage.removeItem('meja-identity');location.assign('/')}
