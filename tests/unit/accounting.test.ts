import { describe, expect, it } from 'vitest'
import { balances, cashbook, itemSales, journal, ledger, openings, payables, position, profit, recap, stockLedger, sumMoves, valuation, zero, type BookOrder, type Books, type CashEntry, type Move, type Range, type Stock } from '../../src/domain/accounting'
import { businessDay, complimentDiscount, totals } from '../../src/domain/calculate'
import type { MenuItem, Movement, OrderPayment, PurchaseOrder, Shift } from '../../src/domain/types'

// Two business days in Jakarta. Day one: a discounted cash sale, a QRIS sale, a staff meal paid in cash, deliveries.
// Day two: the QRIS sale is refunded, a family compliment, waste, a count, a supplier payment, drawer cash, a short drawer.
const D1='2026-11-10',D2='2026-11-11',at1='2026-11-10T05:00:00.000Z',at2='2026-11-11T05:00:00.000Z'
const range:Range={from:D1,to:D2,dayOf:iso=>businessDay(iso)}
const rates={taxBps:1000,serviceBps:500}
const menu=[{id:'nasi',name:'Nasi goreng',category:'Makanan',type:'food'},{id:'teh',name:'Es teh',category:'Minuman',type:'beverage'}] as MenuItem[]
const nasi=(qty:number)=>({itemId:'nasi',name:'Nasi goreng',qty,price:30000,cancelled:false,recipe:[{stockId:'rice',qty:200}],modifiers:[]})
const teh=(qty:number)=>({itemId:'teh',name:'Es teh',qty,price:10000,cancelled:false,recipe:[{stockId:'tea',qty:10}],modifiers:[]})
const pay=(method:OrderPayment['method'],at:string):OrderPayment=>({method,at,tendered:0,change:0,verified:true})
const order=(id:string,lines:BookOrder['lines'],discount:number,method:OrderPayment['method'],at:string,more:Partial<BookOrder>={}):BookOrder=>({id,receiptId:id,mode:'dinein',status:'paid',cashier:'Sari',createdAt:at,lines,totals:totals(lines,discount,more.mode==='compliment'?{taxBps:0,serviceBps:0}:rates),payment:pay(method,at),...more})
const staffMeal=[nasi(1),teh(1)]
const orders:BookOrder[]=[
 order('a',[nasi(2),teh(1)],7000,'cash',at1),
 order('b',[teh(1)],0,'qris',at1,{status:'refunded',refund:{reason:'Salah pesan',at:at2,actor:'u'}}),
 order('c',staffMeal,complimentDiscount(staffMeal,'staff',l=>l.itemId==='teh'),'cash',at1,{mode:'compliment'}),
 order('d',[teh(1)],10000,'none',at2,{mode:'compliment'}),
 order('old',[nasi(9)],0,'cash','2026-11-01T05:00:00.000Z'),
]
const move=(day:string,stockId:string,kind:Move['kind'],qty:number,cost=0,comp=false):Move=>({day,stockId,kind,comp,qty,cost})
const po={id:'po1',number:'PO-1',supplier:'Toko Beras',status:'received',lines:[],total:50000,note:'',revision:2,createdAt:at1,updatedAt:at2,
 receipts:[{at:at1,lines:[{stockId:'rice',qty:5000,cost:50000}]}],payments:[{at:at2,amount:20000,from:'outside'}]} as PurchaseOrder
const shift={id:'s1',actor:'u',cashier:'Sari',openedAt:at1,expiresAt:at2,opening:20000,status:'closed',closedAt:at2,counted:99000,expected:100000,variance:-1000} as Shift
// 1 kg of rice was on hand at Rp8 per gram-thousandth; tea and sugar arrive for the first time.
const before:Stock={rice:[1000,8000,8]}
const books:Books={orders,costs:{rice:10,tea:5},opening:{rice:1000},shifts:[shift],opened:[{at:at1,opening:20000,prior:0}],salesOrders:[],purchaseOrders:[po],entries:[],
 moves:[move(D1,'rice','preparation',-400),move(D1,'rice','preparation',-200,0,true),move(D1,'tea','preparation',-20),move(D1,'tea','preparation',-10,0,true),
  move(D1,'rice','purchase',5000,50000),move(D1,'tea','purchase',1000,6000),move(D1,'sugar','purchase',100,900),
  move(D2,'rice','waste',-100),move(D2,'tea','count',-30),move(D2,'tea','preparation',-10,0,true)],
 cash:[{id:'c1',shiftId:'s1',amount:-6000,reason:'Pembelian: teh',at:at1,actor:'u',recordId:'c1'},{id:'c2',shiftId:'s1',amount:-5000,reason:'Parkir',at:at2,actor:'u'},{id:'c3',shiftId:'s1',amount:10000,reason:'Tambah modal',at:at2,actor:'u'}]}
const empty={...books,orders:[],moves:[],purchaseOrders:[],shifts:[],opened:[],cash:[],opening:{},costs:{}}

describe('accounting',()=>{
 it('recaps each business day so that what was received equals the payment methods',()=>{
  const [one,two]=recap(orders,range)
  expect(one).toMatchObject({day:D1,orders:2,gross:80000,discount:7000,net:73000,service:3650,tax:7665,total:84315,staff:15000,compliments:25000,refunds:0,cash:87765,qris:11550,card:0,received:99315})
  expect(two).toMatchObject({day:D2,orders:0,refunds:11550,qris:-11550,compliments:10000,received:-11550})
  for(const d of [one,two])expect(d.cash+d.qris+d.card).toBe(d.received)
 })
 it('values stock at its moving average: deliveries join at what was paid, what leaves goes at the average',()=>{
  const {stock,worth}=valuation(books,before)
  // Rice: 1.000 at 8.000 plus 5.000 for 50.000 is 6.000 worth 58.000, so 400 used is 3.867 and not the 4.000 of the latest price.
  expect(worth.get(books.moves[0])).toBe(-3867)
  expect(stock.rice.slice(0,2)).toEqual([5300,51233])
  expect(stock.tea).toEqual([930,5580,6])
  expect(stock.sugar).toEqual([100,900,9])
  expect([...worth.values()].reduce((n,v)=>n+v,0)).toBe(51233+5580+900-8000)
 })
 it('gives a batch made in-house the worth of what went into it',()=>{
  const moves=[move(D1,'rice','production',-300),move(D1,'sambal','production',10,1000),move(D1,'kerupuk','production',20,3000)]
  const {stock}=valuation({moves,opening:{rice:1000},costs:{}},before)
  expect(stock.rice.slice(0,2)).toEqual([700,5600])
  expect(stock.sambal).toEqual([10,600,60])
  expect(stock.kerupuk).toEqual([20,1800,90])
  expect(journal({...empty,moves,opening:{rice:1000}},menu,range,before).entries).toEqual([])
 })
 it('books stock that was there before Takar saw it, and the price change on a stock that ran below zero',()=>{
  const seen=journal({...empty,opening:{salt:500},costs:{salt:2}},menu,range)
  expect(seen.stock.salt).toEqual([500,1000,2])
  expect(balances(seen.entries)).toMatchObject({inventory:1000,equity:-1000})
  const short=journal({...empty,opening:{x:-10},moves:[move(D1,'x','purchase',100,600)]},menu,range,{x:[-10,-50,5]})
  expect(short.stock.x).toEqual([90,540,6])
  expect(balances(short.entries)).toMatchObject({inventory:590,outside:-600,shrink:10})
 })
 it('lists sales per menu item that add up to the gross sales, with ingredient cost at the average',()=>{
  const {stock}=valuation(books,before),items=itemSales(orders,menu,range,stock)
  expect(items.map(i=>[i.name,i.type,i.qty,i.gross,Math.round(i.cost),i.known])).toEqual([['Nasi goreng','food',2,60000,3867,true],['Es teh','beverage',2,20000,120,true]])
  expect(items.reduce((n,i)=>n+i.gross,0)).toBe(recap(orders,range).reduce((n,d)=>n+d.gross,0))
  expect(itemSales(orders,menu,range,{})[0].known).toBe(false)
 })
 it('carries stock from opening to closing with what it was and is worth',()=>{
  const {stock,unseen}=valuation(books,before),rows=stockLedger(books,[{id:'rice',name:'Beras',unit:'g'},{id:'tea',name:'Teh',unit:'g'}],before,stock,unseen)
  expect(rows.find(r=>r.id==='rice')).toMatchObject({name:'Beras',opening:1000,purchase:5000,used:-600,waste:-100,closing:5300,before:8000,value:51233})
  expect(rows.find(r=>r.id==='tea')).toMatchObject({purchase:1000,used:-40,count:-30,closing:930,before:0,value:5580})
  expect(rows.find(r=>r.id==='sugar')).toMatchObject({name:'sugar',closing:100,value:900})
 })
 it('ages what is owed to suppliers from the day each delivery arrived, oldest paid first',()=>{
  const old={...po,id:'po2',number:'PO-2',receipts:[{at:'2026-08-01T05:00:00.000Z',lines:[{stockId:'rice',qty:1,cost:10000}]}],payments:[]}
  const part={...po,id:'po3',number:'PO-3',receipts:[{at:'2026-10-01T05:00:00.000Z',lines:[{stockId:'rice',qty:1,cost:8000}]},{at:at2,lines:[{stockId:'rice',qty:1,cost:4000}]}],payments:[{at:'2026-10-05T05:00:00.000Z',amount:3000,from:'outside' as const}]}
  expect(payables([po,old,part,{...po,id:'x',status:'cancelled'}],range)).toEqual([
   {id:'po1',number:'PO-1',supplier:'Toko Beras',receivedIn:50000,paidIn:20000,owed:30000,d0:30000,d31:0,d61:0,d91:0},
   {id:'po2',number:'PO-2',supplier:'Toko Beras',receivedIn:0,paidIn:0,owed:10000,d0:0,d31:0,d61:0,d91:10000},
   {id:'po3',number:'PO-3',supplier:'Toko Beras',receivedIn:4000,paidIn:0,owed:9000,d0:4000,d31:5000,d61:0,d91:0}])
  // The day before the last delivery and payment, less had arrived and nothing was paid in the range.
  expect(payables([po],{...range,to:D1})[0]).toMatchObject({paidIn:0,owed:50000,d0:50000})
 })
 it('writes a journal in which every entry balances',()=>{
  const {entries}=journal(books,menu,range,before),byRef=new Map<string,number>()
  for(const e of entries){expect(e.debit>=0&&e.credit>=0&&e.debit*e.credit===0).toBe(true);byRef.set(e.ref,(byRef.get(e.ref)??0)+e.debit-e.credit)}
  expect([...byRef.values()].every(v=>v===0)).toBe(true)
  expect([...byRef.keys()]).toEqual(expect.arrayContaining(['JUAL-20261110','HPP-20261110','BELI-20261110','MODAL-20261110','RETUR-20261111','BUANG-20261111','HITUNG-20261111','BAYAR-20261111','SELISIH-20261111']))
  const b=balances(entries)
  expect(b).toMatchObject({food:-60000,beverage:-20000,staff:-15000,discount:7000,returns:10000,service:-3150,tax:-6615,cash:105765,qris:0,inventory:49713,payable:-30000,outside:-40900,cogs:3987,compliment:2053,waste:967,shrink:180,cashOut:5000,income:-10000,cashGap:1000})
  expect(Object.values(b).reduce((n,v)=>n+v,0)).toBe(0)
  expect(profit(b)).toEqual({sales:80000,net:63000,revenue:78000,margin:74013,losses:4200,opex:5000,other:10000,result:74813})
 })
 it('adds the cash book to the profit and keeps the balance sheet in balance',()=>{
  const entries:CashEntry[]=[{id:'e1',day:D1,kind:'rent',amount:500000,note:'November'},{id:'e2',day:D2,kind:'capital',amount:1000000,note:''},{id:'e3',day:D2,kind:'taxPaid',amount:6000,note:''}]
  const written=cashbook(entries)
  expect(written.find(e=>e.account==='rent')).toMatchObject({day:D1,ref:'KB1-20261110',memo:'Sewa: November',debit:500000})
  expect(balances(written)).toMatchObject({rent:500000,outside:494000,capital:-1000000,tax:6000})
  const period=balances([...journal(books,menu,range,before).entries,...written]),opening={...zero(),inventory:8000,equity:-8000,food:-50000,cash:50000}
  expect(profit(period).opex).toBe(505000)
  const sheet=position(opening,period)
  expect(sheet.assets.find(a=>a.account==='inventory')!.amount).toBe(57713)
  expect(sheet.liabilities.find(a=>a.account==='tax')!.amount).toBe(615)
  expect(sheet.retained).toBe(50000)
  expect(sheet.current).toBe(74813-500000)
  expect(sheet.totalAssets).toBe(sheet.totalLiabilities+sheet.totalEquity)
  const book=ledger(journal(books,menu,range,before).entries,opening).find(a=>a.account==='inventory')!
  expect([book.opening,book.closing,book.rows.at(-1)!.balance]).toEqual([8000,57713,57713])
 })
 it('posts a catering order when it is delivered and its payments when they come in',()=>{
  const so={id:'so',number:'SO-1',status:'delivered',deliveredAt:at2,totals:totals([{price:100000,qty:1,cancelled:false,modifiers:[]}],0,rates),payments:[{at:at1,amount:50000,from:'drawer'},{at:at2,amount:65500,from:'outside'}]} as unknown as Books['salesOrders'][number]
  // The drawer movement the down payment wrote must not be posted a second time as cash put in by hand.
  const b=balances(journal({...empty,salesOrders:[so],cash:[{id:'k',shiftId:'s1',amount:50000,reason:'Pembayaran SO-1',at:at1,actor:'u'}]},menu,range).entries)
  expect(b).toMatchObject({catering:-100000,service:-5000,tax:-10500,receivable:0,cash:50000,outside:65500,income:0})
 })
 it('leaves the EDC machines out of the drawer gap, and carries the takings above the next float out of the drawer',()=>{
  const s={...shift,counted:99000+500000,expected:100000+498000,settlements:[{edc:'BCA',expected:498000,slip:500000}]}
  expect(balances(journal({...empty,shifts:[s]},menu,range).entries).cashGap).toBe(1000)
  const next={...shift,id:'s2',openedAt:at2,opening:200000},unknown={...shift,id:'s3',openedAt:'2026-11-11T09:00:00.000Z',opening:150000}
  expect(openings([next,s,unknown,{...shift,id:'s0',openedAt:'2026-11-01T05:00:00.000Z',counted:undefined}],range)).toEqual([{at:at1,opening:20000,prior:null},{at:at2,opening:200000,prior:99000},{at:'2026-11-11T09:00:00.000Z',opening:150000,prior:99000}])
  // 99.000 in the drawer, 200.000 float for the next shift: 101.000 comes in from outside. A shift before with no count moves nothing.
  expect(balances(journal({...empty,opened:[{at:at2,opening:200000,prior:99000},{at:at2,opening:150000,prior:null}]},menu,range).entries)).toMatchObject({cash:101000,outside:-101000})
 })
 it('sums the movements on a device the way the server does',()=>{
  const m=(id:string,stockId:string,kind:Movement['kind'],qty:number,at:string,recordId='r',cost=0):Movement=>({id,stockId,kind,qty,at,recordId,cost,reason:'x',actor:'u'})
  const {moves,opening}=sumMoves([m('1','rice','opening',1000,'2026-11-01T05:00:00.000Z'),m('2','rice','preparation',-200,at1,'a'),m('3','rice','preparation',-200,at1,'a2'),m('4','rice','preparation',-200,at1,'c'),
   m('5','rice','transfer',-300,at2,'t',9000),m('6','rice','purchase',500,'2026-11-12T05:00:00.000Z','p',5000)],new Set(['c']),range)
  expect(opening).toEqual({rice:1000})
  expect(moves).toEqual([{day:D1,stockId:'rice',kind:'preparation',comp:false,qty:-400,cost:0},{day:D1,stockId:'rice',kind:'preparation',comp:true,qty:-200,cost:0},{day:D2,stockId:'rice',kind:'transfer',comp:false,qty:-300,cost:-9000}])
 })
})
