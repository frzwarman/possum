// QA 2026-11-25, cluster station: STN-03 (the bump names its lines), STN-06 (tickets of the shift), AUTH-05/STN-05 (a pull
// that contradicts the identity), STN-08 (a failing pull is remembered). Server side: scripts/db-checks/qa-station.mjs.
import { describe,expect,it,vi } from 'vitest'
import { draft,identity,line,seed,tick } from './offline-harness'
import { movedBy,pull,synchronize,type PullResult } from '../../src/lib/sync'
import { onBoard } from '../../src/domain/calculate'
vi.mock('../../src/lib/supabase',()=>({configured:true,telegramBot:'',supabase:null}))
const none=(over:Partial<PullResult>={}):PullResult=>({now:new Date().toISOString(),orders:[],shifts:[],cash:[],movements:[],counts:[],...over})
describe('STN-03 a bump marks only what the ticket showed',()=>{
 it('ready(station) names the lines it showed, and a line sent after is not marked',async()=>{
  const {db,commands}=await seed(identity())
  await commands.openShift(200000);await tick()
  const a=line({station:'kitchen'}),b=line({station:'kitchen'})
  const order=await commands.save(draft([a]));await tick()
  await commands.prepare(order.id);await tick()
  await db.orders.update(order.id,o=>{o.lines=[...o.lines,b]}) // a second round: not prepared, so not on the ticket the tablet showed
  await commands.ready(order.id,'kitchen')
  const op=(await db.outbox.toArray()).find(o=>o.kind==='order.ready')!
  expect(op.payload).toEqual({id:order.id,station:'kitchen',lines:[a.id]})
  expect((await db.orders.get(order.id))!.lines.map(l=>Boolean(l.readyAt))).toEqual([true,false])
 })
})
describe('STN-11 review: the lines are those at the tap, not at the send 4 s later',()=>{
 it('a line prepared while the Siap waited is not marked',async()=>{
  const {db,commands}=await seed(identity())
  await commands.openShift(200000);await tick()
  const a=line({station:'kitchen'}),b=line({station:'kitchen'})
  const order=await commands.save(draft([a]));await tick()
  await commands.prepare(order.id);await tick()
  await db.orders.update(order.id,o=>{o.lines=[...o.lines,{...b,prepared:true}]}) // a second round reaches the tablet after the tap
  await commands.ready(order.id,'kitchen',[a.id])
  const op=(await db.outbox.toArray()).find(o=>o.kind==='order.ready')!
  expect(op.payload.lines).toEqual([a.id])
  expect((await db.orders.get(order.id))!.lines.map(l=>Boolean(l.readyAt))).toEqual([true,false])
 })
})
describe('STN-06 a ticket belongs to the open shift, or to today',()=>{
 const o=(shiftId:string,createdAt:string)=>({shiftId,createdAt})
 it('with a shift open only its orders count',()=>{
  expect(onBoard(o('s1','2026-11-25T03:00:00Z'),{id:'s1'},undefined,Date.parse('2026-11-25T05:00:00Z'))).toBe(true)
  expect(onBoard(o('s0','2026-11-25T03:00:00Z'),{id:'s1'},undefined,Date.parse('2026-11-25T05:00:00Z'))).toBe(false)
 })
 it('with none open yesterday is out and today is in (cutoff 4 in Jakarta)',()=>{
  const now=Date.parse('2026-11-25T05:00:00Z')
  expect(onBoard(o('s0','2026-11-24T05:00:00Z'),undefined,{timezone:'Asia/Jakarta',cutoff:4},now)).toBe(false)
  expect(onBoard(o('s0','2026-11-25T01:00:00Z'),undefined,{timezone:'Asia/Jakarta',cutoff:4},now)).toBe(true)
 })
})
describe('AUTH-05 / STN-05 a pull that contradicts the identity',()=>{
 const stale=async(db:Awaited<ReturnType<typeof seed>>['db'])=>{const v=(await db.meta.get('stale'))?.value;return v?JSON.parse(v):undefined}
 async function pulled(user:ReturnType<typeof identity>,over:Partial<PullResult>){const {db}=await seed(user);await db.meta.put({id:'pullCursor',value:new Date().toISOString()});await pull(db,user,async()=>none(over));return db}
 it('the till moved: the old device stops being the till',async()=>{
  const user=identity({primary:true,mode:'pos',role:'cashier'})
  const db=await pulled(user,{device:{mode:null,enrolled:false,primary:false}})
  const s=await stale(db);expect(s.identity).toEqual({primary:false,mode:null});expect(s.note).toMatch(/dicabut/)
 })
 it('the device is still paired but is no longer the till',async()=>{
  const db=await pulled(identity({primary:true,mode:'pos'}),{device:{mode:'station',enrolled:true,primary:false}})
  expect((await stale(db)).identity).toEqual({primary:false,mode:'station'})
 })
 it('a role change and a switched-off person reach the device',async()=>{
  expect((await stale(await pulled(identity({role:'manager'}),{member:{role:'cashier',active:true}}))).identity).toEqual({role:'cashier'})
  expect((await stale(await pulled(identity({role:'cashier'}),{member:{role:'cashier',active:false}}))).identity).toEqual({primary:false,mode:null})
 })
 it('nothing differs, or a device never paired: no verdict; a later pull that agrees clears an old one',async()=>{
  expect(await stale(await pulled(identity({primary:true,mode:'pos'}),{device:{mode:'pos',enrolled:true,primary:true},member:{role:'manager',active:true}}))).toBeUndefined()
  expect(await stale(await pulled(identity({primary:false,mode:null}),{device:{mode:null,enrolled:false,primary:false}}))).toBeUndefined()
  const user=identity({primary:true,mode:'pos'});const db=await pulled(user,{device:{mode:null,enrolled:false,primary:false}});expect(await stale(db)).toBeDefined()
  await pull(db,user,async()=>none({device:{mode:'pos',enrolled:true,primary:true}}));expect(await stale(db)).toBeUndefined()
 })
 it('movedBy is quiet for a matching identity',()=>expect(movedBy({mode:'pos',enrolled:true,primary:true},{role:'manager',active:true},{primary:true,mode:'pos',role:'manager'})).toBeUndefined())
})
describe('STN-08 a failing pull is remembered until one works',()=>{
 it('sets and clears meta pullError',async()=>{
  const user=identity({primary:false,mode:'station',role:'kitchen'});const {db}=await seed(user);await db.meta.put({id:'pullCursor',value:new Date().toISOString()})
  const down=async()=>{throw {message:'Failed to fetch'}}
  Object.defineProperty(navigator,'locks',{value:{request:async(_:string,__:unknown,f:(l:unknown)=>Promise<unknown>)=>f({})},configurable:true})
  await synchronize(db,user,undefined,down)
  expect((await db.meta.get('pullError'))?.value).toMatch(/Failed to fetch$/)
  await synchronize(db,user,undefined,async()=>none())
  expect(await db.meta.get('pullError')).toBeUndefined()
 })
})
