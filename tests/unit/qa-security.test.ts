import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import { identity,recorder,sale,seed } from './offline-harness'
import { exportData } from '../../src/lib/db'
import { synchronize } from '../../src/lib/sync'
import { UNREACHABLE,pauseNote,pinPause,pinTried,signInError } from '../../src/lib/signin'
// Node's own localStorage shadows jsdom's and has no methods (as in sync.test.ts): a Map stands in.
const store=new Map<string,string>()
beforeEach(()=>{store.clear();vi.stubGlobal('localStorage',{getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>void store.set(k,v),removeItem:(k:string)=>void store.delete(k)})})
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()})
const at=(when:number)=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(when)}
const T0=Date.parse('2026-11-25T10:00:00+07:00'),MIN=60000
describe('SEC-3, SEC-4, AUTH-03: three wrong PINs pause that person on this device for five minutes',()=>{
 it('pauses after the third wrong try, for five minutes from it, and only that person',()=>{
  at(T0);pinTried('budi',false);pinTried('budi',false)
  expect(pinPause('budi')).toBe(0)
  at(T0+10000);pinTried('budi',false)
  expect(pinPause('budi')).toBe(5*MIN)
  expect(pinPause('dedi')).toBe(0)
  at(T0+10000+4*MIN+59000);expect(pinPause('budi')).toBe(1000)
  expect(pauseNote(pinPause('budi'))).toBe('Terlalu banyak PIN salah. Coba lagi dalam 1 menit.')
  at(T0+10000+5*MIN);expect(pinPause('budi')).toBe(0)
 })
 it('is kept in storage, so a reload does not clear it',()=>{
  at(T0);for(let i=0;i<3;i++)pinTried('budi',false)
  expect(JSON.parse(store.get('takar-pin-tries')!)).toEqual({budi:{n:3,at:T0}})
  // A fresh page reads the same storage.
  expect(pinPause('budi')).toBe(5*MIN)
 })
 it('starts counting again after the pause, and after a right PIN',()=>{
  at(T0);for(let i=0;i<3;i++)pinTried('budi',false)
  at(T0+5*MIN+1);expect(pinPause('budi')).toBe(0)
  pinTried('budi',false);pinTried('budi',false)
  expect(pinPause('budi')).toBe(0) // two new tries, not five
  pinTried('budi',true)
  expect(store.get('takar-pin-tries')).toBe('{}')
  pinTried('budi',false);pinTried('budi',false)
  expect(pinPause('budi')).toBe(0)
  pinTried('budi',false)
  expect(pinPause('budi')).toBe(5*MIN)
 })
 it('forgets wrong tries older than five minutes: two today and one tomorrow do not pause',()=>{
  at(T0);pinTried('budi',false);pinTried('budi',false)
  at(T0+24*60*MIN);pinTried('budi',false)
  expect(pinPause('budi')).toBe(0)
 })
 it('survives unreadable storage',()=>{
  store.set('takar-pin-tries','not json');expect(pinPause('budi')).toBe(0)
  store.set('takar-pin-tries','null');pinTried('budi',false);expect(pinPause('budi')).toBe(0)
 })
})
describe('AUTH-11, AUTH-02, SYNC-07: a failed sign-in says what really happened',()=>{
 const wrong='PIN salah atau akun tidak aktif'
 it('a request that got no answer is the network, never a wrong PIN',()=>{
  // supabase-js: fetch failed (status 0) or the gateway answered 502-504.
  for(const e of [{name:'AuthRetryableFetchError',status:0,message:'Failed to fetch'},{name:'AuthRetryableFetchError',status:503,message:'{}'},{name:'AuthRetryableFetchError',message:'Load failed'}]){
   const said=signInError(e,wrong);expect([said.name,said.message]).toEqual(['Network',UNREACHABLE])}
  // PostgREST (bootstrap) when the request never left: an empty code.
  const said=signInError({message:'TypeError: Failed to fetch',code:''},wrong);expect([said.name,said.message]).toEqual(['Network',UNREACHABLE])
  expect(UNREACHABLE).toMatch(/Server tidak terjangkau/)
 })
 it('refused credentials are the only thing called wrong',()=>{
  for(const e of [{name:'AuthApiError',status:400,code:'invalid_credentials',message:'Invalid login credentials'},{message:'Invalid login credentials'}]){
   const said=signInError(e,wrong);expect([said.name,said.message]).toEqual(['Wrong',wrong])}
 })
 it('an account switched off, too many tries and anything else are named, in Indonesian',()=>{
  expect(signInError({code:'42501',message:'No active staff membership'},wrong).message).toBe('Akun ini tidak aktif. Hubungi pemilik restoran.')
  expect(signInError({name:'AuthApiError',status:400,code:'user_banned',message:'User is banned'},wrong).message).toBe('Akun ini tidak aktif. Hubungi pemilik restoran.')
  expect(signInError({name:'AuthApiError',status:429,code:'over_request_rate_limit',message:'Request rate limit reached'},wrong).message).toMatch(/^Terlalu banyak percobaan masuk/)
  const other=signInError({name:'AuthApiError',status:500,code:'unexpected_failure',message:'Database error granting user'},wrong)
  expect([other.name,other.message]).toEqual(['Error','Masuk gagal: Database error granting user'])
  for(const e of [{code:'42501',message:'No active staff membership'},{status:429,message:'x'},{status:500,message:'x'}])expect(signInError(e,wrong).name).not.toBe('Wrong')
 })
})
describe('SEC-2: the exports leave device ids out unless the person may see them',()=>{
 it('strips deviceId from every exported operation by default, in both exports, and keeps everything else',async()=>{
  const user=identity({role:'cashier'});const {db,commands}=await seed(user)
  await sale(commands)
  await synchronize(db,user,recorder().transport)
  await commands.cashMove(50000,'Tambah uang kembalian') // one more, still pending
  const stored=await db.outbox.orderBy('occurredAt').toArray()
  expect(stored.length).toBeGreaterThan(4)
  expect(stored.every(o=>o.deviceId===user.deviceId)).toBe(true)
  for(const recovery of [false,true]){
   const file=await exportData(db,recovery) as {outbox:Record<string,unknown>[]}
   expect(JSON.stringify(file)).not.toContain(user.deviceId)
   // PERF-2: the recovery file holds only what is unsent.
   expect(file.outbox.map(o=>o.id).sort()).toEqual(stored.filter(o=>!recovery||o.state!=='synced').map(o=>o.id).sort())
   for(const o of file.outbox)expect(Object.keys(o).sort()).toEqual(Object.keys(stored.find(s=>s.id===o.id)!).filter(k=>k!=='deviceId').sort())
  }
  // What stays on the device is untouched: the queue still carries the device id the server needs.
  expect((await db.outbox.toArray()).every(o=>o.deviceId===user.deviceId)).toBe(true)
 })
 it('keeps deviceId for an owner or manager, who read device ids anyway and may have to replay an operation',async()=>{
  const user=identity({role:'manager'});const {db,commands}=await seed(user)
  await sale(commands)
  for(const recovery of [false,true]){
   const file=await exportData(db,recovery,true) as {outbox:{deviceId?:string}[]}
   expect(file.outbox.length).toBeGreaterThan(0)
   expect(file.outbox.every(o=>o.deviceId===user.deviceId)).toBe(true)
  }
 })
})
describe('AUTH-07: whoever may approve with a PIN may set one',()=>{
 it('an admin is not refused as "Perlu akun manajer"; a cashier still is',async()=>{
  const admin=await seed(identity({role:'admin'})),cashier=await seed(identity({role:'cashier'}))
  await expect(cashier.commands.setPin('482915')).rejects.toThrow('Perlu akun manajer')
  await expect(admin.commands.setPin('482915')).rejects.not.toThrow('Perlu akun manajer') // the rest needs the server
 })
})
describe('SEC-6: the CSP allows the font face the build inlines',()=>{
 it('names a font-src with data:',async()=>{
  const headers=await (await import('node:fs/promises')).readFile(process.cwd()+'/public/_headers','utf8')
  expect(headers).toMatch(/Content-Security-Policy:.*font-src 'self' data:/)
 })
})
