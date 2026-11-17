import { useRef,useState } from 'react'
import { Link,Navigate } from '@tanstack/react-router'
import { Package,Plus,ArrowDownLeft,History,AlertTriangle,Camera,Trash2,CookingPot,ClipboardList,Search,Check,Truck,Coffee,Clock,ArrowRight } from 'lucide-react'
import { useApp } from '../../app/context'
import { Button } from '../../components/ui/button'
import { Money } from '../../components/ui/money'
import { Select } from '../../components/ui/select'
import { Dialog } from '../../components/ui/dialog'
import { convert,daysLeft,expiring,prepList,quantity,rupiah,sanity,search,usagePerDay,when } from '../../domain/calculate'
import { compressMenuPhoto } from '../../lib/menu-photo'
import type { Movement,StockItem } from '../../domain/types'
import { can } from '../../domain/permissions'
import { PrepDialog,amount } from '../production/Production'
const WASTE=['Rusak','Jatuh','Salah pesanan','Kedaluwarsa','Makan staf']
const kinds:Record<Movement['kind'],string>={purchase:'Kiriman',opening:'Saldo awal',waste:'Terbuang',count:'Hitung',adjustment:'Penyesuaian',preparation:'Penjualan',production:'Produksi',transfer:'Transfer'}
// A movement in plain words: the kind first unless the reason already says it ("Hitung Dry store", "Transfer TR-1").
const event=(m:Movement)=>m.kind==='preparation'&&m.reason.startsWith('Persiapan ')?`Penjualan ${m.reason.slice(10)}`:m.reason.toLowerCase().startsWith(kinds[m.kind].toLowerCase())?m.reason:`${kinds[m.kind]}: ${m.reason}`
const words=(xs:string[])=>xs.length>1?`${xs.slice(0,-1).join(', ')} dan ${xs.at(-1)}`:xs[0]??''
// F5: ingredients bought in packs, stocked in g / ml / pcs; every movement with who and when; a
// delivery that looks wrong (PUR-4) needs a second tap before it enters stock.
// Figma C7: what is out or running low first, the count before closing and the prep list beside it, then every ingredient.
// Figma M6: tapping an ingredient shows it on this page (no route), with every movement and a running balance.
export default function Inventory(){
 const {stockItems,movements,settings,commands,act,busy,shift,shifts,orders,user,balance,costs,menu,canMake,counts,purchaseOrders}=useApp()
 const [selected,setSelected]=useState<StockItem>();const [detail,setDetail]=useState<string>();const [prep,setPrep]=useState<{item?:StockItem;batches?:number}>()
 const [kind,setKind]=useState<'purchase'|'waste'|'count'|'adjustment'|'opening'>('purchase');const [amountText,setAmount]=useState('');const [unit,setUnit]=useState('');const [reason,setReason]=useState('');const [cost,setCost]=useState('0');const [drawer,setDrawer]=useState(false);const [negative,setNegative]=useState(false);const [photo,setPhoto]=useState<string>();const [photoBusy,setPhotoBusy]=useState(false)
 const [confirm,setConfirm]=useState<'high'|'low'>()
 const [low,setLow]=useState(false);const [area,setArea]=useState('');const [query,setQuery]=useState('');const find=useRef<HTMLInputElement>(null)
 // Pilot rule: deliveries and adjustments are manager work and stay off the till while a shift is open.
 const inventory=can(user.role,'inventory')&&!(user.primary&&shift),waste=can(user.role,'waste')
 if(!inventory&&!waste)return <Navigate to="/pos"/>
 const areas=[...new Set(stockItems.map(s=>s.area).filter((a):a is string=>Boolean(a)))].sort()
 const shown=search(stockItems.filter(s=>(!low||balance(s.id)<=s.threshold)&&(!area||s.area===area)),query)
 const units=(s:StockItem)=>[{value:s.unit,label:s.unit},...(s.unit==='g'?[{value:'kg',label:'kg (1.000 g)'}]:s.unit==='ml'?[{value:'l',label:'liter (1.000 ml)'}]:[]),...(s.packs??[]).map(p=>({value:p.name,label:`${p.name} (${quantity(p.qty)} ${s.unit})`}))]
 const deliveries=(id:string)=>movements.filter(m=>m.stockId===id&&m.kind==='purchase'&&m.qty>0).sort((a,b)=>a.at.localeCompare(b.at)).map(m=>m.qty)
 const pace=(s:StockItem)=>daysLeft(balance(s.id),usagePerDay(movements,s.id))
 function open(s:StockItem){setSelected(s);setAmount('');setUnit(s.packs?.[0]?.name??s.unit);setKind(inventory?'purchase':'waste');setReason('');setCost('0');setDrawer(false);setNegative(false);setPhoto(undefined);setConfirm(undefined)}
 const parsed=()=>{if(!selected)return 0;try{return amountText==='0'||amountText===''?0:convert(amountText,unit,selected.unit,selected.packs)}catch{return 0}}
 async function save(){if(!selected)return
  await act(async()=>{let qty=kind==='count'&&amountText.trim()==='0'?0:convert(amountText,unit,selected.unit,selected.packs)
   if(kind==='adjustment'&&negative)qty=-qty
   // PUR-4: over 5× or under ⅕ of the usual delivery stops here once; the second tap confirms it.
   if(kind==='purchase'&&!confirm){const verdict=sanity(qty,deliveries(selected.id));if(verdict!=='ok'){setConfirm(verdict);throw new Error(verdict==='high'?`Jumlahnya ${quantity(qty)} ${selected.unit}, jauh di atas kiriman biasanya. Periksa satuan, lalu tekan lagi untuk menyimpan.`:`Jumlahnya ${quantity(qty)} ${selected.unit}, jauh di bawah kiriman biasanya. Periksa satuan, lalu tekan lagi untuk menyimpan.`)}}
   await commands.stockRecord(selected.id,kind,qty,reason,Number(cost),drawer&&kind==='purchase',photo);setSelected(undefined)},'Pergerakan stok tersimpan')}
 async function choosePhoto(file:File){setPhotoBusy(true);try{setPhoto(await compressMenuPhoto(file))}catch(e){setConfirm(undefined);throw e}finally{setPhotoBusy(false)}}
 const running=(id:string)=>{let n=0;return movements.filter(m=>m.stockId===id).sort((a,b)=>a.at.localeCompare(b.at)).map(m=>({...m,after:(n+=m.qty)})).reverse().slice(0,100)}
 const tz=settings?.timezone,day=(iso:string)=>when(iso,tz,{dateStyle:'short'}),today=day(new Date().toISOString())
 const clock=(iso:string)=>when(iso,tz,{hour:'2-digit',minute:'2-digit'}),date=(iso:string)=>day(iso)===today?'':`${when(iso,tz,{weekday:'short',day:'numeric',month:'short'})} `
 const show=(s:StockItem)=>{setDetail(s.id);document.getElementById('main')?.scrollTo(0,0)}
 const made=stockItems.filter(s=>s.production),todo=prepList(stockItems,balance),soon=expiring(stockItems,movements,2)
 const record=<>
  <Dialog open={Boolean(selected)} onOpenChange={()=>setSelected(undefined)} title={selected?.name||'Catat stok'} description="Setiap perubahan memiliki alasan dan jejak pencatatan.">
   {selected&&<>
    <Select label="Jenis pencatatan" value={kind} onChange={v=>{setKind(v as typeof kind);setConfirm(undefined)}} options={[...(inventory?[{value:'purchase',label:'Kiriman / pembelian'},{value:'opening',label:'Saldo awal'}]:[]),{value:'waste',label:'Terbuang / rusak'},...(inventory?[{value:'count',label:'Hasil hitung fisik'},{value:'adjustment',label:'Penyesuaian'}]:[])]}/>
    <div className="form-grid">
     <label>{kind==='count'?'Jumlah fisik saat ini':'Jumlah'}<input inputMode="decimal" value={amountText} onChange={e=>{setAmount(e.target.value);setConfirm(undefined)}} placeholder="0"/></label>
     <Select label="Satuan" value={unit} onChange={v=>{setUnit(v);setConfirm(undefined)}} options={units(selected)}/>
    </div>
    {amountText&&<p className="small muted">= {quantity(parsed())} {selected.unit}{kind==='count'?` (sekarang ${quantity(balance(selected.id))} ${selected.unit})`:''}</p>}
    {kind==='adjustment'&&<label className="check-row"><input type="checkbox" checked={negative} onChange={e=>setNegative(e.target.checked)}/>Kurangi stok</label>}
    {kind==='waste'?<><div className="reason-chips">{WASTE.map(r=><button key={r} className={reason===r?'active':''} onClick={()=>setReason(r)}>{r}</button>)}</div><label>Catatan (opsional)<input value={WASTE.includes(reason)?'':reason} onChange={e=>setReason(e.target.value)} placeholder="atau tulis alasan lain"/></label></>
    :<label>{kind==='purchase'?'Pemasok / nota':'Alasan'}<input value={reason} onChange={e=>setReason(e.target.value)} placeholder={kind==='purchase'?'Contoh: CV Beras Makmur, nota 1203':'Contoh: hitung ulang rak'}/></label>}
    {kind==='purchase'&&<>
     <label>Harga total kiriman<Money value={cost} onChange={setCost}/></label>
     {parsed()>0&&Number(cost)>0&&<p className="small muted">≈ {rupiah(Math.round(Number(cost)*1000/parsed()))}/{selected.unit}</p>}
     <label className="photo-upload"><Camera size={18}/>{photoBusy?'Memperkecil foto…':photo?'Ganti foto nota':'Foto nota kiriman (opsional)'}<input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={photoBusy} onChange={e=>{const f=e.target.files?.[0];if(f)void act(()=>choosePhoto(f));e.currentTarget.value=''}}/></label>
     {photo&&<div className="button-row"><img className="admin-menu-thumb" src={photo} alt="Nota kiriman"/><Button type="button" variant="ghost" size="sm" onClick={()=>setPhoto(undefined)}><Trash2 size={15}/> Hapus foto</Button></div>}
     <label className="check-row"><input type="checkbox" disabled={!shift||shift.actor!==user.id} checked={drawer} onChange={e=>setDrawer(e.target.checked)}/>Dibayar dari laci kas sif saya</label>
    </>}
    {confirm&&<p className="callout"><AlertTriangle size={18}/> {confirm==='high'?'Lebih dari 5× kiriman biasanya.':'Kurang dari ⅕ kiriman biasanya.'} Biasanya sekitar {quantity(deliveries(selected.id).slice(-5).sort((a,b)=>a-b)[Math.floor(Math.min(5,deliveries(selected.id).length)/2)]??0)} {selected.unit}. Tekan sekali lagi bila memang benar.</p>}
    <Button loading={busy} disabled={busy||!amountText||!reason.trim()} className="full" onClick={()=>save()}><ArrowDownLeft size={18}/> {confirm?'Ya, jumlahnya benar':'Simpan pergerakan'}</Button>
   </>}
  </Dialog>
  <PrepDialog open={Boolean(prep)} item={prep?.item} batches={prep?.batches} onClose={()=>setPrep(undefined)}/>
 </>
 const item=stockItems.find(s=>s.id===detail)
 if(item){
  const b=balance(item.id),d=pace(item),pack=item.packs?.[0],moves=running(item.id),big=item.unit==='ml'?'L':item.unit==='g'?'kg':'pcs'
  const names=new Map<string,string>([...shifts.map(s=>[s.actor,s.cashier] as const),...orders.map(o=>[o.actor,o.cashier] as const),[user.id,user.name]])
  const uses=menu.filter(m=>m.active&&(m.recipe.some(r=>r.stockId===item.id&&r.qty>0)||m.modifiers.some(x=>x.recipe.some(r=>r.stockId===item.id&&r.qty>0)))),preps=made.filter(s=>s.production!.inputs.some(i=>i.stockId===item.id))
  // Compare suppliers only from real purchase orders: each supplier's latest price for this ingredient, and how long it took to arrive.
  const offers=[...purchaseOrders.filter(po=>po.status!=='cancelled').sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).reduce((m,po)=>{const l=po.lines.find(l=>l.stockId===item.id&&l.qty>0&&l.cost>0),r=po.receipts.find(r=>r.lines.some(x=>x.stockId===item.id));if(l)m.set(po.supplier,{supplier:po.supplier,qty:l.qty,cost:l.cost,per:l.cost/l.qty*(item.unit==='pcs'?1000:1_000_000),lead:r&&Math.round((Date.parse(r.at)-Date.parse(po.createdAt))/86_400_000)});return m},new Map<string,{supplier:string;qty:number;cost:number;per:number;lead?:number}>()).values()]
  const cheapest=Math.min(...offers.map(o=>o.per)),waiting=purchaseOrders.some(po=>(po.status==='ordered'||po.status==='partial')&&po.lines.some(l=>l.stockId===item.id))
  const order=b<=item.threshold&&pack?`Pesan ${Math.max(1,Math.ceil((2*item.threshold-b)/pack.qty))} ${pack.name}`:'Pesan stok'
  // The area chip takes its station's colour (Figma "• Bar fridge"): the item's own, else the one station every dish using it goes to.
  const station=item.station??(uses.length&&uses.every(m=>m.station===uses[0].station)?uses[0].station:undefined)
  return <section className="page-content stock-page stock-detail">
   <div className="page-heading"><div><button type="button" className="crumb" aria-label="Kembali ke Stok" onClick={()=>setDetail(undefined)}>Stok</button>
    <div className="title-row"><h1>{item.name}</h1>{b<=0?<span className="dot-chip critical">Habis</span>:b<=item.threshold?<span className="dot-chip warning">Di bawah par</span>:<span className="dot-chip good">Aman</span>}{item.area&&<span className={`dot-chip ${station??''}`}>{item.area}</span>}</div></div>
    <div className="button-row">{inventory?(waiting&&can(user.role,'documents')?<Link to="/purchases" className="btn btn-secondary"><Truck size={18}/> Terima kiriman</Link>:<Button variant="secondary" onClick={()=>open(item)}><Truck size={18}/> Terima kiriman</Button>):<Button variant="secondary" onClick={()=>open(item)}><Trash2 size={18}/> Catat terbuang</Button>}
     {inventory&&can(user.role,'documents')&&<Link to="/purchases" className="btn btn-accent"><Plus size={18}/> {order}</Link>}</div></div>
   <div className="metrics">
    <article className="metric"><span><Package size={16}/> Ada di stok</span><strong>{amount(b,item.unit)}</strong><small>dari par {amount(item.threshold,item.unit)}{d===Infinity?'':d===0?', habis hari ini':`, sekitar ${d} hari lagi`}</small></article>
    <article className="metric"><span><Truck size={16}/> Dibeli sebagai</span><strong>{pack?`${pack.name.charAt(0).toUpperCase()}${pack.name.slice(1)}, ${amount(pack.qty,item.unit)}`:{g:'Gram',ml:'Mililiter',pcs:'Pcs'}[item.unit]}</strong><small>Disimpan dalam {item.unit}{(item.packs?.length??0)>1?`, juga per ${item.packs!.slice(1).map(p=>p.name).join(', ')}`:''}</small></article>
    <article className="metric"><span><Coffee size={16}/> Dipakai di</span><strong>{uses.length} menu</strong><small>{uses.length?`${uses[0].name}${uses.length>1?` dan ${uses.length-1} lainnya`:''}`:preps.length?`Bahan untuk ${words(preps.map(s=>s.name))}`:'Belum ada di resep'}</small></article>
   </div>
   {offers.length>0&&<article className="panel"><div className="panel-heading"><h2>Bandingkan pemasok</h2>{offers.length>1&&<span className="small muted">Termurah per {big} ditandai</span>}</div>
    <div className="table-scroll"><table className="data-table plain-table dense suppliers"><thead><tr><th>Pemasok</th><th>Jumlah</th><th className="num">Harga terakhir</th><th className="num">Per {big}</th><th className="num">Waktu kirim</th></tr></thead>
     <tbody>{offers.map(o=><tr key={o.supplier}><td><strong>{o.supplier}</strong></td><td>{amount(o.qty,item.unit)}</td><td className="num">{rupiah(o.cost)}</td><td className="num">{offers.length>1&&o.per===cheapest?<span className="dot-chip good">{rupiah(Math.round(o.per))} termurah</span>:rupiah(Math.round(o.per))}</td><td className="num">{o.lead===undefined?'-':o.lead<1?'Hari yang sama':`${o.lead} hari`}</td></tr>)}</tbody></table></div>
   </article>}
   <article className="panel"><div className="panel-heading"><h2>Semua pergerakan</h2><span className="small muted">Saldo berjalan dalam {item.unit}. Tidak ada yang bisa diubah atau dihapus.</span></div>
    {moves.length?<div className="table-scroll"><table className="data-table plain-table dense movements"><thead><tr><th>Waktu</th><th>Kejadian</th><th className="num">Perubahan</th><th className="num">Saldo</th><th>Oleh</th></tr></thead>
     <tbody>{moves.map(m=><tr key={m.id}><td className="muted">{date(m.at)||'Hari ini '}{clock(m.at)}</td><td>{event(m)}{m.cost>0&&<span className="muted"> · {rupiah(m.cost)}</span>}{m.photo&&<img className="nota-thumb" src={m.photo} alt="Nota"/>}</td><td className="num"><strong>{m.qty>0?'+':m.qty<0?'−':''}{quantity(Math.abs(m.qty))} {item.unit}</strong></td><td className="num">{quantity(m.after)} {item.unit}</td><td className="muted">{names.get(m.actor)??m.actor.slice(0,8)}</td></tr>)}</tbody></table></div>:<p className="muted">Belum ada pergerakan.</p>}
   </article>
   {record}
  </section>
 }
 const out=stockItems.filter(s=>balance(s.id)<=0),lowOnly=stockItems.filter(s=>balance(s.id)>0&&balance(s.id)<=s.threshold),offMenu=menu.filter(m=>m.active&&canMake(m).soldOut)
 const short=[...out,...lowOnly].map(s=>({s,d:pace(s)})).sort((a,b)=>Number(balance(b.s.id)<=0)-Number(balance(a.s.id)<=0)||a.d-b.d)
 const runsOut=(s:StockItem,d:number)=>balance(s.id)<=0?['critical','Habis']:d===Infinity?['','Belum terpakai']:d<1?['warning','Hari ini']:d===1?['warning','Besok']:['warning',`${d} hari`]
 const last=movements.reduce((a,m)=>m.at>a?m.at:a,'')
 // The count before closing: Tutup sif waits for a count sent since the shift opened (same rule as CloseShift).
 const counted=shift&&counts.filter(c=>c.status!=='draft'&&(c.submittedAt??c.approvedAt??'')>=shift.openedAt).map(c=>c.submittedAt??c.approvedAt!).sort().at(-1)
 return <section className="page-content stock-page">
  <div className="page-heading"><div><h1>Stok</h1><p className="muted">Berkurang sendiri setiap penjualan.{last&&` Diperbarui ${date(last)}${clock(last)}.`}</p></div>
   <div className="button-row"><button type="button" className="icon-button" aria-label="Cari" onClick={()=>{find.current?.scrollIntoView({block:'center'});find.current?.focus({preventScroll:true})}}><Search size={20}/></button>{can(user.role,'prep')&&made.length>0&&<Button variant="secondary" onClick={()=>setPrep({item:todo[0]?.item})}><Plus size={20}/> Catat prep</Button>}</div></div>
  <div className="stock-grid">
   <article className="metric"><span><AlertTriangle size={16}/> Habis</span><strong>{out.length}</strong><small title={offMenu.length>1?`${words(offMenu.map(m=>m.name))} tidak dijual.`:undefined}>{[out.length>1?`${out[0].name} dan ${out.length-1} lainnya`:out[0]?.name,offMenu.length===1?`${offMenu[0].name} tidak dijual`:offMenu.length?`${offMenu.length} menu tidak dijual`:''].filter(Boolean).join('. ')||'Tidak ada yang habis'}.</small></article>
   <article className="metric"><span><Package size={16}/> Hampir habis</span><strong>{lowOnly.length}</strong><small>{short.filter(x=>balance(x.s.id)>0).map(x=>x.s.name).join(', ')||'Tidak ada yang di bawah par'}</small></article>
   <article className="metric"><span><Check size={16}/> Aman</span><strong>{stockItems.length-out.length-lowOnly.length}</strong><small>bahan aman</small></article>
   <article className="panel stock-short"><div className="panel-heading"><h2>Habis dan hampir habis</h2></div>
    {short.length?<div className="table-scroll"><table className="data-table plain-table"><thead><tr><th>Bahan</th><th>Area</th><th>Sisa</th><th>Habis</th></tr></thead><tbody>{short.map(({s,d})=>{const [tone,label]=runsOut(s,d);return <tr key={s.id} onClick={()=>show(s)}><td><button type="button" className="stock-open" onClick={e=>{e.stopPropagation();show(s)}}>{s.name}</button></td><td className="muted">{s.area||'-'}</td><td className="muted">{amount(balance(s.id),s.unit)}</td><td><span className={`dot-chip ${tone}`}>{label}</span></td></tr>})}</tbody></table></div>:<p className="muted">Semua bahan di atas par.</p>}
   </article>
   <aside className="stock-side">
    {can(user.role,'counts')&&<article className="cta-card"><ClipboardList/><h2>{shift&&!counted?'Hitung sebelum tutup':counted?'Stok sudah dihitung':'Hitung per area'}</h2><p>{shift&&!counted?`${stockItems.length} bahan. Sif ditutup setelah hitungan ini, sekitar ${Math.max(5,Math.round(stockItems.length*.75))} menit.`:counted?`Hitungan terkirim ${clock(counted)}. Sif bisa ditutup.`:'Hitung buta: angka sistem tersembunyi sampai selesai.'}</p><Link to="/counts" className="cta-button">Hitung stok</Link></article>}
    {can(user.role,'prep')&&<article className="panel prep-panel"><div className="panel-heading"><h2>Daftar prep</h2><Link to="/production" className="text-link">Produksi</Link></div>
     {todo.length||soon.length?<div className="need-list">{todo.map(p=><button type="button" key={p.item.id} className="need-row warning" onClick={()=>setPrep({item:p.item,batches:p.batches})}><span className="need-icon"><CookingPot size={16}/></span><span>{p.item.name}</span><small>{p.batches} batch</small><ArrowRight size={16}/></button>)}
      {soon.map(e=><Link key={e.movement.id} to="/production" className="need-row critical"><span className="need-icon"><Clock size={16}/></span><span>{e.item.name}</span><small>{e.expired?'kedaluwarsa':'segera kedaluwarsa'}</small><ArrowRight size={16}/></Link>)}</div>:<p className="muted">Semua bahan olahan di atas par.</p>}
    </article>}
   </aside>
  </div>
  <div className="section-label stock-all-head"><h2>Semua bahan</h2><span>{stockItems.length} bahan, nilai stok {rupiah(stockItems.reduce((n,s)=>n+Math.max(0,balance(s.id))*(costs.get(s.id)??0),0))}</span></div>
  <div className="filter-row"><div className="search-box compact"><Search size={16}/><input ref={find} aria-label="Cari bahan" placeholder="Cari bahan atau nama lainnya" value={query} onChange={e=>setQuery(e.target.value)}/></div><div className="button-row"><Select ariaLabel="Area simpan" value={area} onChange={setArea} options={[{value:'',label:'Semua area'},...areas.map(a=>({value:a,label:a}))]}/><label className="inline-check"><input type="checkbox" checked={low} onChange={e=>setLow(e.target.checked)}/> Di bawah par saja</label></div></div>
  <p className="small muted stock-note"><AlertTriangle size={14}/> Stok resep adalah perkiraan pemakaian; hitung fisik mencocokkannya. Stok negatif tetap ditampilkan agar penjualan tidak hilang.</p>
  <div className="stock-list">{shown.map(s=><article className="stock-row" key={s.id}><span className="stock-icon">{s.photo?<img src={s.photo} alt="" loading="lazy"/>:<Package size={21}/>}</span>
   <div className="stock-name"><h3><button type="button" className="stock-open" onClick={()=>show(s)}>{s.name}</button></h3><p className="small muted">Par {quantity(s.threshold)} {s.unit}{s.area?` · ${s.area}`:''}{s.packs?.length?` · 1 ${s.packs[0].name} = ${quantity(s.packs[0].qty)} ${s.unit}`:''}{costs.has(s.id)?` · ${rupiah(Math.round(costs.get(s.id)!*1000))}/${s.unit}`:''}</p></div>
   <div className="stock-quantity"><strong>{quantity(balance(s.id))}</strong><span>{s.unit}</span>{balance(s.id)<=s.threshold&&<span className="badge badge-warning">{balance(s.id)<0?'Selisih stok':pace(s)===Infinity?'Di bawah par':`Di bawah par · ±${pace(s)} hari lagi`}</span>}</div>
   <div className="button-row"><Button variant="ghost" size="icon" aria-label={`Riwayat ${s.name}`} onClick={()=>show(s)}><History size={19}/></Button><Button variant="secondary" onClick={()=>open(s)}><Plus size={17}/><span>Catat stok</span></Button></div>
  </article>)}</div>
  {!stockItems.length&&<div className="empty-state"><Package size={40}/><h2>Mulai dari bahan yang sering dipakai</h2><p>Tambahkan bahan melalui Lainnya → Daftar bahan, atau impor CSV.</p></div>}
  {record}
 </section>
}
