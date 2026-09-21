import type { CashMovement, Ingredient, Line, Order, Settings, Shift, Totals } from './types'
export const MAX_MONEY = 1_000_000_000
export function money(value:number):number { if(!Number.isSafeInteger(value)||value<0||value>MAX_MONEY) throw new Error('Nilai rupiah tidak valid'); return value }
export function totals(lines:Line[], discount:number, settings:Pick<Settings,'taxBps'|'serviceBps'>):Totals {
 const subtotal=money(lines.filter(l=>!l.cancelled).reduce((n,l)=>n+(l.price+l.modifiers.reduce((s,m)=>s+m.price,0))*l.qty,0))
 money(discount); if(discount>subtotal) throw new Error('Diskon melebihi subtotal')
 for(const bps of [settings.taxBps,settings.serviceBps]) if(!Number.isInteger(bps)||bps<0||bps>10000) throw new Error('Tarif tidak valid')
 const service=Math.floor(((subtotal-discount)*settings.serviceBps+5000)/10000)
 const tax=Math.floor(((subtotal-discount+service)*settings.taxBps+5000)/10000)
 return {subtotal,discount,service,tax,total:money(subtotal-discount+service+tax)}
}
export function change(total:number,tendered:number) {money(total);money(tendered);if(tendered<total)throw new Error('Uang diterima kurang');return tendered-total}
export function convert(qty:string,unit:string,base:string):number {
 if(!/^\d+(\.\d{1,3})?$/.test(qty))throw new Error('Gunakan angka positif, maksimal 3 desimal')
 const factor=unit===base?1:unit==='kg'&&base==='g'||unit==='l'&&base==='ml'?1000:0
 if(!factor)throw new Error('Konversi satuan tidak sesuai')
 const [whole,fraction='']=qty.split('.');const scaled=(Number(whole)*1000+Number(fraction.padEnd(3,'0')))*factor
 if(!Number.isSafeInteger(scaled)||scaled<=0||scaled>1e12)throw new Error('Jumlah di luar batas');return scaled
}
export function consumption(lines:Line[],packaging:Ingredient[]=[]) {
 const map=new Map<string,number>()
 for(const l of lines.filter(l=>!l.cancelled&&!l.prepared))for(const r of [...l.recipe,...l.modifiers.flatMap(m=>m.recipe),...packaging])map.set(r.stockId,(map.get(r.stockId)||0)+r.qty*l.qty)
 return [...map].map(([stockId,qty])=>({stockId,qty}))
}
export function refundStock():Ingredient[]{return []}
export function expectedCash(shift:Shift,orders:Order[],moves:CashMovement[]) {
 return shift.opening+orders.filter(o=>o.shiftId===shift.id&&o.payment?.method==='cash'&&o.status!=='refunded').reduce((n,o)=>n+o.totals.total,0)+moves.filter(m=>m.shiftId===shift.id).reduce((n,m)=>n+m.amount,0)
}
export function businessDay(iso:string,timezone='Asia/Jakarta',cutoff=4) {
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date(iso))
 const get=(key:string)=>parts.find(p=>p.type===key)!.value
 const date=new Date(`${get('year')}-${get('month')}-${get('day')}T12:00:00Z`)
 if(Number(get('hour'))<cutoff)date.setUTCDate(date.getUTCDate()-1)
 return date.toISOString().slice(0,10)
}
export const rupiah=(v:number)=>new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0}).format(v)
export const quantity=(v:number)=>new Intl.NumberFormat('id-ID',{maximumFractionDigits:3}).format(v/1000)
