// QA 2026-11-25, cluster discounts: what Commands.save and Commands.settings refuse or price before an operation is
// queued, mirroring order.save and settings.update in supabase/migrations/202611250001_qa_fixes.sql (checked by
// scripts/db-checks/qa-discounts.mjs). TILL-02 (a manual discount keeps its rule), DSC-2/TILL-05 (an approval covers
// up to its amount), TILL-06 (a reopened compliment), DSC-3 (100 saved discounts), SQL-16 (the reason's length).
import { describe,expect,it } from 'vitest'
import { draft,identity,line,seed,tea,tick } from './offline-harness'
import { DEMO_PIN } from '../../src/lib/commands'
import { defaultSettings } from '../../src/domain/sample'
import type { Discount,DiscountRule } from '../../src/domain/types'

const cashier=()=>seed(identity({role:'cashier',name:'Kasir Demo',demo:true}))
const ten:DiscountRule={kind:'percent',value:10,scope:'order'}
const vip:Discount={id:'vip',name:'Tamu VIP',note:'',kind:'percent',value:20,scope:'order',from:'2026-01-01',to:'2099-12-31',approval:true}

describe('QA discounts: a manual discount keeps its rule (TILL-02)',()=>{
 it('prices the rule on the lines, and a cashier needs the PIN only when the amount outgrows the approval',async()=>{
  const {db,commands}=await cashier();await commands.openShift(200000);await tick()
  const manual=(lines=[line()],over={})=>draft(lines,{discountRule:ten,discount:0,discountReason:'Pelanggan tetap',...over})
  await expect(commands.save(manual())).rejects.toThrow('Perlu persetujuan manajer')
  // Approved on two nasi (5.000), one taken off before the first save: 10% of what is left, under the same approval.
  const approval=await commands.approve('demo-manager',DEMO_PIN,'discount',{amount:5000})
  const o=await commands.save(manual([line()],{discountApproval:approval}));await tick()
  expect([o.discount,o.discountRule,o.discountApprovedBy,o.discountApproved,o.totals.subtotal]).toEqual([2500,ten,'Manajer Demo',5000,25000])
  expect((await db.outbox.toArray()).find(x=>x.kind==='order.save')?.payload.order).toMatchObject({discountRule:ten,discount:2500,discountApprovedBy:'Manajer Demo'})
  // Back to two nasi: 5.000 is what was approved, no new PIN. A third: 7.500 is more, so it asks again.
  const two=await commands.save(manual([...o.lines,line()],{orderId:o.id,revision:o.revision}));await tick()
  expect([two.discount,two.discountApproved,two.discountApprovedBy]).toEqual([5000,5000,'Manajer Demo'])
  await expect(commands.save(manual([...two.lines,line()],{orderId:o.id,revision:two.revision}))).rejects.toThrow('Perlu persetujuan manajer')
  const more=await commands.approve('demo-manager',DEMO_PIN,'discount',{amount:7500})
  const three=await commands.save(manual([...two.lines,line()],{orderId:o.id,revision:two.revision,discountApproval:more}));await tick()
  expect([three.discount,three.discountApproved]).toEqual([7500,7500])
  // Another rule is another discount, even for less.
  await expect(commands.save(manual(three.lines,{orderId:o.id,revision:three.revision,discountRule:{kind:'percent',value:5,scope:'order'}}))).rejects.toThrow('Perlu persetujuan manajer')
 })
 it('a rupiah rule approved on a bigger order asks again once the order shrinks, never when it grows',async()=>{
  const {commands}=await cashier();await commands.openShift(200000);await tick()
  const rp:DiscountRule={kind:'amount',value:20000,scope:'order'}
  const manual=(lines:ReturnType<typeof line>[],over={})=>draft(lines,{discountRule:rp,discount:0,discountReason:'Komplain',...over})
  const four=[line(),line(),line(),line()]
  const o=await commands.save(manual(four,{discountApproval:await commands.approve('demo-manager',DEMO_PIN,'discount',{amount:20000})}));await tick()
  const six=await commands.save(manual([...o.lines,line(),line()],{orderId:o.id,revision:o.revision}));await tick()
  expect([six.discount,six.totals.subtotal]).toEqual([20000,150000])
  await expect(commands.save(manual(o.lines,{orderId:o.id,revision:six.revision}))).rejects.toThrow('Perlu persetujuan manajer')
 })
 it('a drinks-only rule takes nothing off a cart with no drink left, and needs nobody for that',async()=>{
  const {commands}=await seed(identity());await commands.openShift(200000);await tick()
  const drinks:DiscountRule={kind:'percent',value:50,scope:'beverage'}
  const o=await commands.save(draft([line(),tea()],{discountRule:drinks,discount:0,discountReason:'Acara'}));await tick()
  expect(o.discount).toBe(3000)
  const food=await commands.save(draft([o.lines[0]],{orderId:o.id,revision:o.revision,discountRule:drinks,discount:0,discountReason:'Acara'}))
  expect([food.discount,food.totals.subtotal,food.discountApprovedBy]).toEqual([0,25000,'Siti'])
 })
 it('caps a manual reason at the 60 characters the dialog allows (SQL-16)',async()=>{
  const {commands}=await seed(identity());await commands.openShift(200000);await tick()
  await expect(commands.save(draft([line()],{discount:1000,discountReason:'x'.repeat(61)}))).rejects.toThrow('60')
  expect((await commands.save(draft([line()],{discount:1000,discountReason:'x'.repeat(60)}))).discount).toBe(1000)
 })
})

describe('QA discounts: a saved discount that needs a PIN (DSC-2, TILL-05)',()=>{
 it('is covered up to the approved amount, and asks again only above it',async()=>{
  const {db,commands}=await cashier();await db.settings.put({...defaultSettings,discounts:[vip]});await commands.openShift(200000);await tick()
  const withVip=(lines:ReturnType<typeof line>[],over={})=>draft(lines,{discountId:'vip',discount:0,discountReason:'Tamu VIP',...over})
  await expect(commands.save(withVip([line()]))).rejects.toThrow('Perlu persetujuan manajer')
  // Approved on two nasi (10.000), one taken off before the first save.
  const o=await commands.save(withVip([line()],{discountApproval:await commands.approve('demo-manager',DEMO_PIN,'discount',{amount:10000})}));await tick()
  expect([o.discount,o.discountApproved,o.discountApprovedBy]).toEqual([5000,10000,'Manajer Demo'])
  const two=await commands.save(withVip([...o.lines,line()],{orderId:o.id,revision:o.revision}));await tick()
  expect([two.discount,two.discountApprovedBy]).toEqual([10000,'Manajer Demo'])
  await expect(commands.save(withVip([...two.lines,line()],{orderId:o.id,revision:two.revision}))).rejects.toThrow('Perlu persetujuan manajer')
  const three=await commands.save(withVip([...two.lines,line()],{orderId:o.id,revision:two.revision,discountApproval:await commands.approve('demo-manager',DEMO_PIN,'discount',{amount:15000})}));await tick()
  expect([three.discount,three.discountApproved]).toEqual([15000,15000])
  expect((await db.outbox.toArray()).filter(x=>x.kind==='order.save'&&x.payload.approval).length).toBe(2)
 })
 it('an order approved before this fix (no discountApproved) keeps its approver whatever the amount, as the server does',async()=>{
  const {db,commands}=await cashier();await db.settings.put({...defaultSettings,discounts:[vip]});await commands.openShift(200000);await tick()
  const o=await commands.save(draft([line()],{discountId:'vip',discount:0,discountReason:'Tamu VIP',discountApproval:await commands.approve('demo-manager',DEMO_PIN,'discount',{amount:5000})}));await tick()
  await db.orders.update(o.id,{discountApproved:undefined})
  const two=await commands.save(draft([...o.lines,line()],{orderId:o.id,revision:o.revision,discountId:'vip',discount:0,discountReason:'Tamu VIP'}))
  expect([two.discount,two.discountApprovedBy]).toEqual([10000,'Manajer Demo'])
 })
})

describe('QA discounts: Commands.settings (DSC-3)',()=>{
 it('refuses the 101st saved discount, which the server would reject and halt the outbox on',async()=>{
  const {commands}=await seed(identity())
  const many=(n:number):Discount[]=>Array.from({length:n},(_,i)=>({id:`d${i}`,name:`Promo ${i}`,note:'',kind:'percent',value:10,scope:'order',from:'2026-01-01',to:'2026-01-02'}))
  await commands.settings({...defaultSettings,discounts:many(100)})
  await expect(commands.settings({...defaultSettings,discounts:many(101)})).rejects.toThrow('100 diskon')
 })
})
