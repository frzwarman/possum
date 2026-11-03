import { describe,expect,it,vi } from 'vitest'
import { draft,identity,line,seed,tea,tick } from './offline-harness'
import { Commands,DEMO_PIN } from '../../src/lib/commands'
import { uid } from '../../src/lib/db'
import { MAX_MONEY } from '../../src/domain/calculate'
import { sampleMenu,stock as sampleStock } from '../../src/domain/sample'
import type { Approval,MenuItem,StockItem } from '../../src/domain/types'
// apply_operation marks these as rejected, and a rejected operation halts every later one in the
// outbox. So the device must refuse them up front instead of queueing them.
describe('nothing the server would reject reaches the outbox',()=>{
 it('closes a shift whose 12-hour authorization expired — the server accepts that close',async()=>{
  const {db,commands}=await seed(identity())
  const shift=await commands.openShift(200000);await tick()
  await db.shifts.update(shift.id,{expiresAt:new Date(Date.now()-60000).toISOString()})
  expect((await commands.closeShift(200000)).status).toBe('closed')
  expect((await db.outbox.orderBy('occurredAt').toArray()).map(o=>o.kind)).toEqual(['shift.open','shift.close'])
 })
 it('opens a shift only online — a shift.open synced more than 2 minutes late is rejected',async()=>{
  const {db,commands}=await seed(identity())
  vi.spyOn(navigator,'onLine','get').mockReturnValue(false)
  await expect(commands.openShift(200000)).rejects.toThrow('Tindakan ini perlu koneksi server')
  expect(await db.shifts.count()).toBe(0);expect(await db.outbox.count()).toBe(0)
 })
 it('voids or marks ready only inside the operator’s own, unexpired shift',async()=>{
  const {db,commands}=await seed(identity())
  const shift=await commands.openShift(200000);await tick()
  const order=await commands.save(draft([line()]));await tick()
  await commands.prepare(order.id);await tick()
  await db.shifts.update(shift.id,{expiresAt:new Date(Date.now()-60000).toISOString()})
  await expect(commands.ready(order.id)).rejects.toThrow('Otorisasi sif berakhir')
  await expect(commands.voidOrder(order.id,'Pelanggan batal')).rejects.toThrow('Otorisasi sif berakhir')
  expect((await db.outbox.orderBy('occurredAt').toArray()).map(o=>o.kind)).toEqual(['shift.open','order.save','order.prepare'])
 })
 it('publishes only a catalog the server accepts',async()=>{
  const {db,commands}=await seed(identity({role:'owner'}))
  const [first]=sampleMenu,oil=(threshold:number):StockItem=>({id:'oil',name:'Minyak',unit:'ml',threshold})
  const rejected:[string,MenuItem[],StockItem[]][]=[
   ['an add-on with a price but no name',[{...first,modifiers:[{id:'m1',name:'',price:3000,recipe:[]}]}],sampleStock],
   ['an add-on named only with spaces',[{...first,modifiers:[{id:'m1',name:'  ',price:3000,recipe:[]}]}],sampleStock],
   ['negative minimum stock',sampleMenu,[...sampleStock,oil(-5000)]],
   ['minimum stock from an emptied number field',sampleMenu,[...sampleStock,oil(NaN)]],
   ['price above the money ceiling',[{...first,price:MAX_MONEY+1}],sampleStock],
   ['recipe ingredient that does not exist',[{...first,recipe:[{stockId:'durian',qty:1000}]}],sampleStock],
  ]
  for(const [why,menu,stock] of rejected)await expect(commands.publish(menu,stock),why).rejects.toThrow()
  expect(await db.outbox.count()).toBe(0)
  await commands.publish(sampleMenu,[...sampleStock,oil(0)])
  expect(await db.outbox.count()).toBe(1)
 })
 it('drops untouched "Tambah pilihan" rows, also ones older builds saved on other items',async()=>{
  const {db,commands}=await seed(identity({role:'owner'}))
  const [first,second,...rest]=sampleMenu,blank={id:'blank',name:'',price:0,recipe:[]}
  await commands.publish([{...first,modifiers:[...first.modifiers,blank]},{...second,modifiers:[blank]},...rest],sampleStock)
  expect((await db.menu.get(first.id))?.modifiers).toEqual(first.modifiers)
  expect((await db.menu.get(second.id))?.modifiers).toEqual([])
  const op=(await db.outbox.toArray())[0]
  expect(JSON.stringify(op.payload)).not.toContain('"blank"')
 })
})
describe('one transaction per command',()=>{
 it('persists an optional menu photo without requiring one on other items',async()=>{
  const {db,commands}=await seed(identity({role:'owner'}))
  const photo='data:image/webp;base64,UklGRg=='
  await commands.publish([{...sampleMenu[0],photo},...sampleMenu.slice(1)],sampleStock)
  expect((await db.menu.get(sampleMenu[0].id))?.photo).toBe(photo)
  expect((await db.menu.get(sampleMenu[1].id))?.photo).toBeUndefined()
  expect((await db.outbox.filter((op) => op.kind === 'catalog.publish').count())).toBe(1)
 })
 it('writes the domain record and exactly one outbox entry',async()=>{
  const {db,commands}=await seed(identity())
  const shift=await commands.openShift(200000);await tick()
  expect(await db.shifts.count()).toBe(1)
  expect(await db.outbox.count()).toBe(1)
  const op=(await db.outbox.toArray())[0]
  expect(op.kind).toBe('shift.open');expect(op.state).toBe('pending');expect(op.attempts).toBe(0)
  expect(op.payload).toMatchObject({id:shift.id,opening:200000})
  const order=await commands.save(draft([line()]))
  expect(await db.orders.count()).toBe(1)
  expect(await db.outbox.count()).toBe(2)
  expect((await db.outbox.toArray()).filter(o=>o.kind==='order.save')).toHaveLength(1)
  expect(order.receiptId).toMatch(/^MJ-/)
 })
 it('rolls back the domain record when the mutation throws',async()=>{
  const {db,commands}=await seed(identity())
  await commands.openShift(200000);await tick()
  await expect(commands.save(draft([line({qty:0})]))).rejects.toThrow('Jumlah menu 1–999')
  expect(await db.orders.count()).toBe(0)
  expect(await db.drafts.count()).toBe(0)
  expect(await db.outbox.count()).toBe(1) // still only shift.open
 })
 it('rolls back a movement already written inside the aborted transaction',async()=>{
  // stockRecord adds the movement BEFORE it resolves the shift, so a missing shift aborts mid-write.
  const {db,commands}=await seed(identity())
  const before=await db.movements.count()
  await expect(commands.stockRecord('rice','purchase',5_000_000,'Beli beras',250000,true)).rejects.toThrow('Buka sif Anda terlebih dahulu')
  expect(await db.movements.count()).toBe(before)
  expect(await db.cash.count()).toBe(0)
  expect(await db.outbox.count()).toBe(0)
 })
 it('rejects an unknown ingredient without leaving anything behind',async()=>{
  const {db,commands}=await seed(identity())
  await expect(commands.stockRecord('durian','purchase',1000,'Beli durian')).rejects.toThrow('Bahan tidak ditemukan')
  expect(await db.movements.count()).toBe(sampleStock.length)
  expect(await db.outbox.count()).toBe(0)
 })
})
describe('preparation consumes ingredients exactly once',()=>{
 it('deducts at prepare, refuses a second prepare, and never deducts at payment',async()=>{
  const {db,commands}=await seed(identity())
  await commands.openShift(200000);await tick()
  const order=await commands.save(draft([line({qty:2}),tea()]));await tick()
  await commands.prepare(order.id);await tick()
  const consumed=await db.movements.where('recordId').equals(order.id).toArray()
  expect(consumed.map(m=>[m.stockId,m.qty]).sort()).toEqual([['rice',-200000],['tea',-1000]].sort())
  expect(consumed.every(m=>m.kind==='preparation')).toBe(true)
  await expect(commands.prepare(order.id)).rejects.toThrow('Tidak ada tambahan baru untuk disiapkan')
  expect(await db.movements.where('recordId').equals(order.id).count()).toBe(2)
  const paid=await commands.pay(order.id,'cash',100000,true)
  expect(paid.status).toBe('paid')
  expect(await db.movements.where('recordId').equals(order.id).count()).toBe(2)
 })
})
describe('refund never restores cooked stock',()=>{
 it('leaves the consumption movements negative and adds no positive movement',async()=>{
  const {db,commands}=await seed(identity())
  await commands.openShift(200000);await tick()
  const order=await commands.save(draft([line()]));await tick()
  await commands.prepare(order.id);await tick()
  await commands.pay(order.id,'cash',50000,true);await tick()
  await commands.refund(order.id,'Pelanggan komplain rasa')
  const after=await db.movements.where('recordId').equals(order.id).toArray()
  expect(after).toHaveLength(1)
  expect(after[0].qty).toBeLessThan(0)
  expect(after.some(m=>m.qty>0)).toBe(false)
  expect((await db.orders.get(order.id))!.status).toBe('refunded')
 })
 it('a void before preparation consumed nothing in the first place',async()=>{
  const {db,commands}=await seed(identity())
  await commands.openShift(200000);await tick()
  const order=await commands.save(draft([line()]));await tick()
  await commands.voidOrder(order.id,'Pelanggan batal pesan')
  expect(await db.movements.where('recordId').equals(order.id).count()).toBe(0)
  expect((await db.orders.get(order.id))!.status).toBe('void')
 })
})
describe('device, shift and role authorization',()=>{
 it('refuses every transaction on a non-primary device',async()=>{
  const {db,commands}=await seed(identity({primary:false}))
  await expect(commands.openShift(200000)).rejects.toThrow('Transaksi hanya di perangkat kasir utama')
  expect(await db.shifts.count()).toBe(0);expect(await db.outbox.count()).toBe(0)
 })
 it('blocks operations once the shift authorization has expired',async()=>{
  const {db,commands}=await seed(identity())
  const shift=await commands.openShift(200000);await tick()
  await db.shifts.update(shift.id,{expiresAt:new Date(Date.now()-60000).toISOString()})
  await expect(commands.save(draft([line()]))).rejects.toThrow('Otorisasi sif berakhir. Hubungkan internet dan tutup sif.')
  expect(await db.orders.count()).toBe(0)
 })
 it('denies manager-only actions to a cashier',async()=>{
  const user=identity({role:'cashier'})
  const {db,commands}=await seed(user)
  await commands.openShift(200000);await tick()
  const order=await commands.save(draft([line()]));await tick()
  // Discount, void and refund are possible for a cashier, but only with a manager's PIN approval.
  await expect(commands.save(draft([line()],{orderId:order.id,revision:order.revision,discount:5000,discountReason:'Langganan'}))).rejects.toThrow('Perlu persetujuan manajer')
  await expect(commands.voidOrder(order.id,'salah pesan')).rejects.toThrow('Perlu persetujuan manajer')
  await expect(commands.refund(order.id,'salah pesan')).rejects.toThrow('Perlu persetujuan manajer')
  await expect(commands.stockRecord('rice','waste',1000,'tumpah')).rejects.toThrow('Perlu akun manajer')
  await expect(commands.publish(sampleMenu,sampleStock)).rejects.toThrow('Perlu akun manajer')
  expect((await db.orders.get(order.id))!.discount).toBe(0)
  expect((await db.outbox.orderBy('occurredAt').toArray()).map(o=>o.kind)).toEqual(['shift.open','order.save'])
 })
 it('lets a manager do what the cashier could not, on the same database',async()=>{
  const user=identity()
  const {db,commands}=await seed(user)
  await commands.openShift(200000);await tick()
  const order=await commands.save(draft([line()]));await tick()
  const manager=new Commands(db,{...user,id:user.id,role:'manager'})
  await manager.voidOrder(order.id,'Pelanggan batal pesan')
  expect((await db.orders.get(order.id))!.voidReason).toBe('Pelanggan batal pesan')
 })
})

describe('a cashier needs a manager approval for exactly that action',()=>{
 const cashier=()=>seed(identity({role:'cashier',name:'Kasir Demo',demo:true}))
 async function openOrder(commands:Commands){await commands.openShift(200000);await tick();const order=await commands.save(draft([line()]));await tick();return order}
 it('voids only with a valid PIN approval for that order, and records the approver',async()=>{
  const {db,commands}=await cashier(),order=await openOrder(commands)
  await expect(commands.voidOrder(order.id,'Salah meja')).rejects.toThrow('Perlu persetujuan manajer')
  await expect(commands.approve('demo-owner','000000','void',{orderId:order.id})).rejects.toThrow('PIN salah')
  const elsewhere=await commands.approve('demo-owner',DEMO_PIN,'void',{orderId:'other-order'})
  await expect(commands.voidOrder(order.id,'Salah meja',elsewhere)).rejects.toThrow('Perlu persetujuan manajer')
  const approval=await commands.approve('demo-owner',DEMO_PIN,'void',{orderId:order.id})
  await commands.voidOrder(order.id,'Salah meja',approval)
  expect((await db.orders.get(order.id))?.voidApprovedBy).toBe('Pemilik Demo')
  expect((await db.outbox.toArray()).find(o=>o.kind==='order.void')?.payload).toMatchObject({id:order.id,approval:approval.id})
 })
 it('discounts only with an approval for exactly that amount, not older than 50 minutes',async()=>{
  const {db,commands}=await cashier();await commands.openShift(200000);await tick()
  const discounted=(approval?:Approval,amount=5000)=>draft([line()],{discount:amount,discountReason:'Langganan',discountApproval:approval})
  await expect(commands.save(discounted())).rejects.toThrow('Perlu persetujuan manajer')
  const approval=await commands.approve('demo-manager',DEMO_PIN,'discount',{amount:5000})
  await expect(commands.save(discounted(approval,4000))).rejects.toThrow('Perlu persetujuan manajer')
  await expect(commands.save(discounted({...approval,at:Date.now()-51*60000}))).rejects.toThrow('kedaluwarsa')
  const order=await commands.save(discounted(approval))
  expect(order.discountApprovedBy).toBe('Manajer Demo')
  expect((await db.outbox.toArray()).find(o=>o.kind==='order.save')?.payload.approval).toBe(approval.id)
  // Saving again without touching the discount needs no new approval and keeps the approver.
  await tick();const again=await commands.save({...discounted(),orderId:order.id,revision:order.revision,label:'Meja 2'})
  expect(again.discountApprovedBy).toBe('Manajer Demo')
 })
 it('takes cash out of the drawer only with an approval; cash in needs none',async()=>{
  const {db,commands}=await cashier();await commands.openShift(200000);await tick()
  await expect(commands.cashMove(-5000,'Es batu')).rejects.toThrow('Perlu persetujuan manajer')
  await commands.cashMove(-5000,'Es batu',await commands.approve('demo-owner',DEMO_PIN,'cashout',{amount:5000}));await tick()
  await commands.cashMove(5000,'Tukar kembalian')
  expect((await db.cash.toArray()).map(c=>[c.amount,c.approvedBy])).toEqual(expect.arrayContaining([[-5000,'Pemilik Demo'],[5000,undefined]]))
 })
 it('lets a manager act on their own authority',async()=>{
  const {db,commands}=await seed(identity({role:'manager',name:'Sari'})),order=await openOrder(commands)
  await commands.voidOrder(order.id,'Pelanggan batal')
  expect((await db.orders.get(order.id))?.voidApprovedBy).toBe('Sari')
 })
})
describe('ids',()=>{
 it('are UUID v4 even where crypto.randomUUID is missing (plain http on a LAN address)',()=>{
  const c=globalThis.crypto as {randomUUID?:unknown}
  Object.defineProperty(c,'randomUUID',{value:undefined,configurable:true})
  try{for(let i=0;i<50;i++)expect(uid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)}
  finally{delete c.randomUUID}
  expect(typeof crypto.randomUUID).toBe('function')
 })
})
describe('back office: purchase orders and production',()=>{
 const stockOf=async(db:Awaited<ReturnType<typeof seed>>['db'],id:string)=>(await db.movements.where('stockId').equals(id).toArray()).reduce((n,m)=>n+m.qty,0)
 it('receives a PO over several deliveries and pays what is owed in parts, drawer cash only in an open shift',async()=>{
  const {db,commands}=await seed(identity())
  await expect(commands.savePurchase({supplier:'Pasar',note:'',lines:[{stockId:'rice',qty:1000,cost:1},{stockId:'rice',qty:1000,cost:1}]})).rejects.toThrow('satu bahan per baris')
  const po=await commands.savePurchase({supplier:'  Pasar Cihapit ',note:'',lines:[{stockId:'rice',qty:10_000_000,cost:150000},{stockId:'egg',qty:30_000,cost:60000}]})
  expect([po.number,po.supplier,po.total,po.status]).toEqual([expect.stringMatching(/^PO-[0-9A-F]{8}$/),'Pasar Cihapit',210000,'ordered'])
  const rice=await stockOf(db,'rice')
  await expect(commands.receivePurchase(po.id,[{stockId:'rice',qty:5_000_000,cost:75000}],'drawer')).rejects.toThrow('Buka sif Anda terlebih dahulu')
  await commands.openShift(200000);await tick()
  const first=await commands.receivePurchase(po.id,[{stockId:'rice',qty:5_000_000,cost:75000}],'drawer');await tick()
  expect([first.status,first.receipts.length,first.payments.map(p=>p.amount)]).toEqual(['partial',1,[75000]])
  await expect(commands.receivePurchase(po.id,[{stockId:'tea',qty:1000,cost:1}],'unpaid')).rejects.toThrow('tidak ada di PO')
  await expect(commands.savePurchase({id:po.id,supplier:'Pasar',note:'',lines:po.lines})).rejects.toThrow('tidak dapat diubah')
  const done=await commands.receivePurchase(po.id,[{stockId:'rice',qty:5_000_000,cost:75000},{stockId:'egg',qty:30_000,cost:60000}],'unpaid');await tick()
  expect(done.status).toBe('received')
  expect(await stockOf(db,'rice')-rice).toBe(10_000_000)
  await expect(commands.payPurchase(po.id,135001,'outside')).rejects.toThrow('melebihi')
  await commands.payPurchase(po.id,100000,'outside');await tick()
  await commands.payPurchase(po.id,35000,'drawer')
  expect((await db.cash.toArray()).map(c=>c.amount).sort((a,b)=>a-b)).toEqual([-75000,-35000])
 })
 it('closes a partly delivered PO short, and cancels one where nothing came',async()=>{
  const {db,commands}=await seed(identity())
  const po=await commands.savePurchase({supplier:'CV Telur Jaya',note:'Tempo 7 hari',lines:[{stockId:'egg',qty:30_000,cost:60000}]})
  await commands.receivePurchase(po.id,[{stockId:'egg',qty:20_000,cost:40000}],'unpaid');await tick()
  await commands.cancelPurchase(po.id,'Sisa kosong')
  expect(await db.purchaseOrders.get(po.id)).toMatchObject({status:'received',closeReason:'Sisa kosong'})
  const never=await commands.savePurchase({supplier:'Pasar',note:'',lines:[{stockId:'rice',qty:1000,cost:1}]});await tick()
  await commands.cancelPurchase(never.id,'Pasar tutup')
  expect((await db.purchaseOrders.get(never.id))?.status).toBe('cancelled')
 })
 it('keeps supplier contacts, and a PO names a known supplier',async()=>{
  const {db,commands}=await seed(identity())
  await expect(commands.saveSupplier({id:'s1',name:'CV Beras',phone:'telepon saja',address:'',note:'',active:true})).rejects.toThrow('telepon')
  await commands.saveSupplier({id:'s1',name:' CV Beras ',phone:'0812-3456-7890',address:'Jl. Pasar 1',note:'',active:true});await tick()
  expect((await db.suppliers.get('s1'))?.name).toBe('CV Beras')
  await expect(commands.savePurchase({supplierId:'unknown',supplier:'X',note:'',lines:[{stockId:'rice',qty:1000,cost:1}]})).rejects.toThrow('Pemasok tidak ditemukan')
  expect((await commands.savePurchase({supplierId:'s1',supplier:'CV Beras',note:'',lines:[{stockId:'rice',qty:1000,cost:1}]})).supplierId).toBe('s1')
 })
 it('produces from batch inputs at their latest price, never from itself, and only for managers',async()=>{
  const {db,commands}=await seed(identity({role:'owner'}))
  const sambal:StockItem={id:'sambal',name:'Sambal ijo (porsi)',unit:'pcs',threshold:0,production:{inputs:[{stockId:'egg',qty:2000}],output:10_000}}
  await expect(commands.publish(sampleMenu,[...sampleStock,{...sambal,production:{inputs:[{stockId:'sambal',qty:1000}],output:1000}}])).rejects.toThrow('Resep produksi')
  await commands.publish(sampleMenu,[...sampleStock,sambal]);await tick()
  const egg=await stockOf(db,'egg')
  await commands.produce('sambal',20_000,[{stockId:'egg',qty:4000}],' 2 batch ')
  expect([await stockOf(db,'sambal'),egg-await stockOf(db,'egg')]).toEqual([20_000,4000])
  expect((await db.movements.where('stockId').equals('sambal').first())?.reason).toBe('Produksi Sambal ijo (porsi) · 2 batch')
  // Eggs bought at Rp2.000 each make the next batch cost Rp4.000 per 2 eggs.
  const po=await commands.savePurchase({supplier:'Pasar',note:'',lines:[{stockId:'egg',qty:10_000,cost:20000}]});await tick()
  await commands.receivePurchase(po.id,po.lines,'unpaid');await tick()
  expect(await commands.produce('sambal',10_000,[{stockId:'egg',qty:2000}],'')).toBe(4000)
  await expect(commands.produce('sambal',1000,[{stockId:'sambal',qty:1000}],'')).rejects.toThrow('Periksa bahan produksi')
  const {commands:cashier}=await seed(identity({role:'cashier'}))
  await expect(cashier.produce('egg',1000,[{stockId:'rice',qty:1000}],'')).rejects.toThrow('Perlu akun manajer')
  await expect(cashier.savePurchase({supplier:'Pasar',note:'',lines:[{stockId:'rice',qty:1000,cost:1}]})).rejects.toThrow('Perlu akun manajer')
 })
})

describe('catering orders and transfers between outlets',()=>{
 const stockOf=async(db:Awaited<ReturnType<typeof seed>>['db'],id:string)=>(await db.movements.where('stockId').equals(id).toArray()).reduce((n,m)=>n+m.qty,0)
 it('takes a down payment, uses the menu recipes on delivery, and is settled later',async()=>{
  const {db,commands}=await seed(identity())
  const nasi=sampleMenu.find(m=>m.id==='nasi-goreng')!,lines=[{id:'l1',itemId:nasi.id,name:nasi.name,qty:40,price:20000,catalogVersion:nasi.version}]
  await expect(commands.saveSalesOrder({customer:{name:'',phone:'',address:''},deliverAt:new Date().toISOString(),lines,discount:0,note:''})).rejects.toThrow('nama pelanggan')
  await expect(commands.saveSalesOrder({customer:{name:'PT Maju',phone:'',address:''},deliverAt:new Date().toISOString(),lines:[{...lines[0],catalogVersion:99}],discount:0,note:''})).rejects.toThrow('Periksa menu')
  const so=await commands.saveSalesOrder({customer:{name:'PT Maju',phone:'0812',address:'Jl. A'},deliverAt:new Date(Date.now()+86400000).toISOString(),lines,discount:50000,note:''});await tick()
  expect([so.number,so.totals.total]).toEqual([expect.stringMatching(/^SO-[0-9A-F]{8}$/),750000])
  await commands.paySalesOrder(so.id,250000,'outside');await tick()
  await expect(commands.paySalesOrder(so.id,500001,'outside')).rejects.toThrow('sisa tagihan')
  const rice=await stockOf(db,'rice')
  await commands.deliverSalesOrder(so.id);await tick()
  expect(rice-await stockOf(db,'rice')).toBe(40*100000)
  await expect(commands.cancelSalesOrder(so.id,'Batal')).rejects.toThrow('belum dikirim')
  await commands.paySalesOrder(so.id,500000,'outside')
  expect((await db.salesOrders.get(so.id))?.payments.map(p=>p.amount)).toEqual([250000,500000])
 })
 it('sends stock to a linked outlet and books an incoming transfer onto items with the same unit',async()=>{
  const {db,commands}=await seed(identity())
  await db.meta.put({id:'outlets',value:JSON.stringify([{id:'cabang',name:'Cabang Dago'}])})
  await expect(commands.sendTransfer({id:'unlinked',name:'X'},[{stockId:'rice',qty:1000}],'')).rejects.toThrow('outlet tujuan')
  const rice=await stockOf(db,'rice')
  const sent=await commands.sendTransfer({id:'cabang',name:'Cabang Dago'},[{stockId:'rice',qty:2_000_000}],'');await tick()
  expect([sent.status,rice-await stockOf(db,'rice')]).toEqual(['sent',2_000_000])
  await commands.cancelTransfer(sent.id,'Kurir batal');await tick()
  expect(await stockOf(db,'rice')).toBe(rice)
  const user=commands.user
  await db.transfers.put({id:'in-1',number:'TR-IN000001',from:'cabang',fromName:'Cabang Dago',to:user.restaurantId,toName:'',note:'',status:'sent',sentAt:new Date().toISOString(),lines:[{stockId:'beras-cabang',name:'Beras',unit:'g',qty:1_000_000,value:15000}]})
  await expect(commands.receiveTransfer('in-1',[{stockId:'beras-cabang',target:'egg',qty:1_000_000}])).rejects.toThrow('satuan yang sama')
  await commands.receiveTransfer('in-1',[{stockId:'beras-cabang',target:'rice',qty:900_000}])
  expect(await stockOf(db,'rice')-rice).toBe(900_000)
  expect((await db.movements.toArray()).find(m=>m.kind==='transfer'&&m.qty===900_000)?.cost).toBe(13500)
 })
})
