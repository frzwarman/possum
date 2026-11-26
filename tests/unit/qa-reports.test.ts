import { beforeEach,describe,expect,it,vi } from 'vitest'
import type { Order } from '../../src/domain/types'
// QA 2026-11-25, cluster reports: Laporan and Penjualan read the server's orders for the range, every page of them
// (RPT-1, CAT-3), and this device's rows are laid over them without losing the newer of two copies.
const state=vi.hoisted(()=>({orders:[] as {created_at:string;id:string;snapshot:unknown}[],refunds:[] as {order_id:string}[],calls:[] as string[]}))
// A PostgREST stand-in: created_at bounds and paging apply to the orders table, an id list picks rows, refunds come back whole.
vi.mock('../../src/lib/supabase',()=>({supabase:{from:(table:string)=>{
 const q:{gte?:string;lt?:string;range?:[number,number];ids?:string[]}={}
 const chain:any=new Proxy({},{get:(_,k:string)=>{
  if(k==='then')return (ok:(v:unknown)=>void)=>{
   if(table==='refunds'){state.calls.push('refunds');return ok({data:state.refunds,error:null})}
   let rows=state.orders
   if(q.ids){state.calls.push('in:'+q.ids.length);rows=rows.filter(r=>q.ids!.includes(r.id))}
   else{state.calls.push('page:'+q.range![0]);rows=rows.filter(r=>r.created_at>=q.gte!&&r.created_at<q.lt!).slice(q.range![0],q.range![1]+1)}
   return ok({data:rows.map(r=>({snapshot:r.snapshot})),error:null})}
  return (...a:any[])=>{if(k==='gte'&&a[0]==='created_at')q.gte=a[1];if(k==='lt'&&a[0]==='created_at')q.lt=a[1];if(k==='range')q.range=[a[0],a[1]];if(k==='in')q.ids=a[1];return chain}}})
 return chain}}}))
const {overlay,rangeBounds,serverOrders}=await import('../../src/features/reports/range')
const order=(id:string,revision=1,more:Partial<Order>={})=>({id,revision,totals:{total:1000},...more}) as unknown as Order
beforeEach(()=>{state.orders=[];state.refunds=[];state.calls=[]})
describe('range orders',()=>{
 it('RPT-1: asks the server for every page of the range, not the first 1.000, and for older orders refunded in it',async()=>{
  const id=(i:number)=>`o${String(i).padStart(4,'0')}`
  state.orders=Array.from({length:2300},(_,i)=>({created_at:'2026-11-20T00:00:00Z',id:id(i),snapshot:order(id(i))}))
  // Made long before the range, refunded in it: only the refund query finds it.
  state.orders.push({created_at:'2026-01-01T00:00:00Z',id:'old',snapshot:order('old')});state.refunds=[{order_id:'old'}]
  const got=await serverOrders('2026-11-19','2026-11-21')
  expect(got.length).toBe(2301)
  expect(got.map(o=>o.id)).toContain('old')
  expect(state.calls).toEqual(['page:0','page:1000','page:2000','refunds','in:1'])
 })
 it('lays this device\'s rows over the server\'s: unsent work shows, the newer revision wins, nothing is counted twice',()=>{
  const merged=overlay([order('a',1),order('b',3),order('c',1)],[order('a',2,{status:'paid'}),order('b',2),order('d',1)])
  expect(merged.map(o=>[o.id,o.revision]).sort()).toEqual([['a',2],['b',3],['c',1],['d',1]])
 })
 it('asks a little wider than the range, for an order made before it was paid',()=>{
  const [lo,hi]=rangeBounds('2026-11-10','2026-11-12')
  expect(lo<'2026-11-09T00:00:00Z'&&hi>'2026-11-13T00:00:00Z').toBe(true)
 })
})
