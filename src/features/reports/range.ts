import { useEffect,useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useApp } from '../../app/context'
import type { Order } from '../../domain/types'
import { supabase } from '../../lib/supabase'
// QA RPT-1, CAT-3, TILL-07, PERF-3: no total is ever summed from the app's newest-500 window (context.tsx). A close
// screen reads its shift's own orders from the device; Laporan and Penjualan read the chosen range: signed in from the
// server (a device holds only what sign-in and pull gave it), with this device's rows laid over them (unsent work,
// and anything newer); in the demo, or when the server cannot be reached, from the device alone, and the notice says so.
const DAY=864e5,PAGE=1000,MAX=20000,date=/^\d{4}-\d\d-\d\d$/
// A business day reaches past midnight and an order can be paid a while after it was made, so ask a little wider than
// the range and let the screen keep what was paid (or refunded) inside it.
export const rangeBounds=(from:string,to:string)=>[new Date(Date.parse(from+'T00:00:00Z')-2*DAY).toISOString(),new Date(Date.parse(to+'T00:00:00Z')+2*DAY).toISOString()] as const
// The server's orders for the range: every page of those created in it, and the older orders refunded in it.
export async function serverOrders(from:string,to:string){
 const [lo,hi]=rangeBounds(from,to),rows:Order[]=[]
 for(let i=0;;i+=PAGE){
  const {data,error}=await supabase!.from('orders').select('snapshot').gte('created_at',lo).lt('created_at',hi).order('created_at').order('id').range(i,i+PAGE-1)
  if(error)throw new Error(error.message);rows.push(...data.map(r=>r.snapshot as unknown as Order))
  if(data.length<PAGE)break;if(i+PAGE>=MAX)throw new Error('Rentang terlalu besar, pilih yang lebih pendek')}
 const have=new Set(rows.map(o=>o.id)),{data:refunds,error}=await supabase!.from('refunds').select('order_id').gte('occurred_at',lo).lt('occurred_at',hi).limit(PAGE)
 if(error)throw new Error(error.message)
 const older=[...new Set((refunds??[]).map(r=>r.order_id))].filter(id=>!have.has(id))
 for(let i=0;i<older.length;i+=100){const {data,error}=await supabase!.from('orders').select('snapshot').in('id',older.slice(i,i+100));if(error)throw new Error(error.message);rows.push(...data.map(r=>r.snapshot as unknown as Order))}
 return rows
}
// This device's rows beat the server's unless the server's is a newer revision (another till paid it meanwhile).
export function overlay(remote:Order[],local:Order[]){const by=new Map(remote.map(o=>[o.id,o]));for(const o of local){const r=by.get(o.id);if(!r||o.revision>=r.revision)by.set(o.id,o)}return [...by.values()]}
export function useRangeOrders(from:string,to:string,on=true){
 const {db,user}=useApp(),ok=on&&date.test(from)&&date.test(to)&&from<=to,[lo,hi]=ok?rangeBounds(from,to):['',''],key=`${from}|${to}`
 const local=useLiveQuery(()=>ok?db.orders.where('createdAt').between(lo,hi,true,true).toArray():[],[db,ok,lo,hi])
 const [remote,setRemote]=useState<{key:string;rows:Order[];error:string}>()
 const online=ok&&!user.demo&&Boolean(supabase)
 useEffect(()=>{if(!online)return;let live=true;setRemote(undefined)
  serverOrders(from,to).then(rows=>{if(live)setRemote({key,rows,error:''})},e=>{if(live)setRemote({key,rows:[],error:e instanceof Error?e.message:'Gagal memuat'})})
  return()=>{live=false}},[online,key]) // eslint-disable-line react-hooks/exhaustive-deps
 const mine=remote?.key===key?remote:undefined
 return {orders:overlay(mine?.rows??[],local??[]),loading:online&&!mine,
  notice:mine?.error?`Server tidak terjangkau (${mine.error}). Angka dari data di perangkat ini dan mungkin tidak lengkap.`:''}
}
// The shift's own orders: what Commands.closeShift sums, so the screen and the close agree.
export function useShiftOrders(shiftId?:string){const {db}=useApp();return useLiveQuery(()=>shiftId?db.orders.where('shiftId').equals(shiftId).toArray():[],[db,shiftId])??[]}
