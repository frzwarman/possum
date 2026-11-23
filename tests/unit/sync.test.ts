import { afterEach,describe,expect,it,vi } from 'vitest'
import { boom,draft,identity,line,recorder,sale,seed,tea,tick } from './offline-harness'
import { SESSION_GONE,serverTransport,signInAgain,synchronize } from '../../src/lib/sync'
import { logout } from '../../src/app/context'
// serverTransport and logout talk to Supabase: a stand-in client whose session and RPC answers each test sets.
type Answer={data:unknown;error:{code:string;message:string}|null}
const server=vi.hoisted(()=>({session:null as {user:{id:string}}|null,error:null as unknown,signOuts:[] as unknown[],accounts:{} as Record<string,{password:string;id:string}>,rpc:async(_name:string):Promise<Answer>=>({data:null,error:{code:'PGRST000',message:'Failed to fetch'}})}))
vi.mock('../../src/lib/supabase',()=>({configured:true,telegramBot:'',supabase:{rpc:(name:string)=>server.rpc(name),auth:{getSession:async()=>({data:{session:server.session},error:server.error}),
 signInWithPassword:async({email,password}:{email:string;password:string})=>{const a=server.accounts[email];if(a?.password!==password)return {data:{user:null,session:null},error:{message:'Invalid login credentials'}};server.session={user:{id:a.id}};server.error=null;return {data:{user:{id:a.id},session:server.session},error:null}},
 signOut:async(options:unknown)=>{server.signOuts.push(options);server.session=null;return {error:null}}}}}))
afterEach(()=>vi.useRealTimers())
// Only Date is faked: Dexie and fake-indexeddb still need real timers to settle.
const at=async(when:number,run:()=>Promise<unknown>)=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(when);try{await run()}finally{vi.useRealTimers()}}
describe('idempotent replay',()=>{
 it('does not resend an operation that already synced, and creates no local duplicate',async()=>{
  const user=identity();const {db,commands}=await seed(user)
  const order=await sale(commands)
  const {sent,transport}=recorder()
  await synchronize(db,user,transport)
  expect(sent.map(o=>o.kind)).toEqual(['shift.open','order.save','order.prepare','payment.record'])
  expect(await db.outbox.where('state').equals('synced').count()).toBe(4)
  expect((await db.meta.get('lastSync'))?.value).toBeTruthy()
  await synchronize(db,user,transport)
  await synchronize(db,user,transport)
  expect(sent).toHaveLength(4)
  expect(await db.orders.count()).toBe(1)
  expect(await db.movements.where('recordId').equals(order.id).count()).toBe(2)
  expect((await db.orders.get(order.id))!.payment).toBeDefined()
  expect(new Set(sent.map(o=>o.id)).size).toBe(4)
 })
})
describe('interrupted acknowledgment',()=>{
 it('keeps the operation pending, resends the same id, and never duplicates local state',async()=>{
  const user=identity();const {db,commands}=await seed(user)
  const order=await sale(commands)
  // The server commits, then the connection dies before the receipt comes back.
  const committed:string[]=[]
  const {sent,transport}=recorder((op,call)=>{committed.push(op.id);if(call===1)throw boom('socket hang up','Network')})
  await synchronize(db,user,transport)
  expect(sent).toHaveLength(1)
  const first=await db.outbox.get(sent[0].id)
  expect(first!.state).toBe('pending')
  expect(first!.attempts).toBe(1)
  expect(first!.error).toBe('socket hang up')
  expect(first!.nextAttempt).toBeGreaterThan(Date.now())
  await synchronize(db,user,transport) // backoff has not elapsed
  expect(sent).toHaveLength(1)
  await at(Date.now()+600000,()=>synchronize(db,user,transport) as Promise<unknown>)
  expect(sent.map(o=>o.kind)).toEqual(['shift.open','shift.open','order.save','order.prepare','payment.record'])
  expect(sent[0].id).toBe(sent[1].id) // the server can deduplicate on this
  expect(committed.filter(id=>id===sent[0].id)).toHaveLength(2)
  expect(await db.outbox.where('state').equals('pending').count()).toBe(0)
  expect(await db.orders.count()).toBe(1)
  expect((await db.orders.get(order.id))!.payment?.method).toBe('cash')
  expect(await db.movements.where('recordId').equals(order.id).count()).toBe(2)
  expect(await db.shifts.count()).toBe(1)
 })
})
describe('backoff and rejection',()=>{
 it('grows the delay with each failed attempt and stays pending',async()=>{
  const user=identity();const {db,commands}=await seed(user)
  await commands.openShift(200000);await tick()
  const {sent,transport}=recorder(()=>{throw boom('Failed to fetch','Network')})
  const delays:number[]=[]
  for(const step of [0,1,2]){
   await at(Date.now()+step*600000,()=>synchronize(db,user,transport) as Promise<unknown>)
   const op=(await db.outbox.toArray())[0]
   expect(op.state).toBe('pending')
   expect(op.attempts).toBe(step+1)
   delays.push(op.nextAttempt)
  }
  expect(sent).toHaveLength(3)
  expect(delays[1]-600000).toBeGreaterThan(delays[0])
  expect(delays[2]-1200000).toBeGreaterThan(delays[1]-600000)
 })
 it('marks a rejected operation and refuses to sync later operations past it',async()=>{
  const user=identity();const {db,commands}=await seed(user)
  await commands.openShift(200000);await tick()
  await commands.save(draft([line(),tea()]));await tick()
  const first=recorder(()=>{throw boom('Operation ID reused with different payload','Rejected')})
  await synchronize(db,user,first.transport)
  expect(first.sent).toHaveLength(1)
  const rejected=(await db.outbox.where('state').equals('rejected').toArray())[0]
  expect(rejected.kind).toBe('shift.open')
  expect(rejected.error).toBe('Operation ID reused with different payload')
  expect(await db.outbox.where('state').equals('pending').count()).toBe(1)
  // A rejected dependency is a hard stop: the queued order.save must not jump ahead of it.
  const second=recorder()
  await at(Date.now()+600000,()=>synchronize(db,user,second.transport) as Promise<unknown>)
  expect(second.sent).toHaveLength(0)
  expect(await db.outbox.where('state').equals('pending').count()).toBe(1)
  expect(await db.outbox.where('state').equals('synced').count()).toBe(0)
 })
 it('refuses to drain operations belonging to another account',async()=>{
  const user=identity();const {db,commands}=await seed(user)
  await commands.openShift(200000);await tick()
  const {sent,transport}=recorder()
  await expect(synchronize(db,{...user,id:'kasir-lain'},transport)).rejects.toThrow('Operasi milik akun lain dikunci')
  expect(sent).toHaveLength(0)
 })
 it('never reaches the network in demo mode',async()=>{
  const user=identity({demo:true});const {db,commands}=await seed(user)
  await commands.openShift(200000);await tick()
  const {sent,transport}=recorder()
  await synchronize(db,user,transport)
  expect(sent).toHaveLength(0)
  expect(await db.outbox.where('state').equals('pending').count()).toBe(1)
 })
})
// The server sees whoever holds this device's session, or anon without one, and both answer 42501: that is no verdict
// on the operation, and a rejected one would stop the till's queue for good.
describe('a session that is gone, stale or someone else\'s',()=>{
 const puller=async()=>({now:new Date().toISOString(),orders:[],shifts:[],cash:[],movements:[],counts:[]})
 const refused=(message:string):Answer=>({data:null,error:{code:'42501',message}})
 async function queued(){const user=identity();const {db,commands}=await seed(user);await commands.openShift(200000);await tick();return {user,db,op:(await db.outbox.toArray())[0]}}
 it('keeps the operation pending, sends nothing, and sends it once this person signs in again',async()=>{
  const {user,db,op}=await queued()
  const sent:string[]=[];server.session=null;server.error=null;server.rpc=async name=>{sent.push(name);return refused('permission denied for function apply_operation')}
  await synchronize(db,user,serverTransport,puller)
  expect([(await db.outbox.get(op.id))!.state,(await db.outbox.get(op.id))!.error,sent]).toEqual(['pending',SESSION_GONE,[]])
  // Another account holds the session (signed in at /admin, say): the server would answer "Authenticated actor mismatch".
  server.session={user:{id:'pemilik'}}
  await at(Date.now()+600000,()=>synchronize(db,user,serverTransport,puller) as Promise<unknown>)
  expect([(await db.outbox.get(op.id))!.state,sent]).toEqual(['pending',[]])
  server.session={user:{id:user.id}};server.rpc=async name=>{sent.push(name);return {data:{receivedAt:new Date().toISOString()},error:null}}
  await at(Date.now()+1200000,()=>synchronize(db,user,serverTransport,puller) as Promise<unknown>)
  expect([(await db.outbox.get(op.id))!.state,sent]).toEqual(['synced',['apply_operation']])
 })
 it('waits, without asking anyone to sign in, while an expired session cannot be refreshed offline',async()=>{
  const {user,db,op}=await queued()
  server.session=null;server.error={name:'AuthRetryableFetchError',message:'Failed to fetch'};server.rpc=async()=>refused('permission denied for function apply_operation')
  await synchronize(db,user,serverTransport,puller)
  const after=(await db.outbox.get(op.id))!
  expect(after.state).toBe('pending')
  expect(after.error).not.toBe(SESSION_GONE)
 })
 it('takes no 42501 as a verdict when the session went away while the call was out',async()=>{
  const {user,db,op}=await queued()
  server.session={user:{id:user.id}};server.error=null;server.rpc=async()=>{server.session=null;return refused('permission denied for function apply_operation')}
  await synchronize(db,user,serverTransport,puller)
  expect([(await db.outbox.get(op.id))!.state,(await db.outbox.get(op.id))!.error]).toEqual(['pending',SESSION_GONE])
 })
 it('signing in again as the same person keeps the queue and sends it at once, past its back-off',async()=>{
  const {user,db,op}=await queued()
  server.session=null;server.error=null;server.accounts={'siti@takar.id':{password:'482915',id:user.id},'adit@takar.id':{password:'111111',id:'adit'}}
  await synchronize(db,user,serverTransport,puller)
  expect((await db.outbox.get(op.id))!.nextAttempt).toBeGreaterThan(Date.now())
  expect(await signInAgain(db,user,'siti@takar.id','000000')).toBe(false)
  expect(await signInAgain(db,user,'adit@takar.id','111111')).toBe(false) // someone else's login is no way back in
  expect(await signInAgain(db,user,'siti@takar.id','482915')).toBe(true)
  server.rpc=async()=>({data:{receivedAt:new Date().toISOString()},error:null})
  await synchronize(db,user,serverTransport,puller)
  expect((await db.outbox.get(op.id))!.state).toBe('synced')
 })
 it('still rejects what the server refuses this person, signed in as themselves',async()=>{
  const {user,db,op}=await queued()
  server.session={user:{id:user.id}};server.error=null;server.rpc=async()=>refused('Manager permission required')
  await synchronize(db,user,serverTransport,puller)
  expect([(await db.outbox.get(op.id))!.state,(await db.outbox.get(op.id))!.error]).toEqual(['rejected','Manager permission required'])
 })
})
describe('signing out',()=>{
 afterEach(()=>vi.unstubAllGlobals())
 it('ends only this device\'s session (the same person stays in on the laptop) and leaves no PIN hash behind',async()=>{
  // Node's own localStorage shadows jsdom's and has no methods (as in books.test.ts); jsdom cannot navigate.
  const kept=new Map([['takar-pin-hash','sidik-pin'],['meja-identity','{}']]),went:string[]=[]
  vi.stubGlobal('localStorage',{getItem:(k:string)=>kept.get(k)??null,setItem:(k:string,v:string)=>void kept.set(k,v),removeItem:(k:string)=>void kept.delete(k)})
  vi.stubGlobal('location',{assign:(to:string)=>void went.push(to)})
  server.signOuts=[]
  await logout()
  expect(server.signOuts).toEqual([{scope:'local'}])
  expect([...kept.keys(),...went]).toEqual(['/'])
 })
})
describe('pull: what other paired devices did', () => {
  const empty = (now: string) => ({ now, device: { mode: 'pos', enrolled: true, primary: true }, orders: [], shifts: [], cash: [], movements: [], counts: [] })
  it('merges pulled records, never double counts a movement it already has, and skips a record with a pending local change', async () => {
    const user = identity()
    const { db, commands } = await seed(user)
    const order = await sale(commands)
    await db.meta.put({ id: 'pullCursor', value: new Date().toISOString() })
    const { transport } = recorder()
    await synchronize(db, user, transport, async () => empty(new Date().toISOString()))
    const mine = await db.movements.where('recordId').equals(order.id).toArray()
    await commands.closeShift(200000) // pending until the next push: the server's older copy must not win
    const other = { ...order, id: 'order-from-server', label: 'Pager 99', shiftId: 'shift-elsewhere' }
    const pulled = { ...empty(new Date().toISOString()), orders: [other, { ...order, label: 'SERVER' }], movements: mine.map((m) => ({ ...m, cost: 0 })) }
    const since: string[] = []
    await synchronize(db, user, async () => { throw boom('Failed to fetch', 'Network') }, async (s) => { since.push(s); return pulled })
    expect(await db.movements.where('recordId').equals(order.id).count()).toBe(mine.length)
    expect((await db.orders.get('order-from-server'))?.label).toBe('Pager 99')
    expect((await db.orders.get(order.id))?.label).toBe('SERVER')
    expect((await db.meta.get('pullCursor'))?.value).toBe(pulled.now)
    expect(Date.parse(pulled.now) - Date.parse(since[0])).toBeGreaterThanOrEqual(10000) // overlap covers a write that committed after an earlier pull
    const [closed] = await db.shifts.toArray()
    await synchronize(db, user, async () => { throw boom('Failed to fetch', 'Network') }, async () => ({ ...empty(new Date().toISOString()), shifts: [{ ...closed, status: 'open', opening: 1 }] }))
    expect([(await db.shifts.get(closed.id))?.opening, (await db.shifts.get(closed.id))?.status]).toEqual([200000, 'closed'])
  })
  it('replaces the catalog from the server unless a local publish is still waiting', async () => {
    const user = identity()
    const { db, commands } = await seed(user)
    await db.meta.put({ id: 'pullCursor', value: new Date().toISOString() })
    const catalog = { menu: [{ ...(await db.menu.get('es-teh'))!, price: 7000, version: 2 }], stock: await db.stock.toArray() }
    await synchronize(db, user, recorder().transport, async () => ({ ...empty(new Date().toISOString()), catalog }))
    expect([await db.menu.count(), (await db.menu.get('es-teh'))?.price]).toEqual([1, 7000])
    await commands.publish([{ ...(await db.menu.get('es-teh'))!, price: 8000, version: 3 }], await db.stock.toArray())
    await synchronize(db, user, async () => { throw boom('Failed to fetch', 'Network') }, async () => ({ ...empty(new Date().toISOString()), catalog }))
    expect((await db.menu.get('es-teh'))?.price).toBe(8000)
  })
  it('does not pull before the first bootstrap set a cursor', async () => {
    const user = identity()
    const { db, commands } = await seed(user)
    await commands.openShift(200000)
    let pulls = 0
    await synchronize(db, user, recorder().transport, async () => { pulls++; return empty(new Date().toISOString()) })
    expect(pulls).toBe(0)
    // an installation upgraded in place gets a cursor now, so it pulls from the next tick on
    expect((await db.meta.get('pullCursor'))?.value).toBeTruthy()
  })
})
