import { beforeEach, describe, expect, it, vi } from 'vitest'
import { balances, journal, sumMoves, type Books } from '../../src/domain/accounting'
import { businessDay } from '../../src/domain/calculate'
import type { MenuItem, Movement } from '../../src/domain/types'
import { carryTo, localBooks } from '../../src/features/accounting/books'
import { MejaDB } from '../../src/lib/db'

// Ten weeks of a small store: rice bought at changing prices and used every few days, a sale, a shift.
const dayOf=(iso:string)=>businessDay(iso),at=(day:string)=>`${day}T05:00:00.000Z`
const m=(id:string,kind:Movement['kind'],qty:number,day:string,cost=0):Movement=>({id,stockId:'rice',kind,qty,at:at(day),recordId:id,cost,reason:'x',actor:'u'})
const movements=[m('1','opening',2000,'2026-09-16',18000),m('2','preparation',-700,'2026-09-20'),m('3','purchase',5000,'2026-09-28',55000),m('4','preparation',-900,'2026-10-03'),m('5','waste',-333,'2026-10-17'),
 m('6','purchase',3000,'2026-10-30',39000),m('7','preparation',-1250,'2026-11-02'),m('8','count',-77,'2026-11-05'),m('9','preparation',-400,'2026-11-12')]
const sale={id:'o',receiptId:'o',mode:'dinein',status:'paid',cashier:'Sari',createdAt:at('2026-10-03'),lines:[{itemId:'nasi',name:'Nasi',qty:1,price:30000,cancelled:false,recipe:[],modifiers:[]}],totals:{subtotal:30000,discount:0,service:0,tax:3000,total:33000},payment:{method:'cash',at:at('2026-10-03'),tendered:33000,change:0,verified:true}} as Books['orders'][number]
const menu=[{id:'nasi',name:'Nasi',category:'Makanan',type:'food'}] as MenuItem[]
const calls:string[]=[]
const load=async(from:string,to:string):Promise<Books>=>{calls.push(`${from}..${to}`);return {orders:[sale],...sumMoves(movements,new Set(),{from,to,dayOf}),costs:{},shifts:[],opened:[{at:at('2026-10-03'),opening:100000,prior:0}],cash:[],purchaseOrders:[],salesOrders:[],entries:[]}}

describe('carrying the books forward',()=>{
 // Node's own experimental localStorage shadows jsdom's and has no methods; the page only needs these three.
 const kept=new Map<string,string>()
 beforeEach(()=>{kept.clear();calls.length=0;vi.stubGlobal('localStorage',{getItem:(k:string)=>kept.get(k)??null,setItem:(k:string,v:string)=>void kept.set(k,v),removeItem:(k:string)=>void kept.delete(k)})})
 it('walks history a month at a time and arrives where one long stretch does',async()=>{
  const whole=await carryTo(load,menu,dayOf,'2026-09-15','2026-11-10','2026-11-20')
  expect(calls).toEqual(['2026-09-15..2026-11-09'])
  calls.length=0
  const stepped=await carryTo(load,menu,dayOf,'2026-09-15','2026-11-10','2026-11-20','marks')
  expect(calls).toEqual(['2026-09-15..2026-09-30','2026-10-01..2026-10-31','2026-11-01..2026-11-09'])
  expect(stepped).toEqual(whole)
  // 2 kg at 18.000 less 700 g, plus 5 kg for 55.000, and so on: what is left is worth what the ledger says.
  expect(stepped.stock.rice[0]).toBe(2000-700+5000-900-333+3000-1250-77)
  expect(stepped.balances.inventory).toBe(stepped.stock.rice[1])
  expect(stepped.balances).toMatchObject({food:-30000,tax:-3000,cash:133000,outside:-194000,equity:-18000})
  expect(Object.values(stepped.balances).reduce((n,v)=>n+v,0)).toBe(0)
 })
 it('keeps finished months on the laptop and starts from the newest one before the range',async()=>{
  const first=await carryTo(load,menu,dayOf,'2026-09-15','2026-11-10','2026-11-20','marks')
  expect(Object.keys(JSON.parse(localStorage.getItem('marks')!))).toEqual(['2026-09-30','2026-10-31'])
  calls.length=0
  expect(await carryTo(load,menu,dayOf,'2026-09-15','2026-11-10','2026-11-20','marks')).toEqual(first)
  expect(calls).toEqual(['2026-11-01..2026-11-09'])
  calls.length=0
  await carryTo(load,menu,dayOf,'2026-09-15','2026-10-01','2026-11-20','marks')
  await carryTo(load,menu,dayOf,'2026-09-15','2026-10-20','2026-11-20','marks')
  expect(calls).toEqual(['2026-10-01..2026-10-19'])
  // A range that starts before the store did has nothing to carry; a month that ended yesterday is not kept yet.
  calls.length=0
  expect((await carryTo(load,menu,dayOf,'2026-09-15','2026-09-01','2026-11-20','marks')).balances.cash).toBe(0)
  kept.clear()
  await carryTo(load,menu,dayOf,'2026-09-15','2026-11-02','2026-11-01','marks')
  expect(Object.keys(JSON.parse(localStorage.getItem('marks')!))).toEqual(['2026-09-30'])
 })
 it('keeps a month only once the server can no longer take an operation dated in it',async()=>{
  // October is opened on Nov 3. On Nov 4 a till that was offline sends a Rp100.000 QRIS sale from Oct 31: the server takes one up to 7 days late.
  let synced=false
  const late={...sale,id:'late',receiptId:'late',lines:[{...sale.lines[0],price:100000}],totals:{subtotal:100000,discount:0,service:0,tax:0,total:100000},payment:{...sale.payment!,method:'qris',at:at('2026-10-31'),tendered:100000}} as Books['orders'][number]
  const till=async(from:string,to:string):Promise<Books>=>({...await load(from,to),orders:synced?[late]:[]})
  const qris=async(today:string)=>(await carryTo(till,menu,dayOf,'2026-10-01','2026-11-01',today,'marks')).balances.qris
  expect(await qris('2026-11-03')).toBe(0)
  synced=true
  expect(await qris('2026-11-04')).toBe(100000)
  expect(await qris('2026-11-07')).toBe(100000)
  expect(localStorage.getItem('marks')).toBeNull()
  expect(await qris('2026-11-08')).toBe(100000)
  expect(Object.keys(JSON.parse(localStorage.getItem('marks')!))).toEqual(['2026-10-31'])
 })
 it('prices a finished month on this device with what was known when it ended',async()=>{
  // Go-live month: 10 kg of rice comes in as Saldo awal without a price, 2 kg is used, 5 kg is bought for Rp60.000. In January rice costs Rp20.
  const db=new MejaDB(`books-${Date.now()}`),nov={from:'2026-11-01',to:'2026-11-30',dayOf}
  await db.movements.bulkPut([m('a','opening',10000,'2026-11-01'),m('b','preparation',-2000,'2026-11-05'),m('c','purchase',5000,'2026-11-10',60000),m('d','purchase',1000,'2027-01-05',20000)])
  const books=await localBooks(db,nov)
  expect(books.costs).toEqual({rice:12})
  expect(balances(journal(books,menu,nov).entries)).toMatchObject({cogs:24000,inventory:156000,equity:-120000})
  db.close()
 })
})
