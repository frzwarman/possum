import { MAX_MONEY, change, consumption, expectedCash, money, paidValue, receivedQty, receivedValue, rupiah, totals, unitCosts } from '../domain/calculate'
import type { Approval, ApprovalAction, Draft, Identity, Ingredient, MenuItem, Operation, OpKind, Order, Outlet, Payment, PurchaseLine, PurchaseOrder, SalesLine, SalesOrder, Settings, Shift, StockItem, Supplier, Transfer } from '../domain/types'
import { MejaDB, uid } from './db'
import { validateMenuPhotoData } from './menu-photo'
import { supabase } from './supabase'
// The demo has no server: its approvers and their PIN live here, and the hint shows the PIN.
export const DEMO_PIN='123456'
export const demoApprovers=[{id:'demo-owner',name:'Pemilik Demo'},{id:'demo-manager',name:'Manajer Demo'}]
const refusal:Record<string,string>={'wrong-pin':'PIN salah','no-pin':'Manajer ini belum membuat PIN persetujuan (Lainnya → PIN persetujuan)',locked:'Terlalu banyak PIN salah. Coba lagi setelah 15 menit.'}
// Mirrors apply_operation's catalog.publish checks. The server rejects anything else, and a rejected
// operation halts every later one in the outbox, so refuse it here with a message the manager can act on.
function checkCatalog(menu:MenuItem[],stock:StockItem[]){
 const known=new Set(stock.map(s=>s.id)),whole=(v:number,max:number)=>Number.isSafeInteger(v)&&v>=0&&v<=max
 const recipe=(r:Ingredient[],where:string)=>{if(r.length>100||new Set(r.map(x=>x.stockId)).size<r.length||r.some(x=>!known.has(x.stockId)||!x.qty||!whole(x.qty,1e9)))throw new Error(`Resep "${where}" tidak valid`)}
 if(menu.length>500||stock.length>1000)throw new Error('Katalog maksimal 500 menu dan 1.000 bahan')
 for(const s of stock)if(!s.name||s.name.length>100||!['g','ml','pcs'].includes(s.unit)||!whole(s.threshold,1e12))throw new Error(`Bahan "${s.name}": nama 1–100 karakter, batas minimum angka 0 atau lebih`)
 for(const s of stock)if(s.production){const p=s.production;if(!p.inputs.length||p.inputs.some(x=>x.stockId===s.id)||!p.output||!whole(p.output,1e12))throw new Error(`Resep produksi "${s.name}": pilih bahan selain dirinya sendiri dan isi hasil per batch`);recipe(p.inputs,`produksi ${s.name}`)}
 for(const m of menu){
  if(!m.name||m.name.length>100||!m.category||m.category.length>50||!whole(m.price,MAX_MONEY))throw new Error(`Menu "${m.name}": nama 1–100 karakter, kategori 1–50 karakter, harga Rp0–${rupiah(MAX_MONEY)}`)
  if(!validateMenuPhotoData(m.photo))throw new Error(`Foto menu "${m.name}" tidak valid`)
  recipe(m.recipe,m.name)
  if(new Set(m.modifiers.map(x=>x.id)).size<m.modifiers.length)throw new Error(`Menu "${m.name}": tambahan ganda`)
  for(const x of m.modifiers){if(!x.name.trim()||x.name.length>100||!whole(x.price,MAX_MONEY))throw new Error(`Menu "${m.name}": beri nama setiap tambahan (maks. 100 karakter) atau hapus barisnya`);recipe(x.recipe,`${m.name} + ${x.name}`)}
 }
}
export class Commands {
 constructor(public db:MejaDB,public user:Identity){}
 async run<T>(kind:OpKind, payload:Record<string,unknown>, mutate:(op:Operation)=>Promise<T>):Promise<T>{
  if(!this.user.primary)throw new Error('Transaksi hanya di perangkat kasir utama')
  const op:Operation={id:uid(),kind,actor:this.user.id,restaurantId:this.user.restaurantId,deviceId:this.user.deviceId,occurredAt:new Date().toISOString(),payload,state:'pending',attempts:0,nextAttempt:0}
  try{return await this.db.transaction('rw',this.db.tables,async()=>{const result=await mutate(op);await this.db.outbox.add(op);return result})}catch(e){throw new Error(e instanceof Error?e.message:'Penyimpanan gagal. Jangan tutup halaman; ekspor pemulihan.')}
 }
 online(){if(!this.user.demo&&!navigator.onLine)throw new Error('Tindakan ini perlu koneksi server')}
 manager(online=false){if(this.user.role==='cashier')throw new Error('Perlu akun manajer');if(online)this.online()}
 // A cashier's discount, void, refund, or cash out needs a manager's approval for exactly that action,
 // order, and amount, not yet an hour old: apply_operation rejects anything else, and a rejected
 // operation halts the outbox. Managers and the owner approve their own actions.
 private approver(action:ApprovalAction,approval:Approval|undefined,{amount,orderId}:{amount?:number;orderId?:string}={}){
  if(this.user.role!=='cashier')return {by:this.user.name,payload:{}}
  if(!approval||approval.action!==action||approval.amount!==amount||approval.orderId!==orderId)throw new Error('Perlu persetujuan manajer')
  if(Date.now()-approval.at>50*60000)throw new Error('Persetujuan manajer kedaluwarsa. Minta lagi.')
  return {by:approval.by,payload:{approval:approval.id}}
 }
 async approvers(){
  if(this.user.demo)return demoApprovers.filter(a=>a.id!==this.user.id)
  const {data,error}=await supabase!.from('memberships').select('user_id,name').in('role',['owner','manager']).eq('active',true).order('name');if(error)throw error
  return (data as {user_id:string;name:string}[]).filter(m=>m.user_id!==this.user.id).map(m=>({id:m.user_id,name:m.name}))
 }
 // The manager types their PIN on this till; the server checks it and hands back a one-use approval.
 async approve(approver:string,pin:string,action:ApprovalAction,{amount,orderId}:{amount?:number;orderId?:string}={}):Promise<Approval>{
  this.online();let id:string,by:string
  if(this.user.demo){const a=demoApprovers.find(a=>a.id===approver);if(!a||pin!==DEMO_PIN)throw new Error(refusal['wrong-pin']);id=uid();by=a.name}
  else{const {data,error}=await supabase!.rpc('approve',{approver,pin,action,order_id:orderId??null,amount:amount??null});if(error)throw error;if(data.error)throw new Error(refusal[data.error]||'Persetujuan ditolak');id=data.id;by=data.by}
  return {id,by,action,amount,orderId,at:Date.now()}
 }
 async setPin(pin:string){this.manager(true);if(this.user.demo)throw new Error(`Demo memakai PIN ${DEMO_PIN}`);if(!/^\d{6}$/.test(pin))throw new Error('PIN harus 6 angka')
  const {error}=await supabase!.rpc('set_approval_pin',{pin});if(error)throw new Error(error.message.includes('trivial')?'PIN terlalu mudah ditebak: hindari angka kembar dan urutan seperti 123456':error.message)}
 // The 12-hour authorization stops new work, not the close: apply_operation accepts shift.close after expiry.
 async shift(closing=false){const s=await this.db.shifts.where('status').equals('open').first();if(!s||s.actor!==this.user.id)throw new Error('Buka sif Anda terlebih dahulu');if(!closing&&Date.now()>Date.parse(s.expiresAt))throw new Error('Otorisasi sif berakhir. Hubungkan internet dan tutup sif.');return s}
 // apply_operation refuses a shift.open that reaches it more than 2 minutes late.
 async openShift(opening:number){money(opening);this.online();const id=uid();return this.run('shift.open',{id,opening},async op=>{if(await this.db.shifts.where('status').equals('open').count())throw new Error('Sif masih terbuka');const shift:Shift={id,actor:this.user.id,cashier:this.user.name,openedAt:op.occurredAt,expiresAt:new Date(Date.parse(op.occurredAt)+12*3600000).toISOString(),opening,status:'open'};await this.db.shifts.add(shift);return shift})}
 async save(draft:Draft){return this.run('order.save',{draft},async op=>{
  const shift=await this.shift();if(!draft.lines.some(l=>!l.cancelled))throw new Error('Tambahkan menu dahulu')
  const old=draft.orderId?await this.db.orders.get(draft.orderId):undefined
  if(draft.orderId&&!old)throw new Error('Pesanan tidak ditemukan')
  if(old&&(old.status!=='open'||old.revision!==draft.revision))throw new Error('Pesanan sudah berubah. Buka ulang dari Pesanan.')
  const discounted=draft.discount!==(old?.discount||0);if(discounted&&draft.discount&&!draft.discountReason.trim())throw new Error('Isi alasan diskon')
  const approved=discounted?this.approver('discount',draft.discountApproval,{amount:draft.discount}):{by:old?.discountApprovedBy,payload:{}}
  const settings=old?.settings||await this.db.settings.get('settings');if(!settings)throw new Error('Selesaikan pengaturan restoran')
  if(old)for(const line of old.lines.filter(l=>l.prepared)){const next=draft.lines.find(l=>l.id===line.id);if(!next||JSON.stringify(next)!==JSON.stringify(line))throw new Error('Menu yang sudah disiapkan tidak dapat diubah. Batalkan seluruh pesanan dengan alasan.')}
  for(const l of draft.lines){if(!Number.isInteger(l.qty)||l.qty<1||l.qty>999)throw new Error('Jumlah menu 1–999');money(l.price)}
  const order:Order={id:old?.id||uid(),restaurantId:this.user.restaurantId,shiftId:shift.id,actor:this.user.id,cashier:this.user.name,revision:(old?.revision||0)+1,receiptId:old?.receiptId||`MJ-${op.id.toUpperCase()}`,label:draft.label,mode:draft.mode,lines:draft.lines,status:'open',prep:old?.prep||'new',discount:draft.discount,discountReason:draft.discountReason,...(approved.by&&{discountApprovedBy:approved.by}),settings,totals:totals(draft.lines,draft.discount,settings),createdAt:old?.createdAt||op.occurredAt,updatedAt:op.occurredAt}
  op.payload={order,expectedRevision:old?.revision||0,...approved.payload};await this.db.orders.put(order);await this.db.drafts.delete('current');return order
 })}
 async prepare(id:string){return this.run('order.prepare',{id},async op=>{await this.shift();const o=await this.openOrder(id);const lines=o.lines.filter(l=>!l.prepared&&!l.cancelled);if(!lines.length)throw new Error('Tidak ada tambahan baru untuk disiapkan');op.payload={id,expectedRevision:o.revision,lineIds:lines.map(l=>l.id)}
 for(const c of consumption(lines,o.mode==='takeaway'?o.settings.packaging:[]))await this.db.movements.add({id:`${op.id}-${c.stockId}`,stockId:c.stockId,qty:-c.qty,kind:'preparation',reason:`Persiapan ${o.label||o.receiptId}`,actor:this.user.id,at:op.occurredAt,recordId:o.id,cost:0})
 o.lines=o.lines.map(l=>({...l,prepared:l.prepared||!l.cancelled}));o.prep='preparing';o.revision++;o.updatedAt=op.occurredAt;await this.db.orders.put(o);return o})}
 async ready(id:string){return this.run('order.ready',{id},async op=>{await this.shift();const o=await this.openOrder(id);op.payload={id,expectedRevision:o.revision};if(o.lines.some(l=>!l.prepared&&!l.cancelled))throw new Error('Kirim seluruh menu ke dapur dahulu');o.prep='ready';o.revision++;await this.db.orders.put(o)})}
 async pay(id:string,method:'cash'|'qris'|'card',tendered:number,verified:boolean){return this.run('payment.record',{id,method,tendered,verified},async op=>{await this.shift();const o=await this.openOrder(id);if(o.lines.some(l=>!l.prepared&&!l.cancelled))throw new Error('Kirim ke dapur sebelum pembayaran');if(method!=='cash'&&(!verified||!navigator.onLine))throw new Error('Periksa pembayaran pada aplikasi merchant saat online');const t=method==='cash'?money(tendered):o.totals.total;const c=change(o.totals.total,t);op.payload={...op.payload,expectedRevision:o.revision};o.payment={method,tendered:t,change:c,verified:method==='cash'||verified,at:op.occurredAt};o.status='paid';o.revision++;o.updatedAt=op.occurredAt;await this.db.orders.put(o);return o})}
 async voidOrder(id:string,reason:string,approval?:Approval){if(!reason.trim())throw new Error('Alasan wajib');const ok=this.approver('void',approval,{orderId:id});return this.run('order.void',{id,reason,...ok.payload},async op=>{await this.shift();const o=await this.openOrder(id);op.payload={...op.payload,expectedRevision:o.revision};o.status='void';o.voidReason=reason;o.voidApprovedBy=ok.by;o.revision++;o.updatedAt=op.occurredAt;await this.db.orders.put(o)})}
 async refund(id:string,reason:string,approval?:Approval){this.online();if(!reason.trim())throw new Error('Alasan wajib');const ok=this.approver('refund',approval,{orderId:id});return this.run('refund.record',{id,reason,...ok.payload},async op=>{const o=await this.db.orders.get(id);if(!o||o.status!=='paid')throw new Error('Hanya transaksi lunas yang dapat dikembalikan');const s=await this.shift();if(s.id!==o.shiftId)throw new Error('MVP: pengembalian hanya dalam sif asal yang masih terbuka');op.payload={...op.payload,expectedRevision:o.revision};o.status='refunded';o.refund={reason,at:op.occurredAt,actor:this.user.id,approvedBy:ok.by};o.revision++;await this.db.orders.put(o)})}
 async stockRecord(stockId:string,kind:'opening'|'purchase'|'waste'|'count'|'adjustment',qty:number,reason:string,cost=0,fromDrawer=false){this.manager();if(!reason.trim()||!Number.isSafeInteger(qty)||Math.abs(qty)>1e12)throw new Error('Jumlah/alasan tidak valid');money(cost);return this.run('stock.record',{stockId,kind,qty,reason,cost,fromDrawer},async op=>{
 if(!await this.db.stock.get(stockId))throw new Error('Bahan tidak ditemukan');const balance=(await this.db.movements.where('stockId').equals(stockId).toArray()).reduce((n,m)=>n+m.qty,0)
 const delta=kind==='count'?qty-balance:kind==='waste'?-Math.abs(qty):qty
 if((kind==='purchase'||kind==='opening')&&qty<=0)throw new Error('Jumlah harus positif')
 await this.db.movements.add({id:op.id,stockId,kind,qty:delta,reason,actor:this.user.id,at:op.occurredAt,recordId:op.id,cost});if(fromDrawer){const s=await this.shift();await this.db.cash.add({id:op.id,shiftId:s.id,amount:-cost,reason:`Pembelian: ${reason}`,at:op.occurredAt,actor:this.user.id,recordId:op.id});op.payload.shiftId=s.id}return delta})}
 async cashMove(amount:number,reason:string,approval?:Approval){if(!Number.isSafeInteger(amount)||!amount||Math.abs(amount)>1e9||!reason.trim())throw new Error('Jumlah/alasan tidak valid');const ok=amount<0?this.approver('cashout',approval,{amount:-amount}):{payload:{}};return this.run('shift.cash',{amount,reason,...ok.payload},async op=>{const s=await this.shift();op.payload.shiftId=s.id;await this.db.cash.add({id:op.id,shiftId:s.id,amount,reason,actor:this.user.id,at:op.occurredAt,...('by' in ok&&{approvedBy:ok.by})})})}
 async closeShift(counted:number){money(counted);return this.run('shift.close',{counted},async op=>{const s=await this.shift(true);const orders=await this.db.orders.where('shiftId').equals(s.id).toArray();if(orders.some(o=>o.status==='open'))throw new Error('Selesaikan atau batalkan pesanan belum dibayar');const expected=expectedCash(s,orders,await this.db.cash.toArray());Object.assign(s,{status:'closed',counted,expected,variance:counted-expected,closedAt:op.occurredAt});op.payload.id=s.id;await this.db.shifts.put(s);return s})}
 async publish(menu:MenuItem[],stock:StockItem[]){this.manager(true)
  // "Tambah pilihan" starts a blank row, and older builds saved untouched ones; one of those anywhere
  // in the menu then blocked every later save. Nameless, free and untracked is not an add-on: drop it.
  menu=menu.map(m=>({...m,modifiers:m.modifiers.filter(x=>x.name.trim()||x.price||x.recipe.length)}))
  checkCatalog(menu,stock);return this.run('catalog.publish',{menu,stock},async()=>{await this.db.menu.clear();await this.db.menu.bulkPut(menu);await this.db.stock.bulkPut(stock)})}
 async settings(settings:Settings){this.manager(true);return this.run('settings.update',{settings},async()=>{await this.db.settings.put(settings)})}
 // Mirrors purchase_total on the server: known items, one line per item, whole amounts.
 private async purchaseTotal(lines:PurchaseLine[]){const known=new Set((await this.db.stock.toArray()).map(s=>s.id))
  if(!lines.length||lines.length>100||new Set(lines.map(l=>l.stockId)).size<lines.length||lines.some(l=>!known.has(l.stockId)||!Number.isSafeInteger(l.qty)||l.qty<1||l.qty>1e12||!Number.isSafeInteger(l.cost)||l.cost<0||l.cost>MAX_MONEY))throw new Error('Periksa baris pembelian: satu bahan per baris, jumlah lebih dari 0, harga Rp0 atau lebih')
  const total=lines.reduce((n,l)=>n+l.cost,0);if(total>MAX_MONEY)throw new Error('Total pembelian terlalu besar');return total}
 // Cash in or out of the drawer belongs to the operator's own open shift, like the server requires.
 private async drawer(op:Operation,amount:number,reason:string){const s=await this.shift();op.payload.shiftId=s.id;await this.db.cash.add({id:op.id,shiftId:s.id,amount,reason,actor:this.user.id,at:op.occurredAt})}
 private async costs(){const seed=await this.db.meta.get('costs');return unitCosts(await this.db.movements.toArray(),seed?JSON.parse(seed.value):{})}
 async saveSupplier(input:Supplier){this.manager();const v={...input,name:input.name.trim(),phone:input.phone.trim(),address:input.address.trim(),note:input.note.trim()}
  if(!v.name||v.name.length>100||v.phone.length>30||!/^[0-9+ ()-]*$/.test(v.phone)||v.address.length>200||v.note.length>300)throw new Error('Isi nama pemasok; telepon hanya angka, spasi, +, -, dan tanda kurung')
  return this.run('supplier.save',{supplier:v},async()=>{await this.db.suppliers.put(v);return v})}
 async savePurchase(input:{id?:string;supplierId?:string;supplier:string;note:string;lines:PurchaseLine[]}){this.manager();const supplier=input.supplier.trim(),note=input.note.trim()
  if(!supplier||supplier.length>100||note.length>300)throw new Error('Isi nama pemasok (maks. 100 karakter); catatan maks. 300 karakter')
  if(input.supplierId&&!await this.db.suppliers.get(input.supplierId))throw new Error('Pemasok tidak ditemukan')
  const total=await this.purchaseTotal(input.lines)
  return this.run('purchase.save',{},async op=>{const old=input.id?await this.db.purchaseOrders.get(input.id):undefined
   if(input.id&&old?.status!=='ordered')throw new Error('PO yang sudah menerima barang tidak dapat diubah')
   const po:PurchaseOrder={id:old?.id||uid(),number:old?.number||`PO-${op.id.slice(0,8).toUpperCase()}`,...(input.supplierId&&{supplierId:input.supplierId}),supplier,note,lines:input.lines,total,receipts:[],payments:[],status:'ordered',revision:(old?.revision||0)+1,createdAt:old?.createdAt||op.occurredAt,updatedAt:op.occurredAt}
   op.payload={order:po,expectedRevision:old?.revision||0};await this.db.purchaseOrders.put(po);return po})}
 // One delivery: stock and cost follow what arrived. complete = no more is coming for this PO.
 async receivePurchase(id:string,lines:PurchaseLine[],payment:Payment['from']|'unpaid',complete=false){this.manager();const amount=await this.purchaseTotal(lines)
  return this.run('purchase.receive',{id,lines,payment,complete},async op=>{const po=await this.db.purchaseOrders.get(id);if(!po||!['ordered','partial'].includes(po.status))throw new Error('PO ini tidak menunggu kiriman')
   if(lines.some(l=>!po.lines.some(o=>o.stockId===l.stockId)))throw new Error('Kiriman berisi bahan yang tidak ada di PO')
   op.payload={...op.payload,expectedRevision:po.revision};const label=`${po.number} · ${po.supplier}`
   for(const l of lines)await this.db.movements.add({id:`${op.id}-${l.stockId}`,stockId:l.stockId,qty:l.qty,kind:'purchase',reason:label,actor:this.user.id,at:op.occurredAt,recordId:po.id,cost:l.cost})
   po.receipts=[...po.receipts,{at:op.occurredAt,lines}]
   if(payment!=='unpaid'&&amount>0){po.payments=[...po.payments,{at:op.occurredAt,amount,from:payment}];if(payment==='drawer')await this.drawer(op,-amount,`Pembelian ${label}`)}
   po.status=complete||po.lines.every(o=>receivedQty(po,o.stockId)>=o.qty)?'received':'partial'
   Object.assign(po,{revision:po.revision+1,updatedAt:op.occurredAt});await this.db.purchaseOrders.put(po);return po})}
 // Nothing arrived yet: cancelled. Part arrived: closed short, the rest is no longer expected.
 async cancelPurchase(id:string,reason:string){this.manager();if(!reason.trim())throw new Error('Alasan wajib')
  return this.run('purchase.cancel',{id,reason},async op=>{const po=await this.db.purchaseOrders.get(id);if(!po||!['ordered','partial'].includes(po.status))throw new Error('PO ini sudah selesai')
   op.payload={...op.payload,expectedRevision:po.revision};Object.assign(po,po.status==='ordered'?{status:'cancelled',cancelReason:reason}:{status:'received',closeReason:reason},{revision:po.revision+1,updatedAt:op.occurredAt});await this.db.purchaseOrders.put(po)})}
 async payPurchase(id:string,amount:number,payment:Payment['from']){this.manager()
  return this.run('purchase.pay',{id,amount,payment},async op=>{const po=await this.db.purchaseOrders.get(id)
   if(!po||!['partial','received'].includes(po.status)||!Number.isSafeInteger(amount)||amount<1||amount>receivedValue(po)-paidValue(po))throw new Error('Jumlah melebihi yang masih harus dibayar')
   op.payload={...op.payload,expectedRevision:po.revision};const label=`${po.number} · ${po.supplier}`
   if(payment==='drawer')await this.drawer(op,-amount,`Pembelian ${label}`)
   Object.assign(po,{payments:[...po.payments,{at:op.occurredAt,amount,from:payment}],revision:po.revision+1,updatedAt:op.occurredAt});await this.db.purchaseOrders.put(po)})}
 // One production run: the inputs actually used and the actual yield, which a recipe only estimates.
 // Its cost is the inputs at their latest price; the server works out the same figure itself.
 async produce(stockId:string,qty:number,inputs:Ingredient[],note:string){this.manager();note=note.trim()
  const stock=await this.db.stock.toArray(),item=stock.find(s=>s.id===stockId),known=new Set(stock.map(s=>s.id))
  if(!item||!Number.isSafeInteger(qty)||qty<1||qty>1e12)throw new Error('Isi hasil produksi lebih dari 0')
  if(!inputs.length||inputs.length>100||new Set(inputs.map(i=>i.stockId)).size<inputs.length||inputs.some(i=>i.stockId===stockId||!known.has(i.stockId)||!Number.isSafeInteger(i.qty)||i.qty<1||i.qty>1e9)||note.length>200)throw new Error('Periksa bahan produksi: jumlah lebih dari 0, tanpa bahan ganda')
  const prices=await this.costs(),cost=Math.min(MAX_MONEY,Math.round(inputs.reduce((n,i)=>n+i.qty*(prices.get(i.stockId)??0),0)))
  return this.run('production.record',{stockId,qty,inputs,note},async op=>{const reason=`Produksi ${item.name}${note?` · ${note}`:''}`
   for(const m of [{stockId,qty,cost},...inputs.map(i=>({stockId:i.stockId,qty:-i.qty,cost:0}))])await this.db.movements.add({id:`${op.id}-${m.stockId}`,stockId:m.stockId,qty:m.qty,kind:'production',reason,actor:this.user.id,at:op.occurredAt,recordId:op.id,cost:m.cost})
   return cost})}
 // Mirrors op_sales_order: lines must match this device's catalog, totals use the restaurant's
 // charges, and a total can never drop below what the customer already paid.
 async saveSalesOrder(input:{id?:string;customer:SalesOrder['customer'];deliverAt:string;lines:SalesLine[];discount:number;note:string}){this.manager()
  const customer={name:input.customer.name.trim(),phone:input.customer.phone.trim(),address:input.customer.address.trim()},note=input.note.trim()
  if(!customer.name||customer.name.length>100||customer.phone.length>30||customer.address.length>300||note.length>500||Number.isNaN(Date.parse(input.deliverAt)))throw new Error('Isi nama pelanggan dan waktu kirim')
  const menu=await this.db.menu.toArray(),settings=await this.db.settings.get('settings');if(!settings)throw new Error('Selesaikan pengaturan restoran')
  if(!input.lines.length||input.lines.length>200||input.lines.some(l=>{const m=menu.find(m=>m.id===l.itemId);return !m||m.version!==l.catalogVersion||m.name!==l.name||!Number.isInteger(l.qty)||l.qty<1||l.qty>999||!Number.isSafeInteger(l.price)||l.price<0||l.price>MAX_MONEY}))throw new Error('Periksa menu pesanan: jumlah 1–999 per baris, harga Rp0 atau lebih')
  const sum=totals(input.lines.map(l=>({...l,modifiers:[],cancelled:false})),money(input.discount),settings)
  return this.run('salesorder.save',{},async op=>{const old=input.id?await this.db.salesOrders.get(input.id):undefined
   if(input.id&&old?.status!=='confirmed')throw new Error('Pesanan yang sudah dikirim atau dibatalkan tidak dapat diubah')
   if(old&&sum.total<paidValue(old))throw new Error('Total tidak boleh di bawah uang yang sudah dibayar pelanggan')
   const so:SalesOrder={id:old?.id||uid(),number:old?.number||`SO-${op.id.slice(0,8).toUpperCase()}`,customer,deliverAt:new Date(input.deliverAt).toISOString(),lines:input.lines,discount:input.discount,note,totals:sum,payments:old?.payments||[],status:'confirmed',revision:(old?.revision||0)+1,createdAt:old?.createdAt||op.occurredAt,updatedAt:op.occurredAt}
   op.payload={order:so,expectedRevision:old?.revision||0};await this.db.salesOrders.put(so);return so})}
 async paySalesOrder(id:string,amount:number,payment:Payment['from']){this.manager()
  return this.run('salesorder.pay',{id,amount,payment},async op=>{const so=await this.db.salesOrders.get(id)
   if(!so||so.status==='cancelled'||!Number.isSafeInteger(amount)||amount<1||amount>so.totals.total-paidValue(so))throw new Error('Jumlah melebihi sisa tagihan')
   op.payload={...op.payload,expectedRevision:so.revision}
   if(payment==='drawer')await this.drawer(op,amount,`Pembayaran ${so.number} · ${so.customer.name}`)
   Object.assign(so,{payments:[...so.payments,{at:op.occurredAt,amount,from:payment}],revision:so.revision+1,updatedAt:op.occurredAt});await this.db.salesOrders.put(so)})}
 async deliverSalesOrder(id:string){this.manager()
  return this.run('salesorder.deliver',{id},async op=>{const so=await this.db.salesOrders.get(id);if(!so||so.status!=='confirmed')throw new Error('Pesanan ini tidak menunggu pengiriman')
   op.payload={...op.payload,expectedRevision:so.revision};const menu=await this.db.menu.toArray(),use=new Map<string,number>()
   for(const l of so.lines)for(const r of menu.find(m=>m.id===l.itemId&&m.version===l.catalogVersion)?.recipe??[])use.set(r.stockId,(use.get(r.stockId)||0)+r.qty*l.qty)
   for(const [stockId,qty] of use)await this.db.movements.add({id:`${op.id}-${stockId}`,stockId,qty:-qty,kind:'preparation',reason:`Pesanan ${so.number} · ${so.customer.name}`,actor:this.user.id,at:op.occurredAt,recordId:so.id,cost:0})
   Object.assign(so,{status:'delivered',deliveredAt:op.occurredAt,revision:so.revision+1,updatedAt:op.occurredAt});await this.db.salesOrders.put(so)})}
 async cancelSalesOrder(id:string,reason:string,refund=0,payment:Payment['from']='outside'){this.manager();if(!reason.trim())throw new Error('Alasan wajib')
  return this.run('salesorder.cancel',{id,reason,...(refund>0&&{refund,payment})},async op=>{const so=await this.db.salesOrders.get(id)
   if(!so||so.status!=='confirmed')throw new Error('Hanya pesanan yang belum dikirim yang dapat dibatalkan')
   if(!Number.isSafeInteger(refund)||refund<0||refund>paidValue(so))throw new Error('Pengembalian melebihi uang yang dibayar')
   op.payload={...op.payload,expectedRevision:so.revision}
   if(refund>0&&payment==='drawer')await this.drawer(op,-refund,`Pengembalian DP ${so.number} · ${so.customer.name}`)
   Object.assign(so,{status:'cancelled',cancelReason:reason,payments:refund>0?[...so.payments,{at:op.occurredAt,amount:-refund,from:payment}]:so.payments,revision:so.revision+1,updatedAt:op.occurredAt});await this.db.salesOrders.put(so)})}
 // Linked outlets and both directions of transfers, read from the server when the page opens.
 async refreshTransfers(){if(this.user.demo||this.user.role==='cashier')return;this.online()
  const {data,error}=await supabase!.rpc('outlet_transfers');if(error)throw error
  await this.db.transaction('rw',this.db.transfers,this.db.meta,async()=>{await this.db.transfers.bulkPut(data.transfers);await this.db.meta.put({id:'outlets',value:JSON.stringify(data.outlets)})})}
 async sendTransfer(to:Outlet,lines:{stockId:string;qty:number}[],note:string){this.manager();note=note.trim()
  const stock=await this.db.stock.toArray(),outlets:Outlet[]=JSON.parse((await this.db.meta.get('outlets'))?.value||'[]')
  if(!outlets.some(o=>o.id===to.id))throw new Error('Pilih outlet tujuan yang terhubung')
  if(!lines.length||lines.length>100||new Set(lines.map(l=>l.stockId)).size<lines.length||lines.some(l=>!stock.some(s=>s.id===l.stockId)||!Number.isSafeInteger(l.qty)||l.qty<1||l.qty>1e12)||note.length>300)throw new Error('Periksa baris transfer: satu bahan per baris, jumlah lebih dari 0')
  const prices=await this.costs(),settings=await this.db.settings.get('settings')
  return this.run('transfer.send',{},async op=>{const number=`TR-${op.id.slice(0,8).toUpperCase()}`,id=uid()
   const t:Transfer={id,number,from:this.user.restaurantId,fromName:settings?.name||'',to:to.id,toName:to.name,note,status:'sent',sentAt:op.occurredAt,lines:lines.map(l=>{const s=stock.find(s=>s.id===l.stockId)!;return {stockId:s.id,name:s.name,unit:s.unit,qty:l.qty,value:Math.min(MAX_MONEY,Math.round(l.qty*(prices.get(s.id)??0)))}})}
   op.payload={transfer:{id,number,to:to.id,lines,note}}
   for(const l of t.lines)await this.db.movements.add({id:`${op.id}-${l.stockId}`,stockId:l.stockId,qty:-l.qty,kind:'transfer',reason:`Transfer ${number} ke ${to.name}`,actor:this.user.id,at:op.occurredAt,recordId:id,cost:l.value})
   await this.db.transfers.put(t);return t})}
 // Every sent line gets an answer: which item it becomes here (same unit) and how much arrived.
 async receiveTransfer(id:string,lines:{stockId:string;target:string;qty:number}[]){this.manager()
  const stock=await this.db.stock.toArray()
  return this.run('transfer.receive',{id,lines},async op=>{const t=await this.db.transfers.get(id)
   if(!t||t.status!=='sent'||t.to!==this.user.restaurantId)throw new Error('Transfer ini tidak sedang menuju outlet ini')
   const targets=lines.filter(l=>l.qty>0).map(l=>l.target)
   if(t.lines.some(s=>{const l=lines.find(l=>l.stockId===s.stockId);return !l||!Number.isSafeInteger(l.qty)||l.qty<0||l.qty>1e12||l.qty>0&&stock.find(x=>x.id===l.target)?.unit!==s.unit})||new Set(targets).size<targets.length)throw new Error('Pilih bahan dengan satuan yang sama untuk setiap baris, satu bahan per baris')
   for(const s of t.lines){const l=lines.find(l=>l.stockId===s.stockId)!;if(l.qty>0)await this.db.movements.add({id:`${op.id}-${l.target}`,stockId:l.target,qty:l.qty,kind:'transfer',reason:`Transfer ${t.number} dari ${t.fromName}`,actor:this.user.id,at:op.occurredAt,recordId:t.id,cost:Math.min(MAX_MONEY,Math.round(s.value*l.qty/s.qty))})}
   Object.assign(t,{status:'received',received:lines,receivedAt:op.occurredAt});await this.db.transfers.put(t)})}
 async cancelTransfer(id:string,reason:string){this.manager();if(!reason.trim())throw new Error('Alasan wajib')
  return this.run('transfer.cancel',{id,reason},async op=>{const t=await this.db.transfers.get(id)
   if(!t||t.status!=='sent'||t.from!==this.user.restaurantId)throw new Error('Hanya transfer keluar yang masih di jalan yang dapat dibatalkan')
   for(const l of t.lines)await this.db.movements.add({id:`${op.id}-${l.stockId}`,stockId:l.stockId,qty:l.qty,kind:'transfer',reason:`Transfer ${t.number} dibatalkan`,actor:this.user.id,at:op.occurredAt,recordId:t.id,cost:l.value})
   Object.assign(t,{status:'cancelled',cancelReason:reason});await this.db.transfers.put(t)})}
 private async openOrder(id:string){const o=await this.db.orders.get(id);if(!o||o.status!=='open')throw new Error('Pesanan tidak terbuka');return o}
}
