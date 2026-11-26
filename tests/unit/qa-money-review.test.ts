// QA 2026-11-25, review of lane money: a manual discount's rule is checked on the till the way order.save checks it
// ('Invalid discount rule'), so a 10-digit "Potongan" never reaches the outbox and halts it.
import { describe,expect,it } from 'vitest'
import { draft,identity,line,seed,tick } from './offline-harness'

describe('QA money review: manual discount rule bounds',()=>{
 it('refuses a rule the server would refuse, before anything is queued',async()=>{
  const {db,commands}=await seed(identity({role:'owner',name:'Pemilik',demo:true}));await commands.openShift(200000);await tick()
  for(const rule of [{kind:'amount',value:10_000_000_000,scope:'order'},{kind:'percent',value:101,scope:'order'},{kind:'percent',value:12.5,scope:'order'},{kind:'amount',value:0,scope:'order'}] as const){
   await expect(commands.save(draft([line()],{discountRule:rule,discount:0,discountReason:'Komplain'}))).rejects.toThrow('Diskon manual tidak valid')}
  expect((await db.outbox.toArray()).filter(x=>x.kind==='order.save')).toHaveLength(0)
  const ok=await commands.save(draft([line()],{discountRule:{kind:'amount',value:1_000_000_000,scope:'order'},discount:0,discountReason:'Komplain'}));await tick()
  expect(ok.discount).toBe(ok.totals.subtotal)
 })
})
