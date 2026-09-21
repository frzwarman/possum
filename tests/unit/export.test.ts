import { describe,expect,it } from 'vitest'
import { identity,recorder,sale,seed,tick } from './offline-harness'
import { exportData } from '../../src/lib/db'
import { synchronize } from '../../src/lib/sync'
const SECRETS=/password|passphrase|secret|token|api[_-]?key|"key"|bearer|jwt|service[_-]?role|anon[_-]?key|credential/i
describe('export separation',()=>{
 it('splits the business export from the recovery export',async()=>{
  const user=identity();const {db,commands}=await seed(user)
  await sale(commands)
  await commands.cashMove(-50000,'Setor ke brankas');await tick()
  const business=await exportData(db,false) as Record<string,unknown[]>
  const recovery=await exportData(db,true) as Record<string,unknown[]>
  expect(business.scope).toBe('locally-available-only')
  expect(recovery.scope).toBe('unsynchronized-recovery')
  for(const table of ['menu','stock','settings','drafts','prints'])expect(business[table]).toBeDefined()
  for(const table of ['menu','stock','settings','drafts','prints'])expect(recovery[table]).toBeUndefined()
  for(const table of ['outbox','orders','shifts','movements','cash'])expect(recovery[table]).toBeDefined()
  expect(business.menu.length).toBeGreaterThan(0)
  expect(recovery.orders).toHaveLength(1)
  expect(recovery.cash).toHaveLength(1)
 })
 it('carries the outbox with operation ids that stay stable across exports',async()=>{
  const user=identity();const {db,commands}=await seed(user)
  await sale(commands)
  const pending=(await db.outbox.orderBy('occurredAt').toArray()).map(o=>o.id)
  const first=await exportData(db,true) as {outbox:{id:string;state:string;kind:string}[]}
  const second=await exportData(db,true) as {outbox:{id:string;state:string;kind:string}[]}
  expect(first.outbox.map(o=>o.id).sort()).toEqual(pending.slice().sort())
  expect(second.outbox.map(o=>o.id).sort()).toEqual(first.outbox.map(o=>o.id).sort())
  expect(first.outbox.every(o=>o.state==='pending')).toBe(true)
  // Draining the queue must not change the ids the server deduplicates on.
  await synchronize(db,user,recorder().transport)
  const third=await exportData(db,true) as {outbox:{id:string;state:string}[]}
  expect(third.outbox.map(o=>o.id).sort()).toEqual(pending.slice().sort())
  expect(third.outbox.every(o=>o.state==='synced')).toBe(true)
 })
 it('leaks no credential in either export',async()=>{
  const user=identity();const {db,commands}=await seed(user)
  await sale(commands)
  for(const recovery of [false,true]){
   const text=JSON.stringify(await exportData(db,recovery))
   expect(text).not.toMatch(SECRETS)
   expect(text).not.toContain('meja-identity')
   expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/) // a JWT would start like this
  }
 })
})
