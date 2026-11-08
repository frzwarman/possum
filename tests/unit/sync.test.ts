import { afterEach,describe,expect,it,vi } from 'vitest'
import { boom,draft,identity,line,recorder,sale,seed,tea,tick } from './offline-harness'
import { synchronize } from '../../src/lib/sync'
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
