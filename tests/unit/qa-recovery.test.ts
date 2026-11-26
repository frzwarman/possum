import { describe,expect,it } from 'vitest'
import { boom,identity,line,draft,recorder,sale,seed,tick } from './offline-harness'
import { discardRejected,synchronize } from '../../src/lib/sync'
import { exportData,jsonParts } from '../../src/lib/db'
import { signOutBlockers } from '../../src/app/context'
import type { Operation,Order } from '../../src/domain/types'
// QA 2026-11-25, cluster recovery: releasing a refused operation (AUTH-01, SYNC-01, SYNC-10) and the recovery file (PERF-2).
const empty=(orders:Order[]=[],since?:{value?:string})=>async(s:string)=>({now:new Date().toISOString(),orders:orders.filter(o=>Date.parse(o.createdAt)>Date.parse(s)),shifts:[],cash:[],movements:[],counts:[],...since})
const fresh=async()=>{const user=identity({role:'cashier'});const s=await seed(user);await s.db.meta.put({id:'pullCursor',value:new Date().toISOString()});return {user,...s}}
const refusing=(kind:string,message='EDC required')=>recorder(op=>{if(op.kind===kind)throw boom(message,'Rejected')}).transport
describe('a refused payment is released (SYNC-10)',()=>{
 it('leaves the order open and payable again, the drawer without the payment, and the queue free',async()=>{
  const {user,db,commands}=await fresh()
  await commands.openShift(200000);await tick()
  const order=await commands.save(draft([line()]));await tick()
  const prepared=await commands.prepare(order.id);await tick()
  await commands.pay(order.id,'cash',100000,true);await tick()
  expect((await db.orders.get(order.id))?.status).toBe('paid')
  await synchronize(db,user,refusing('payment.record'),empty([prepared]))
  const refused=(await db.outbox.where('state').equals('rejected').toArray())
  expect(refused.map(o=>o.kind)).toEqual(['payment.record'])
  // A pull has since passed the order: only the rewind brings it back.
  await db.meta.put({id:'pullCursor',value:new Date(Date.now()+60000).toISOString()})
  const r=await discardRejected(db,refused[0].id)
  expect(r).toMatchObject({dropped:1,paid:true})
  expect(await db.outbox.where('state').anyOf('pending','rejected').count()).toBe(0)
  expect(await db.cash.filter(c=>c.id===refused[0].id).count()).toBe(0)
  await synchronize(db,user,recorder().transport,empty([prepared]))
  const back=await db.orders.get(order.id)
  expect(back?.status).toBe('open');expect(back?.payment).toBeUndefined()
  // Payable again: the same till records the payment, and the queue accepts it.
  await commands.pay(order.id,'cash',100000,true);await tick()
  expect((await db.orders.get(order.id))?.status).toBe('paid')
 })
 it('after a refused order.save the order and what was queued on it go with it; other work stays',async()=>{
  const {user,db,commands}=await fresh()
  await commands.openShift(200000);await tick()
  const order=await commands.save(draft([line()]));await tick()
  await db.drafts.put(draft([line()],{orderId:order.id,revision:1}))
  await commands.prepare(order.id);await tick()
  await commands.pay(order.id,'cash',100000,true);await tick()
  await commands.cashMove(5000,'Tambah modal');await tick()
  await synchronize(db,user,refusing('order.save','Invalid initial snapshot'),empty())
  const before=(await db.outbox.toArray()).map(o=>[o.kind,o.state])
  expect(before).toContainEqual(['order.save','rejected'])
  const refused=(await db.outbox.where('state').equals('rejected').toArray())[0]
  expect(await discardRejected(db,refused.id)).toMatchObject({dropped:3,order:true})
  expect((await db.outbox.where('state').anyOf('pending','rejected').toArray()).map(o=>o.kind)).toEqual(['shift.cash'])
  expect(await db.orders.get(order.id)).toBeUndefined()
  expect(await db.drafts.get('current')).toBeUndefined()
  expect(await db.movements.filter(m=>m.recordId===order.id).count()).toBe(0)
 })
 it('only a rejected operation can be released',async()=>{
  const {db,commands}=await fresh();await commands.openShift(0);await tick()
  const [op]=await db.outbox.toArray()
  expect(await discardRejected(db,op.id)).toMatchObject({dropped:0});expect(await db.outbox.get(op.id)).toBeDefined()
 })
})
describe('what signing out sees (AUTH-01)',()=>{
 it('counts a refused operation apart from one that waits',async()=>{
  const {user,db,commands}=await fresh();await commands.openShift(0);await tick()
  expect(await signOutBlockers(db,user)).toMatchObject({unsent:1,rejected:0})
  await synchronize(db,user,refusing('shift.open','Not allowed'),empty())
  expect(await signOutBlockers(db,user)).toMatchObject({unsent:0,rejected:1})
 })
})
describe('the recovery file holds only unsent work (PERF-2)',()=>{
 it('leaves out synced history, keeps what is unsent and the records it touches, and the Blob parts parse back',async()=>{
  const {user,db,commands}=await fresh()
  await sale(commands);await synchronize(db,user,recorder().transport,empty())
  // 300 synced operations of history, as a till with months behind it.
  await db.outbox.bulkAdd(Array.from({length:300},(_,i)=>({id:`old-${i}`,kind:'order.ready',actor:user.id,restaurantId:user.restaurantId,deviceId:user.deviceId,occurredAt:new Date(0).toISOString(),payload:{id:`old-order-${i}`},state:'synced',attempts:0,nextAttempt:0}) as Operation))
  const second=await commands.save(draft([line()],{label:'Meja 2'}));await tick()
  const file=await exportData(db,true) as {outbox:Operation[];orders:Order[];shifts:unknown[]}
  expect(file.outbox.map(o=>o.kind)).toEqual(['order.save'])
  expect(file.orders.map(o=>o.id)).toEqual([second.id])
  expect(file.outbox.every(o=>!('deviceId' in o))).toBe(true)
  expect(JSON.parse(jsonParts(file as unknown as Record<string,unknown>,1).join(''))).toEqual(JSON.parse(JSON.stringify(file)))
 })
})
