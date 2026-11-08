import type { CashMovement, CountSession, Ingredient, Line, MenuItem, MenuType, Order, Pack, Settings, Shift, Station, StockItem, Totals } from './types'
export const MAX_MONEY = 1_000_000_000
export function money(value:number):number { if(!Number.isSafeInteger(value)||value<0||value>MAX_MONEY) throw new Error('Nilai rupiah tidak valid'); return value }
export function totals(lines:Pick<Line,'price'|'qty'|'cancelled'|'modifiers'>[], discount:number, settings:Pick<Settings,'taxBps'|'serviceBps'>):Totals {
 const subtotal=money(lines.filter(l=>!l.cancelled).reduce((n,l)=>n+(l.price+l.modifiers.reduce((s,m)=>s+m.price,0))*l.qty,0))
 money(discount); if(discount>subtotal) throw new Error('Diskon melebihi subtotal')
 for(const bps of [settings.taxBps,settings.serviceBps]) if(!Number.isInteger(bps)||bps<0||bps>10000) throw new Error('Tarif tidak valid')
 const service=Math.floor(((subtotal-discount)*settings.serviceBps+5000)/10000)
 const tax=Math.floor(((subtotal-discount+service)*settings.taxBps+5000)/10000)
 return {subtotal,discount,service,tax,total:money(subtotal-discount+service+tax)}
}
export function change(total:number,tendered:number) {money(total);money(tendered);if(tendered<total)throw new Error('Uang diterima kurang');return tendered-total}
// qty is what was typed ("2,5" on an Indonesian keypad is 2.5); unit is the base unit, kg/l, or
// the name of one of the ingredient's packs ("karton"), whose size is in thousandths of the base.
export function convert(qty:string,unit:string,base:string,packs:Pack[]=[]):number {
 qty=qty.trim().replace(',','.')
 if(!/^\d+(\.\d{1,3})?$/.test(qty))throw new Error('Gunakan angka positif, maksimal 3 desimal')
 const pack=packs.find(p=>p.name===unit)
 const factor=unit===base?1:unit==='kg'&&base==='g'||unit==='l'&&base==='ml'?1000:pack?pack.qty/1000:0
 if(!factor)throw new Error('Konversi satuan tidak sesuai')
 const [whole,fraction='']=qty.split('.');const scaled=Math.round((Number(whole)*1000+Number(fraction.padEnd(3,'0')))*factor)
 if(!Number.isSafeInteger(scaled)||scaled<=0||scaled>1e12)throw new Error('Jumlah di luar batas');return scaled
}
// Per line: base recipe plus option deltas, never below zero (a swap removes at most what the base
// used), then times the quantity. The server (order.prepare) adds up the same way.
export function lineUse(l:Pick<Line,'recipe'|'modifiers'|'qty'>,packaging:Ingredient[]=[]) {
 const map=new Map<string,number>()
 for(const r of [...l.recipe,...l.modifiers.flatMap(m=>m.recipe),...packaging])map.set(r.stockId,(map.get(r.stockId)||0)+r.qty)
 return [...map].flatMap(([stockId,qty])=>qty>0?[{stockId,qty:qty*l.qty}]:[])
}
export function consumption(lines:Line[],packaging:Ingredient[]=[]) {
 const map=new Map<string,number>()
 for(const l of lines.filter(l=>!l.cancelled&&!l.prepared))for(const r of lineUse(l,packaging))map.set(r.stockId,(map.get(r.stockId)||0)+r.qty)
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
// PUEBI: Rp menempel pada angka (Rp50.000), ribuan bertitik, desimal berkoma. ICU menyisipkan
// spasi tak-putus setelah Rp, jadi dibuang; rupiah tidak memakai pecahan sen.
export const JAKARTA='Asia/Jakarta'
// Setiap waktu yang dibaca orang memakai zona restoran (bawaan WIB, UTC+7), bukan zona perangkat:
// ponsel yang zonanya meleset atau kasir yang sedang bepergian tidak boleh menggeser jam di layar.
export const when=(iso:string|number|Date,timezone=JAKARTA,options:Intl.DateTimeFormatOptions={dateStyle:'medium',timeStyle:'short'})=>new Intl.DateTimeFormat('id-ID',{timeZone:timezone||JAKARTA,...options}).format(new Date(iso))
// Untuk CSV: satu kolom yang urut secara leksikografis dan terbaca Excel, tetap zona restoran.
export const stamp=(iso:string,timezone=JAKARTA)=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone||JAKARTA,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).formatToParts(new Date(iso)).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`}
export const rupiah=(v:number)=>new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0}).format(v).replace(/\s/g,'')
// Back office arithmetic, mirroring received_value/received_qty/paid_value/unit_cost on the server.
export const receivedQty=(po:{receipts:{lines:{stockId:string;qty:number}[]}[]},stockId:string)=>po.receipts.flatMap(r=>r.lines).filter(l=>l.stockId===stockId).reduce((n,l)=>n+l.qty,0)
export const receivedValue=(po:{receipts:{lines:{cost:number}[]}[]})=>po.receipts.flatMap(r=>r.lines).reduce((n,l)=>n+l.cost,0)
export const paidValue=(doc:{payments:{amount:number}[]})=>doc.payments.reduce((n,p)=>n+p.amount,0)
// Latest price per thousandth of a base unit for each item that came in with a cost; the server's
// figures from sign-in (seed) fill in what this device never saw.
export function unitCosts(movements:{stockId:string;qty:number;cost:number;kind:string;at:string}[],seed:Record<string,number>={}){
 const latest=new Map<string,{at:string;unit:number}>()
 for(const m of movements)if(m.qty>0&&m.cost>0&&['purchase','production','transfer'].includes(m.kind)&&(latest.get(m.stockId)?.at??'')<=m.at)latest.set(m.stockId,{at:m.at,unit:m.cost/m.qty})
 const costs=new Map(Object.entries(seed));for(const [id,{unit}] of latest)costs.set(id,unit);return costs
}
export const quantity=(v:number)=>new Intl.NumberFormat('id-ID',{maximumFractionDigits:3}).format(v/1000)
// Takar catalog defaults: older catalog versions have no type/station, so every reader goes through these.
export const menuType=(m:Pick<MenuItem,'type'|'category'>):MenuType=>m.type??(/minum|drink|kopi|coffee|tea|teh|juice|jus/i.test(m.category)?'beverage':/camilan|snack|tambahan|side/i.test(m.category)?'snack':'food')
export const typeLabel:Record<MenuType,string>={food:'Makanan',beverage:'Minuman',snack:'Camilan'}
export const itemStation=(m:Pick<MenuItem,'station'|'type'|'category'>):Station=>m.station??(menuType(m)==='beverage'?'bar':'kitchen')
// "Can make": the lowest whole number of portions any recipe line allows from stock on hand.
export function canMake(item:Pick<MenuItem,'recipe'>,balance:(stockId:string)=>number) {
 return item.recipe.reduce((n,r)=>r.qty>0?Math.min(n,Math.max(0,Math.floor(balance(r.stockId)/r.qty))):n,Infinity)
}
export const availability=(item:Pick<MenuItem,'recipe'|'soldOut'|'ignoreStock'|'lowAt'>,balance:(stockId:string)=>number,lowAt=5)=>{
 const left=item.ignoreStock?Infinity:canMake(item,balance)
 return {left,soldOut:item.soldOut||left<1,low:left<=(item.lowAt??lowAt)}
}
// One forgiving search over name, aliases and tags: accent- and case-insensitive, every word of the
// query must start a word or be within one typo of it (POS-1: "amer" and "amricano" find Americano).
const plain=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
function distance(a:string,b:string){
 const d=Array.from({length:b.length+1},(_,j)=>j)
 for(let i=1;i<=a.length;i++){let prev=d[0];d[0]=i;for(let j=1;j<=b.length;j++){const t=d[j];d[j]=Math.min(d[j]+1,d[j-1]+1,prev+(a[i-1]===b[j-1]?0:1));prev=t}}
 return d[b.length]
}
const wordMatch=(token:string,word:string)=>word.startsWith(token)||token.length>=4&&(distance(token,word)<=1||distance(token,word.slice(0,token.length))<=1)
export function search<T extends {name:string;aliases?:string[];tags?:string[]}>(items:T[],query:string) {
 const tokens=plain(query).split(/\s+/).filter(Boolean)
 if(!tokens.length)return items
 return items.filter(i=>{const words=plain([i.name,...(i.aliases??[]),...(i.tags??[])].join(' ')).split(/[^a-z0-9]+/).filter(Boolean);return tokens.every(t=>words.some(w=>wordMatch(t,w)))})
}
// PUR-4: a delivery more than 5× or under ⅕ of the median of the last deliveries needs a second look.
export function sanity(qty:number,history:number[]):'ok'|'high'|'low' {
 const last=history.slice(-5).sort((a,b)=>a-b)
 if(last.length<3)return 'ok'
 const median=last.length%2?last[(last.length-1)/2]:(last[last.length/2-1]+last[last.length/2])/2
 return qty>median*5?'high':qty<median/5?'low':'ok'
}
// CNT-2: gap = counted − expected, valued at the current unit cost (rupiah per thousandth); flagged over 5%.
export function countGap(expected:number,counted:number,unitCost=0) {
 const gap=counted-expected
 return {gap,value:Math.round(gap*unitCost),flagged:expected<=0?gap!==0:Math.abs(gap)>expected*0.05}
}
// TDY-2: how fast an ingredient leaves stock (sales and batches), and how many days the balance lasts.
export function usagePerDay(movements:{stockId:string;qty:number;kind:string;at:string}[],stockId:string,days=7) {
 const since=Date.now()-days*86_400_000
 return movements.filter(m=>m.stockId===stockId&&m.qty<0&&['preparation','production'].includes(m.kind)&&Date.parse(m.at)>=since).reduce((n,m)=>n-m.qty,0)/days
}
export const daysLeft=(balance:number,perDay:number)=>perDay>0?Math.max(0,Math.round(balance/perDay)):Infinity
// PREP-3: prep items at or below par, with the batches that bring them back to twice par, most urgent first.
export function prepList(stock:StockItem[],balance:(id:string)=>number) {
 return stock.filter(s=>s.production&&balance(s.id)<=s.threshold).map(s=>({item:s,balance:balance(s.id),batches:Math.max(1,Math.ceil((2*s.threshold-balance(s.id))/s.production!.output))})).sort((a,b)=>a.balance/Math.max(1,a.item.threshold)-b.balance/Math.max(1,b.item.threshold))
}
// PREP-4: the stock on hand is allocated to the newest batches first; a batch still holding portions is
// listed once its shelf life is within `warnHours` or over, with what is left to throw away.
export function expiring(stock:StockItem[],movements:{id:string;stockId:string;qty:number;kind:string;at:string}[],warnHours=2,now=Date.now()) {
 const out:{item:StockItem;movement:{id:string;stockId:string;qty:number;kind:string;at:string};remaining:number;expiresAt:number;expired:boolean}[]=[]
 for(const s of stock){if(!s.shelfLife)continue
  let left=movements.filter(m=>m.stockId===s.id).reduce((n,m)=>n+m.qty,0)
  for(const b of movements.filter(m=>m.stockId===s.id&&m.kind==='production'&&m.qty>0).sort((a,b)=>b.at.localeCompare(a.at))){
   if(left<=0)break;const remaining=Math.min(left,b.qty);left-=remaining;const expiresAt=Date.parse(b.at)+s.shelfLife*3_600_000
   if(expiresAt-now<=warnHours*3_600_000)out.push({item:s,movement:b,remaining,expiresAt,expired:expiresAt<=now})}}
 return out.sort((a,b)=>a.expiresAt-b.expiresAt)
}
// Mirrors prep_state on the server: new = nothing sent, ready = every sent line marked ready by its station.
export function prepState(lines:Pick<Line,'prepared'|'cancelled'|'readyAt'>[]):'new'|'preparing'|'ready' {
 const active=lines.filter(l=>!l.cancelled)
 if(!active.some(l=>l.prepared))return 'new'
 return active.every(l=>l.prepared&&l.readyAt)?'ready':'preparing'
}
// MENU-5 / POS-4: what an option does to stock, in words: a swap pairs a removal with an equal addition.
export function describeDelta(recipe:Ingredient[],stock:Pick<StockItem,'id'|'name'|'unit'>[]) {
 const name=(id:string)=>stock.find(s=>s.id===id)?.name??id,unit=(id:string)=>stock.find(s=>s.id===id)?.unit??''
 const minus=recipe.filter(r=>r.qty<0),plus=recipe.filter(r=>r.qty>0),used=new Set<string>(),parts:string[]=[]
 for(const m of minus){const p=plus.find(p=>!used.has(p.stockId)&&p.qty===-m.qty&&unit(p.stockId)===unit(m.stockId));if(p){used.add(p.stockId);parts.push(`ganti ${name(m.stockId)} → ${name(p.stockId)}`)}else parts.push(`−${quantity(-m.qty)} ${unit(m.stockId)} ${name(m.stockId)}`)}
 for(const p of plus)if(!used.has(p.stockId))parts.push(`+${quantity(p.qty)} ${unit(p.stockId)} ${name(p.stockId)}`)
 return parts.join(', ')
}
// POS-3: every new order starts with the next pager number of the day.
export const nextPager=(labels:string[])=>labels.reduce((n,l)=>{const m=/^pager\s+(\d+)$/i.exec(l.trim());return m?Math.max(n,Number(m[1])):n},0)+1
// CNT-4: the 20 most-used ingredients (most sales/batches in the last 7 days) are due weekly, everything monthly,
// counted from the last approved count of each ingredient.
export function countsDue(stock:StockItem[],movements:{stockId:string;qty:number;kind:string;at:string}[],counts:Pick<CountSession,'status'|'approvedAt'|'lines'>[],{weeklyTop=20,now=Date.now()}:{weeklyTop?:number;now?:number}={}) {
 const last=new Map<string,number>()
 for(const m of movements)if(m.kind==='count')last.set(m.stockId,Math.max(last.get(m.stockId)??0,Date.parse(m.at)))
 for(const c of counts)if(c.status==='approved'&&c.approvedAt)for(const l of c.lines)if(l.counted!==undefined)last.set(l.stockId,Math.max(last.get(l.stockId)??0,Date.parse(c.approvedAt)))
 const since=now-7*86_400_000,uses=new Map<string,number>()
 for(const m of movements)if(m.qty<0&&['preparation','production'].includes(m.kind)&&Date.parse(m.at)>=since)uses.set(m.stockId,(uses.get(m.stockId)??0)+1)
 const top=stock.filter(s=>uses.has(s.id)).sort((a,b)=>uses.get(b.id)!-uses.get(a.id)!).slice(0,weeklyTop)
 const stale=(s:StockItem,days:number)=>(last.get(s.id)??0)<now-days*86_400_000
 return {weekly:top.filter(s=>stale(s,7)),monthly:stock.filter(s=>stale(s,30))}
}
