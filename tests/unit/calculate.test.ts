import { describe, expect, it } from 'vitest'
import { MAX_MONEY, businessDay, change, consumption, convert, expectedCash, money, refundStock, rupiah, totals } from '../../src/domain/calculate'
import { defaultSettings } from '../../src/domain/sample'
import type { CashMovement, Line, Modifier, Order, Settings, Shift } from '../../src/domain/types'

const at='2026-03-15T03:00:00.000Z'
const rate=(serviceBps:number,taxBps:number):Pick<Settings,'taxBps'|'serviceBps'>=>({serviceBps,taxBps})
const zero=rate(0,0)
const line=(p:Partial<Line>={}):Line=>({id:'l1',itemId:'nasi-goreng',name:'Nasi goreng',price:25_000,qty:1,modifiers:[],note:'',recipe:[],catalogVersion:1,prepared:false,cancelled:false,...p})
const mod=(p:Partial<Modifier>={}):Modifier=>({id:'m1',name:'Tambah telur',price:5_000,recipe:[],...p})
const shift=(p:Partial<Shift>={}):Shift=>({id:'s1',actor:'u1',cashier:'Ani',openedAt:'2026-03-15T01:00:00.000Z',expiresAt:'2026-03-15T13:00:00.000Z',opening:500_000,status:'open',...p})
const sale=(id:string,total:number,method:'cash'|'qris'|'card',p:Partial<Order>={}):Order=>({id,restaurantId:'r1',shiftId:'s1',actor:'u1',cashier:'Ani',revision:2,receiptId:'MJ-'+id,label:'Meja 1',mode:'dinein',lines:[],status:'paid',prep:'ready',discount:0,discountReason:'',settings:defaultSettings,totals:{subtotal:total,discount:0,service:0,tax:0,total},createdAt:at,updatedAt:at,payment:{method,tendered:total,change:0,verified:true,at},...p})
const move=(id:string,amount:number,shiftId='s1'):CashMovement=>({id,shiftId,amount,reason:'kas',at,actor:'u1'})

describe('money()',()=>{
 it('accepts 0 and MAX_MONEY, rejects anything above',()=>{
  expect(money(0)).toBe(0);expect(money(MAX_MONEY)).toBe(MAX_MONEY)
  expect(()=>money(MAX_MONEY+1)).toThrow('Nilai rupiah tidak valid')
 })
 it('rejects negatives, fractions and non-finite values — rupiah is an integer',()=>{
  for(const v of [-1,-0.5,0.5,25_000.01,NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER+1])expect(()=>money(v)).toThrow('Nilai rupiah tidak valid')
 })
})

describe('totals()',()=>{
 it('adds nothing at the default 0 bps rates — the half-up bias must not invent 1 rupiah',()=>{
  expect(defaultSettings.serviceBps).toBe(0);expect(defaultSettings.taxBps).toBe(0)
  expect(totals([line({qty:2})],0,defaultSettings)).toEqual({subtotal:50_000,discount:0,service:0,tax:0,total:50_000})
 })
 it('applies service first, then tax on subtotal plus service',()=>{
  const t=totals([line({price:100_000})],0,rate(1000,1100))
  expect(t.service).toBe(10_000)
  expect(t.tax).toBe(12_100) // 11% of 110_000, not the 11_000 that taxing the bare subtotal would give
  expect(t.total).toBe(122_100)
 })
 it('takes the discount off before both service and tax',()=>{
  expect(totals([line({price:100_000})],20_000,rate(1000,1100))).toEqual({subtotal:100_000,discount:20_000,service:8_000,tax:9_680,total:97_680})
 })
 it('rounds half-up at the exact .5 boundary',()=>{
  // 10% of 25_005 is exactly 2_500.5 rupiah
  expect(totals([line({price:25_005})],0,rate(1000,0)).service).toBe(2_501)
  expect(totals([line({price:25_004})],0,rate(1000,0)).service).toBe(2_500) // 2_500.4 down
  expect(totals([line({price:25_006})],0,rate(1000,0)).service).toBe(2_501) // 2_500.6 up
  expect(totals([line({price:25_005})],0,rate(0,1000)).tax).toBe(2_501)     // same rule for tax
 })
 it('allows a discount equal to the subtotal and rejects one above it',()=>{
  expect(totals([line({price:25_000})],25_000,rate(1000,1100))).toEqual({subtotal:25_000,discount:25_000,service:0,tax:0,total:0})
  expect(()=>totals([line({price:25_000})],25_001,zero)).toThrow('Diskon melebihi subtotal')
 })
 it('rejects a discount that is not valid rupiah',()=>{
  expect(()=>totals([line()],-1,zero)).toThrow('Nilai rupiah tidak valid')
  expect(()=>totals([line()],0.5,zero)).toThrow('Nilai rupiah tidak valid')
 })
 it('includes modifier prices in the line price and multiplies the lot by quantity',()=>{
  expect(totals([line({price:25_000,qty:3,modifiers:[mod({price:5_000}),mod({id:'m2',price:2_000})]})],0,zero).subtotal).toBe((25_000+5_000+2_000)*3)
 })
 it('excludes cancelled lines from the subtotal',()=>{
  expect(totals([line({price:25_000}),line({id:'l2',price:99_000,qty:9,cancelled:true})],0,zero).subtotal).toBe(25_000)
 })
 it('rejects rates outside 0..10000 bps',()=>{
  for(const r of [rate(-1,0),rate(0,10_001),rate(0.5,0),rate(0,NaN)])expect(()=>totals([line()],0,r)).toThrow('Tarif tidak valid')
 })
 it('refuses a subtotal beyond MAX_MONEY',()=>{
  expect(()=>totals([line({price:MAX_MONEY,qty:2})],0,zero)).toThrow('Nilai rupiah tidak valid')
 })
})

describe('change()',()=>{
 it('is 0 when the customer pays the exact amount',()=>{expect(change(50_000,50_000)).toBe(0)})
 it('is the difference otherwise',()=>{expect(change(47_500,100_000)).toBe(52_500)})
 it('throws when tendered is short by even 1 rupiah',()=>{expect(()=>change(50_000,49_999)).toThrow('Uang diterima kurang')})
 it('validates both amounts as rupiah',()=>{
  expect(()=>change(50_000,-1)).toThrow('Nilai rupiah tidak valid')
  expect(()=>change(0.5,1)).toThrow('Nilai rupiah tidak valid')
 })
})

describe('convert()',()=>{
 it('scales kg to thousandths of a gram: 1 kg = 1_000_000',()=>{expect(convert('1','kg','g')).toBe(1_000_000)})
 it('scales l to thousandths of a millilitre: 1 l = 1_000_000',()=>{expect(convert('1','l','ml')).toBe(1_000_000)})
 it('passes the same unit through, still scaled by 1000',()=>{
  expect(convert('250','g','g')).toBe(250_000);expect(convert('500','ml','ml')).toBe(500_000);expect(convert('1','pcs','pcs')).toBe(1_000)
 })
 it('keeps up to 3 decimals',()=>{
  expect(convert('1.5','kg','g')).toBe(1_500_000);expect(convert('0.001','kg','g')).toBe(1_000);expect(convert('2.125','g','g')).toBe(2_125);expect(convert('0.5','pcs','pcs')).toBe(500)
 })
 it('rejects a 4th decimal, negatives, blanks and non-numeric input',()=>{
  for(const q of ['1.0001','-1','-0.5','','abc','1.','.5','1,5','1e3',' 1','Infinity'])expect(()=>convert(q,'g','g')).toThrow('Gunakan angka positif, maksimal 3 desimal')
 })
 it('rejects zero — a movement of nothing is not a movement',()=>{
  expect(()=>convert('0','g','g')).toThrow('Jumlah di luar batas');expect(()=>convert('0.000','kg','g')).toThrow('Jumlah di luar batas')
 })
 it('rejects mismatched unit pairs',()=>{
  for(const [u,b] of [['kg','ml'],['l','g'],['g','kg'],['ml','l'],['pcs','g'],['g','pcs']])expect(()=>convert('1',u,b)).toThrow('Konversi satuan tidak sesuai')
 })
 it('accepts the 1e12 upper bound and rejects the step above it',()=>{
  expect(convert('1000000','kg','g')).toBe(1e12)
  expect(()=>convert('1000001','kg','g')).toThrow('Jumlah di luar batas')
 })
})

describe('consumption()',()=>{
 it('multiplies the base recipe by the line quantity',()=>{
  expect(consumption([line({qty:3,recipe:[{stockId:'rice',qty:100_000}]})])).toEqual([{stockId:'rice',qty:300_000}])
 })
 it('adds modifier recipes on top of the base recipe',()=>{
  expect(consumption([line({qty:2,recipe:[{stockId:'rice',qty:100_000}],modifiers:[mod({recipe:[{stockId:'egg',qty:1_000}]})]})])).toEqual([{stockId:'rice',qty:200_000},{stockId:'egg',qty:2_000}])
 })
 it('adds takeaway packaging once per item, times the line quantity',()=>{
  expect(consumption([line({qty:4,recipe:[{stockId:'rice',qty:100_000}]})],[{stockId:'box',qty:1_000}])).toEqual([{stockId:'rice',qty:400_000},{stockId:'box',qty:4_000}])
 })
 it('aggregates the same ingredient across several lines',()=>{
  expect(consumption([line({qty:2,recipe:[{stockId:'rice',qty:100_000}]}),line({id:'l2',itemId:'nasi',qty:1,recipe:[{stockId:'rice',qty:80_000}]})])).toEqual([{stockId:'rice',qty:280_000}])
 })
 it('excludes already prepared lines so an ingredient is never consumed twice',()=>{
  const already=line({qty:2,prepared:true,recipe:[{stockId:'rice',qty:100_000}]})
  const fresh=line({id:'l2',qty:1,recipe:[{stockId:'rice',qty:100_000}]})
  expect(consumption([already])).toEqual([])
  expect(consumption([already,fresh])).toEqual([{stockId:'rice',qty:100_000}])
 })
 it('excludes cancelled lines, packaging included',()=>{
  expect(consumption([line({qty:5,cancelled:true,recipe:[{stockId:'rice',qty:100_000}]})],[{stockId:'box',qty:1_000}])).toEqual([])
 })
})

describe('a refund returns money, never stock',()=>{
 it('refundStock() restores nothing — cooked food cannot be un-cooked back into the store',()=>{
  expect(refundStock()).toEqual([])
 })
 it('a cancellation before preparation consumed nothing in the first place, which is a different case from a refund',()=>{
  const l=line({qty:2,recipe:[{stockId:'rice',qty:100_000}]})
  expect(consumption([l])).toEqual([{stockId:'rice',qty:200_000}]) // what preparation would deduct
  expect(consumption([{...l,cancelled:true}])).toEqual([])         // cancelled before prepare: nothing ever left the store, so nothing to give back
  expect(consumption([{...l,prepared:true}])).toEqual([])          // already prepared: deducted exactly once, never again at payment
  expect(refundStock()).toEqual([])                                // refunding that prepared order adds nothing back
 })
})

describe('expectedCash()',()=>{
 const s=shift({opening:500_000})
 it('starts at the opening float',()=>{expect(expectedCash(s,[],[])).toBe(500_000)})
 it('adds cash sales only — QRIS and card never reach the drawer',()=>{
  expect(expectedCash(s,[sale('a',50_000,'cash'),sale('b',80_000,'qris'),sale('c',120_000,'card')],[])).toBe(550_000)
 })
 it('excludes refunded orders',()=>{
  expect(expectedCash(s,[sale('a',50_000,'cash'),sale('b',30_000,'cash',{status:'refunded'})],[])).toBe(550_000)
 })
 it('excludes orders belonging to another shift',()=>{
  expect(expectedCash(s,[sale('a',50_000,'cash'),sale('b',70_000,'cash',{shiftId:'s2'})],[])).toBe(550_000)
 })
 it('adds cash in and subtracts cash out, for this shift only',()=>{
  expect(expectedCash(s,[],[move('m1',200_000),move('m2',-75_000),move('m3',-999_999,'s2')])).toBe(625_000)
 })
 it('gives the variance a manager sees at close: counted minus expected',()=>{
  const expected=expectedCash(s,[sale('a',50_000,'cash'),sale('b',80_000,'qris')],[move('m1',-20_000)])
  expect(expected).toBe(530_000)
  expect(525_000-expected).toBe(-5_000) // drawer short
  expect(532_000-expected).toBe(2_000)  // drawer over
  expect(530_000-expected).toBe(0)
 })
})

describe('businessDay()',()=>{
 it('defaults to a 04:00 cutoff in Asia/Jakarta',()=>{
  expect(businessDay('2026-03-15T05:00:00.000Z')).toBe('2026-03-15') // 12:00 WIB
 })
 it('puts a 01:30 local sale on the PREVIOUS business day',()=>{
  expect(businessDay('2026-03-14T18:30:00.000Z')).toBe('2026-03-14') // 01:30 WIB on 15 March
 })
 it('puts a sale at exactly 04:00 local on the NEW business day',()=>{
  expect(businessDay('2026-03-14T21:00:00.000Z')).toBe('2026-03-15') // 04:00:00 WIB
  expect(businessDay('2026-03-14T20:59:59.000Z')).toBe('2026-03-14') // 03:59:59 WIB
 })
 it('keeps one trading night together across UTC midnight',()=>{
  expect(businessDay('2026-03-14T16:00:00.000Z')).toBe('2026-03-14') // 23:00 WIB, 14 March
  expect(businessDay('2026-03-14T17:30:00.000Z')).toBe('2026-03-14') // 00:30 WIB, 15 March — same night
 })
 it('follows the restaurant timezone',()=>{
  expect(businessDay('2026-03-14T19:30:00.000Z','Asia/Jakarta')).toBe('2026-03-14')  // 02:30 WIB
  expect(businessDay('2026-03-14T19:30:00.000Z','Asia/Jayapura')).toBe('2026-03-15') // 04:30 WIT, same instant
 })
 it('treats cutoff 0 as a plain calendar day',()=>{
  expect(businessDay('2026-03-14T18:30:00.000Z','Asia/Jakarta',0)).toBe('2026-03-15')
  expect(businessDay('2026-03-14T17:00:00.000Z','Asia/Jakarta',0)).toBe('2026-03-15') // 00:00 WIB exactly
 })
 it('rolls back across a month boundary',()=>{
  expect(businessDay('2026-03-01T19:00:00.000Z')).toBe('2026-03-01') // 02:00 WIB 2 March
  expect(businessDay('2026-02-28T19:00:00.000Z')).toBe('2026-02-28') // 02:00 WIB 1 March
 })
})

describe('rupiah',()=>{
 it('writes Indonesian currency: Rp glued to the number, dots for thousands, no cents',()=>{
  expect(rupiah(0)).toBe('Rp0')
  expect(rupiah(5_000)).toBe('Rp5.000')
  expect(rupiah(1_250_000)).toBe('Rp1.250.000')
  expect(rupiah(-7_500)).toBe('-Rp7.500')
 })
})
