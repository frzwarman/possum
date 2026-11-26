import { afterEach,describe,expect,it,vi } from 'vitest'
import { boom,identity,recorder,sale,seed,tick } from './offline-harness'
import { byOrder,isFinal,offsetFrom,serverTransport,synchronize } from '../../src/lib/sync'
import type { Operation } from '../../src/domain/types'
// QA 2026-11-25, cluster outbox: the outbox and the clock. serverTransport talks to Supabase: a stand-in client.
type Answer={data:unknown;error:{code:string;message:string}|null;status?:number}
const server=vi.hoisted(()=>({answers:[] as Answer[],calls:0,refreshes:0,refreshError:null as unknown,rpc:async(_n:string):Promise<Answer>=>({data:null,error:null})}))
vi.mock('../../src/lib/supabase',()=>({configured:true,telegramBot:'',supabase:{rpc:(n:string)=>{server.calls++;return Promise.resolve(server.answers.shift()??{data:{receivedAt:new Date().toISOString()},error:null})},auth:{getSession:async()=>({data:{session:{user:{id:server.rpc.name==='x'?'x':'kasir'}}},error:null}),refreshSession:async()=>{server.refreshes++;return {error:server.refreshError}}}}}))
afterEach(()=>{vi.useRealTimers();server.answers=[];server.calls=0;server.refreshes=0;server.refreshError=null})
const fresh=async()=>{const user=identity();const s=await seed(user);await s.db.meta.put({id:'pullCursor',value:new Date().toISOString()});return {user,...s}}
const empty=(now:string)=>({now,orders:[],shifts:[],cash:[],movements:[],counts:[]})
// Only Date is faked: Dexie and fake-indexeddb still need real timers to settle.
const at=async(when:number,run:()=>Promise<unknown>)=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(when);try{await run()}finally{vi.useRealTimers()}}
const op=(over:Partial<Operation>):Operation=>({id:crypto.randomUUID(),kind:'order.ready',actor:'a',restaurantId:'r',deviceId:'d',occurredAt:'2026-11-25T03:00:00.000Z',payload:{},state:'pending',attempts:0,nextAttempt:0,...over})
describe('the device clock is not trusted (SYNC-02, CT-10, TILL-10, AUTH-09)',()=>{
 it('stamps with the server time the device learned from pull, whatever its own clock says',async()=>{
  const {user,db,commands}=await fresh();const real=Date.now()
  // The tablet's clock runs 10 minutes fast: the server's 'now' says so, and the shift is stamped with the server's time.
  await at(real+600000,async()=>{await synchronize(db,user,recorder().transport,async()=>empty(new Date(real).toISOString()))})
  expect(Math.abs(Number((await db.meta.get('clockOffset'))?.value)+600000)).toBeLessThan(2000)
  await at(real+600000,()=>commands.openShift(0))
  const stamped=Date.parse((await db.outbox.toArray())[0].occurredAt)
  expect(Math.abs(stamped-real)).toBeLessThan(2000)
 })
 it('offsetFrom measures from the middle of the round trip and ignores a missing time',()=>{
  expect(offsetFrom(undefined)).toBeUndefined()
  expect(Math.abs(offsetFrom(new Date(Date.now()+5000).toISOString(),Date.now()-100)!-5050)).toBeLessThan(100)
 })
 it('sends an operation queued by a fast clock as now, not refused as the future',async()=>{
  const {user,db}=await fresh()
  await db.outbox.add(op({actor:user.id,occurredAt:new Date(Date.now()+3600000).toISOString()}))
  const {sent,transport}=recorder();await synchronize(db,user,transport,async()=>empty(new Date().toISOString()))
  expect(Date.parse(sent[0].occurredAt)-Date.now()).toBeLessThan(5000)
 })
})
describe('operations go out in the order they were made (SYNC-04)',()=>{
 it('a clock stepped back during offline sales does not put the payment before its order',async()=>{
  const {user,db,commands}=await fresh();const t=Date.now()
  await at(t,async()=>{await commands.openShift(0)})
  const {draft,line}=await import('./offline-harness');let id=''
  await at(t+1,async()=>{id=(await commands.save(draft([line()]))).id})
  await at(t+2,()=>commands.prepare(id))
  await at(t-3600000,()=>commands.pay(id,'cash',100000,true))
  const {sent,transport}=recorder();await synchronize(db,user,transport,async()=>empty(new Date().toISOString()))
  expect(sent.map(o=>o.kind)).toEqual(['shift.open','order.save','order.prepare','payment.record'])
 })
 it('byOrder: what the old client queued (no seq) goes first, by time; the rest by seq',()=>{
  const old1=op({occurredAt:'2026-11-25T03:00:05.000Z'}),old2=op({occurredAt:'2026-11-25T03:00:01.000Z'}),a=op({seq:2,occurredAt:'2026-11-25T01:00:00.000Z'}),b=op({seq:1,occurredAt:'2026-11-25T09:00:00.000Z'})
  expect([a,old1,b,old2].sort(byOrder)).toEqual([old2,old1,b,a])
 })
})
describe('what the queue does while the server answers',()=>{
 it('SYNC-14: a back-off kept from an outage does not outlive the pull that proves the server is back',async()=>{
  const {user,db}=await fresh()
  await db.outbox.add(op({actor:user.id,attempts:6,nextAttempt:Date.now()+300000,error:'Failed to fetch'}))
  const {sent,transport}=recorder();await synchronize(db,user,transport,async()=>empty(new Date().toISOString()))
  expect(sent).toHaveLength(1);expect(await db.outbox.where('state').equals('synced').count()).toBe(1)
 })
 it('does not loop on an operation the server keeps failing: one attempt per sync, back-off kept',async()=>{
  const {user,db}=await fresh();await db.outbox.add(op({actor:user.id}))
  const {sent,transport}=recorder(()=>{throw boom('busy','Network')});await synchronize(db,user,transport,async()=>empty(new Date().toISOString()))
  expect(sent).toHaveLength(1);expect((await db.outbox.toArray())[0].nextAttempt).toBeGreaterThan(Date.now())
 })
 it('PERF-8: a backlog drains in one sync, not 25 per tick',async()=>{
  const {user,db}=await fresh()
  await db.outbox.bulkAdd(Array.from({length:130},(_,i)=>op({actor:user.id,seq:i+1})))
  const {sent,transport}=recorder();await synchronize(db,user,transport,async()=>empty(new Date().toISOString()))
  expect(sent).toHaveLength(130);expect(sent.map(o=>o.seq)).toEqual(Array.from({length:130},(_,i)=>i+1))
 })
 it('picks up an operation queued while a round was running',async()=>{
  const {user,db}=await fresh();await db.outbox.add(op({actor:user.id,seq:1}))
  const {sent,transport}=recorder((o)=>{if(o.seq===1)void db.outbox.add(op({actor:user.id,seq:2}))})
  await synchronize(db,user,transport,async()=>empty(new Date().toISOString()))
  expect(sent.map(o=>o.seq)).toEqual([1,2])
 })
})
describe('a refusal the server will repeat for ever is Rejected (CT-08, SQL-09)',()=>{
 it('decides by SQLSTATE class',()=>{
  for(const code of ['P0001','42501','22P05','22003','22007','22P02','23502','23503','23505','23514'])expect(isFinal(code),code).toBe(true)
  for(const code of ['08006','40001','40P01','53300','57014','PGRST303','PGRST000','42883','',undefined])expect(isFinal(code),String(code)).toBe(false)
  expect(isFinal(undefined,413)).toBe(true)
 })
 it('serverTransport names a NUL refusal Rejected and a dropped connection Network',async()=>{
  const o=op({actor:'kasir'})
  server.answers=[{data:null,error:{code:'22P05',message:'unsupported Unicode escape sequence'}}]
  await expect(serverTransport(o)).rejects.toMatchObject({name:'Rejected'})
  server.answers=[{data:null,error:{code:'23502',message:'null value'}}]
  await expect(serverTransport(o)).rejects.toMatchObject({name:'Rejected'})
  server.answers=[{data:null,error:{code:'08006',message:'connection failure'}}]
  await expect(serverTransport(o)).rejects.toMatchObject({name:'Network'})
  server.answers=[{data:null,error:{code:'',message:''},status:413}]
  await expect(serverTransport(o)).rejects.toMatchObject({name:'Rejected'})
 })
 it('strips NUL from every text before the operation is queued',async()=>{
  const {user,db,commands}=await fresh()
  await commands.stockRecord('rice','waste',1000,'rusak\u0000 parah')
  const queued=(await db.outbox.toArray())[0];expect(JSON.stringify(queued.payload)).not.toContain('\\u0000');expect(queued.payload.reason).toBe('rusak parah')
 })
})
describe('an expired token is refreshed once (SYNC-03, AUTH-09)',()=>{
 it('refreshes the session on 401 JWT expired and sends again',async()=>{
  server.answers=[{data:null,error:{code:'PGRST303',message:'JWT expired'},status:401},{data:{receivedAt:'2026-11-25T03:00:00.000Z'},error:null}]
  await expect(serverTransport(op({actor:'kasir'}))).resolves.toEqual({receivedAt:'2026-11-25T03:00:00.000Z'})
  expect(server.refreshes).toBe(1);expect(server.calls).toBe(2)
 })
 it('when the refresh fails the error stays a Network one (the operation waits)',async()=>{
  server.answers=[{data:null,error:{code:'PGRST303',message:'JWT expired'},status:401}];server.refreshError=new Error('offline')
  await expect(serverTransport(op({actor:'kasir'}))).rejects.toMatchObject({name:'Network'})
  expect(server.refreshes).toBe(1);expect(server.calls).toBe(1)
 })
})
describe('every request has a time bound (SYNC-06)',()=>{
 it('aborts a request that never answers after 30 s, and honours the caller signal',async()=>{
  const {withTimeout,REQUEST_MS}=await vi.importActual<typeof import('../../src/lib/supabase')>('../../src/lib/supabase')
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']})
  const hang=vi.fn((_u:unknown,init?:RequestInit)=>new Promise((_,no)=>init!.signal!.addEventListener('abort',()=>no(init!.signal!.reason))))
  vi.stubGlobal('fetch',hang)
  try{
   const p=withTimeout('https://x.test/rpc/apply_operation',{method:'POST'});const seen=p.catch(e=>e)
   await vi.advanceTimersByTimeAsync(REQUEST_MS-1);expect(hang).toHaveBeenCalledTimes(1)
   await vi.advanceTimersByTimeAsync(2);expect(((await seen) as Error).name).toBe('TimeoutError')
   const own=new AbortController();const q=withTimeout('https://x.test',{signal:own.signal}).catch(e=>e);own.abort(new Error('caller'));expect(((await q) as Error).message).toBe('caller')
  }finally{vi.unstubAllGlobals()}
 })
})
