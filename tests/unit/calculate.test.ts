import { describe, expect, it } from 'vitest'
import { MAX_MONEY, businessDay, change, consumption, convert, expectedCash, money, refundStock, rupiah, stamp, totals, when } from '../../src/domain/calculate'
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
  for(const q of ['1.0001','-1','-0.5','','abc','1.','.5','1e3','Infinity','1,5,0'])expect(()=>convert(q,'g','g')).toThrow('Gunakan angka positif, maksimal 3 desimal')
  // Takar: a decimal comma and stray spaces are what phone keypads produce, so they are accepted.
  expect(convert('1,5','g','g')).toBe(1500);expect(convert(' 1 ','g','g')).toBe(1000)
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

describe('restaurant timezone',()=>{
 const evening='2026-03-15T19:30:00.000Z' // 02.30 WIB, 16 March
 it('formats in the restaurant timezone rather than the device one',()=>{
  expect(when(evening,'Asia/Jakarta',{hour:'2-digit',minute:'2-digit'})).toBe('02.30')
  expect(when(evening,'Europe/London',{hour:'2-digit',minute:'2-digit'})).toBe('19.30')
  expect(when(evening)).toBe('16 Mar 2026, 02.30')
 })
 it('stamps CSV rows as sortable Jakarta wall time, empty timezone included',()=>{
  expect(stamp(evening)).toBe('2026-03-16 02:30:00')
  expect(stamp('2026-03-15T00:00:00.000Z')).toBe('2026-03-15 07:00:00')
  expect(stamp(evening,'')).toBe('2026-03-16 02:30:00')
 })
})

// Takar: packs, option deltas, can-make, sanity checks, count maths, usage pace.
import { canMake, countGap, countsDue, daysLeft, describeDelta, expiring, nextPager, sanity, usagePerDay } from '../../src/domain/calculate'
describe('convert() with packs and a decimal comma',()=>{
 const packs=[{name:'karton',qty:12_000_000}]
 it('accepts the Indonesian decimal comma',()=>{expect(convert('2,5','kg','g')).toBe(2_500_000)})
 it('converts a pack name through the pack size',()=>{
  expect(convert('2','karton','ml',packs)).toBe(24_000_000)
  expect(convert('0,5','karton','ml',packs)).toBe(6_000_000)
 })
 it('rejects a pack this ingredient does not have',()=>{expect(()=>convert('2','dus','ml',packs)).toThrow('Konversi satuan tidak sesuai')})
})
describe('consumption() with option deltas',()=>{
 const milk=(qty:number)=>({stockId:'milk',qty}),oat=(qty:number)=>({stockId:'oat',qty})
 it('a swap removes the base ingredient and adds the replacement',()=>{
  const used=consumption([line({recipe:[milk(195_000)],modifiers:[mod({recipe:[milk(-195_000),oat(195_000)]})]})])
  expect(used.find(u=>u.stockId==='oat')?.qty).toBe(195_000)
  expect(used.find(u=>u.stockId==='milk')?.qty??0).toBe(0)
 })
 it('clamps at zero per line when the delta exceeds the base, so a swap never adds stock',()=>{
  const used=consumption([line({recipe:[milk(195_000)],modifiers:[mod({recipe:[milk(-300_000)]})]}),line({id:'l2',recipe:[milk(100_000)]})])
  expect(used.find(u=>u.stockId==='milk')?.qty).toBe(100_000)
 })
})
describe('canMake()',()=>{
 const balance=(b:Record<string,number>)=>(id:string)=>b[id]??0
 it('is the smallest whole number any ingredient allows',()=>{
  expect(canMake({recipe:[{stockId:'matcha',qty:5_000},{stockId:'milk',qty:195_000}]},balance({matcha:50_000,milk:2_000_000}))).toBe(10)
 })
 it('is unlimited for an item without a recipe',()=>{expect(canMake({recipe:[]},balance({}))).toBe(Infinity)})
 it('never goes below zero',()=>{expect(canMake({recipe:[{stockId:'matcha',qty:5_000}]},balance({matcha:-20_000}))).toBe(0)})
})
describe('sanity()',()=>{
 it('flags more than 5× the median of the last deliveries as high',()=>{expect(sanity(60_000,[10_000,10_000,12_000])).toBe('high')})
 it('flags less than a fifth as low',()=>{expect(sanity(1_000,[10_000,10_000,12_000])).toBe('low')})
 it('is silent with fewer than 3 deliveries',()=>{expect(sanity(60_000,[10_000])).toBe('ok')})
 it('uses the median, so one odd delivery does not skew it',()=>{expect(sanity(12_000,[10_000,10_000,12_000,500_000,11_000])).toBe('ok')})
})
describe('countGap()',()=>{
 it('values the gap at the unit cost and flags over 5%',()=>{
  expect(countGap(10_000_000,9_400_000,0.012)).toEqual({gap:-600_000,value:-7_200,flagged:true})
 })
 it('does not flag a gap within 5%',()=>{expect(countGap(10_000_000,9_600_000,0.012).flagged).toBe(false)})
 it('flags anything counted when nothing was expected',()=>{expect(countGap(0,1_000,0.012).flagged).toBe(true)})
})
describe('usage pace',()=>{
 const day=(n:number)=>new Date(Date.now()-n*86_400_000).toISOString()
 const moves=[{stockId:'rice',qty:-2_000_000,kind:'preparation',at:day(1)},{stockId:'rice',qty:-1_000_000,kind:'production',at:day(2)},{stockId:'rice',qty:5_000_000,kind:'purchase',at:day(1)},{stockId:'rice',qty:-9_000_000,kind:'preparation',at:day(9)}]
 it('averages what left stock through sales and batches over the window',()=>{expect(usagePerDay(moves,'rice',7)).toBeCloseTo(3_000_000/7)})
 it('daysLeft divides balance by daily use, unlimited when unused',()=>{
  expect(daysLeft(6_000_000,3_000_000/7)).toBe(14)
  expect(daysLeft(1_000,0)).toBe(Infinity)
 })
})
describe('option effects and pager numbers',()=>{
 const stock=[{id:'milk',name:'Susu segar',unit:'ml' as const,threshold:0},{id:'oat',name:'Susu oat',unit:'ml' as const,threshold:0},{id:'syrup',name:'Sirup gula',unit:'ml' as const,threshold:0},{id:'egg',name:'Telur',unit:'pcs' as const,threshold:0}]
 it('reads a swap as a replacement, a level as a reduction, an add-on as an addition',()=>{
  expect(describeDelta([{stockId:'milk',qty:-195_000},{stockId:'oat',qty:195_000}],stock)).toBe('ganti Susu segar → Susu oat')
  expect(describeDelta([{stockId:'syrup',qty:-8_000}],stock)).toBe('−8 ml Sirup gula')
  expect(describeDelta([{stockId:'egg',qty:1_000}],stock)).toBe('+1 pcs Telur')
  expect(describeDelta([],stock)).toBe('')
 })
 it('the next pager number follows the highest one used today',()=>{
  expect(nextPager(['Pager 3','Meja 9','Pager 12','pager 4'])).toBe(13)
  expect(nextPager([])).toBe(1)
 })
})
describe('countsDue()',()=>{
 const day=(n:number)=>new Date(Date.now()-n*86_400_000).toISOString()
 const items=[{id:'rice',name:'Beras',unit:'g' as const,threshold:0},{id:'egg',name:'Telur',unit:'pcs' as const,threshold:0},{id:'salt',name:'Garam',unit:'g' as const,threshold:0}]
 const use=(stockId:string,n:number)=>({id:`${stockId}-${n}`,stockId,qty:-1000,kind:'preparation',at:day(n)})
 it('wants the most-used ingredients weekly and everything monthly, counting from the last approved count',()=>{
  const movements=[use('rice',1),use('rice',2),use('egg',1),{id:'c1',stockId:'rice',qty:0,kind:'count',at:day(3)},{id:'c2',stockId:'salt',qty:0,kind:'count',at:day(40)}]
  const due=countsDue(items,movements,[],{weeklyTop:1})
  expect(due.weekly.map(i=>i.id)).toEqual([]) // rice counted 3 days ago
  expect(countsDue(items,[use('rice',1),use('egg',1)],[],{weeklyTop:2}).weekly.map(i=>i.id).sort()).toEqual(['egg','rice'])
  expect(due.monthly.map(i=>i.id).sort()).toEqual(['egg','salt']) // egg never counted, salt 40 days ago
 })
})
describe('expiring() allocates the balance to the newest batches first',()=>{
 const item={id:'sambal',name:'Sambal',unit:'pcs' as const,threshold:0,shelfLife:24,production:{inputs:[],output:20_000}}
 const h=(n:number)=>new Date(Date.now()-n*3_600_000).toISOString()
 const batches=[{id:'old',stockId:'sambal',qty:20_000,kind:'production',at:h(48)},{id:'new',stockId:'sambal',qty:20_000,kind:'production',at:h(1)}]
 it('lists only batches that still have portions left, with what is left',()=>{
  const used=[{id:'u',stockId:'sambal',qty:-15_000,kind:'preparation',at:h(0.5)}]
  const rows=expiring([item],[...batches,...used],2)
  expect(rows.map(r=>[r.movement.id,r.remaining,r.expired])).toEqual([['old',5_000,true]])
 })
 it('lists nothing once the stock is gone, even if old batches exist',()=>{
  expect(expiring([item],[...batches,{id:'u',stockId:'sambal',qty:-40_000,kind:'preparation',at:h(0.1)}],2)).toEqual([])
 })
})
