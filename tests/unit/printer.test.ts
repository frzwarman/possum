import { describe, expect, it, vi } from 'vitest'
import { browserPrinter, receiptText } from '../../src/lib/printer'
import { rupiah, totals } from '../../src/domain/calculate'
import { defaultSettings, sampleMenu } from '../../src/domain/sample'
import type { Line, Order } from '../../src/domain/types'

const at='2026-03-15T05:20:00.000Z'
const item=(id:string)=>sampleMenu.find(m=>m.id===id)!
const line=(id:string,p:Partial<Line>={}):Line=>{const m=item(id);return {id:'l-'+id,itemId:m.id,name:m.name,price:m.price,qty:1,modifiers:[],note:'',recipe:m.recipe,catalogVersion:m.version,prepared:true,cancelled:false,...p}}
const order=(lines:Line[],p:Partial<Order>={},discount=0):Order=>({id:'o1',restaurantId:'r1',shiftId:'s1',actor:'u1',cashier:'Ani',revision:2,receiptId:'MJ-260315-0007',label:'Meja 4',mode:'dinein',lines,status:'paid',prep:'ready',discount,discountReason:discount?'Promo':'',settings:defaultSettings,totals:totals(lines,discount,defaultSettings),createdAt:at,updatedAt:at,...p})
const cash=(o:Order,tendered:number):Order=>({...o,payment:{method:'cash',tendered,change:tendered-o.totals.total,verified:true,at}})

describe('receiptText()',()=>{
 it('names the restaurant, the receipt id, the cashier and every line item',()=>{
  const o=order([line('nasi-goreng',{qty:2}),line('es-teh')])
  const text=receiptText(o)
  expect(text).toContain(defaultSettings.name)
  expect(text).toContain(defaultSettings.address)
  expect(text).toContain('MJ-260315-0007')
  expect(text).toContain('Kasir: Ani')
  expect(text).toContain('Meja 4')
  expect(text).toContain('Makan di sini')
  expect(text).toContain(`2× ${item('nasi-goreng').name}  ${rupiah(50_000)}`)
  expect(text).toContain(`1× ${item('es-teh').name}  ${rupiah(6_000)}`)
  expect(text).toContain(defaultSettings.footer)
 })
 it('prices a modifier into its own line total',()=>{
  const mod=item('nasi-goreng').modifiers[0]
  const text=receiptText(order([line('nasi-goreng',{qty:2,modifiers:[mod]})]))
  expect(text).toContain(`2× ${item('nasi-goreng').name} + ${mod.name}  ${rupiah((25_000+mod.price)*2)}`)
 })
 it('shows the total and, for cash, the amount tendered and the change',()=>{
  const o=cash(order([line('ayam-bakar')]),50_000)
  const text=receiptText(o)
  expect(o.totals.total).toBe(32_000)
  expect(text).toContain(`TOTAL: ${rupiah(32_000)}`)
  expect(text).toContain('Pembayaran: CASH')
  expect(text).toContain(`Diterima: ${rupiah(50_000)}`)
  expect(text).toContain(`Kembalian: ${rupiah(18_000)}`)
 })
 it('says a QRIS payment was verified by hand — the app never confirms it electronically',()=>{
  const qris=order([line('ayam-bakar')],{payment:{method:'qris',tendered:0,change:0,verified:true,at}})
  const text=receiptText(qris)
  expect(text).toContain('Pembayaran: QRIS')
  expect(text).toContain('Pembayaran diverifikasi manual')
  expect(text).not.toContain('Diterima:')
  expect(text).not.toContain('Kembalian:')
  // Same wording for card, and for an unpaid order, so no non-cash slip reads as settled.
  expect(receiptText(order([line('ayam-bakar')],{payment:{method:'card',tendered:0,change:0,verified:true,at}}))).toContain('Pembayaran diverifikasi manual')
  const unpaid=receiptText(order([line('ayam-bakar')],{status:'open'}))
  expect(unpaid).toContain('Pembayaran: BELUM DIBAYAR')
  expect(unpaid).toContain('Pembayaran diverifikasi manual')
 })
 it('marks a reprint as a copy and an original as the real receipt',()=>{
  const o=cash(order([line('es-teh')]),10_000)
  expect(receiptText(o,true)).toContain('SALINAN STRUK')
  expect(receiptText(o,true)).not.toContain('STRUK PEMBAYARAN')
  expect(receiptText(o,false)).toContain('STRUK PEMBAYARAN')
  expect(receiptText(o,false)).not.toContain('SALINAN')
  expect(receiptText(o)).toBe(receiptText(o,false)) // reprint defaults to false
 })
 it('prints the discount that was actually given',()=>{
  const o=order([line('nasi-goreng',{qty:2})],{},10_000)
  expect(o.totals).toMatchObject({subtotal:50_000,discount:10_000,total:40_000})
  expect(receiptText(o)).toContain(`Diskon: ${rupiah(10_000)}`)
  // NOTE: the line is unconditional — an undiscounted receipt still prints "Diskon: Rp 0",
  // as do Layanan and Pajak at the default 0 bps. Cosmetic, not a money error; left as-is.
  expect(receiptText(order([line('nasi-goreng')]))).toContain(`Diskon: ${rupiah(0)}`)
 })
 it('leaves cancelled lines off the paper and out of the totals',()=>{
  const o=order([line('nasi-goreng'),line('mie-goreng',{cancelled:true})])
  const text=receiptText(o)
  expect(text).toContain(item('nasi-goreng').name)
  expect(text).not.toContain(item('mie-goreng').name)
  expect(o.totals.subtotal).toBe(25_000)
 })
 it('flags a refunded order on the copy the customer keeps',()=>{
  expect(receiptText(cash(order([line('es-teh')],{status:'refunded'}),6_000),true)).toContain('DANA DIKEMBALIKAN')
  expect(receiptText(cash(order([line('es-teh')]),6_000))).not.toContain('DANA DIKEMBALIKAN')
 })
 it('labels a takeaway order differently from dine-in',()=>{
  expect(receiptText(order([line('es-teh')],{mode:'takeaway'}))).toContain('Bungkus')
 })
 it('emits one unwrapped line per item; settings.printableWidth is enforced by the print CSS, not here',()=>{
  // Receipt.tsx passes printableWidth to --printable-width (millimetres, not characters).
  // If receiptText ever starts wrapping, this must be reconciled with that stylesheet.
  const long='X'.repeat(200)
  const text=receiptText(order([line('nasi-goreng',{name:long})]))
  expect(defaultSettings.printableWidth).toBe(72)
  expect(text.split('\n').filter(l=>l.includes(long))).toHaveLength(1)
 })
 it('drops empty fields rather than printing blank labelled lines',()=>{
  expect(receiptText(order([line('es-teh')],{label:''}))).not.toMatch(/^\s*$\n^\s*$/m)
  expect(defaultSettings.phone).toBe('') // an unset phone must not leave a stray blank line
 })
})

describe('browserPrinter adapter',()=>{
 it('satisfies the PrinterAdapter shape a native Android adapter would also implement',()=>{
  expect(typeof browserPrinter.name).toBe('string')
  expect(browserPrinter.name.length).toBeGreaterThan(0)
  expect(typeof browserPrinter.requestPrint).toBe('function')
  expect(browserPrinter.requestPrint.length).toBe(0)
 })
 it('delegates to the browser print dialog and resolves — requesting is not proof of paper',async()=>{
  const print=vi.fn()
  vi.stubGlobal('print',print) // jsdom has no real print dialog
  await expect(browserPrinter.requestPrint()).resolves.toBeUndefined()
  expect(print).toHaveBeenCalledOnce()
 })
})
