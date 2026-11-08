import { useState } from 'react'
import { Navigate } from '@tanstack/react-router'
import { Package,Plus,ArrowDownLeft,History,AlertTriangle,Camera,Trash2 } from 'lucide-react'
import { useApp } from '../../app/context'
import { Button } from '../../components/ui/button'
import { Money } from '../../components/ui/money'
import { Select } from '../../components/ui/select'
import { Dialog } from '../../components/ui/dialog'
import { convert,daysLeft,quantity,rupiah,sanity,search,usagePerDay,when } from '../../domain/calculate'
import { compressMenuPhoto } from '../../lib/menu-photo'
import type { StockItem } from '../../domain/types'
import { can } from '../../domain/permissions'
const WASTE=['Rusak','Jatuh','Salah pesanan','Kedaluwarsa','Makan staf']
const kinds={purchase:'Kiriman / pembelian',opening:'Saldo awal',waste:'Terbuang / rusak',count:'Hasil hitung fisik',adjustment:'Penyesuaian',preparation:'Penjualan',production:'Batch olahan',transfer:'Transfer'}
// F5: ingredients bought in packs, stocked in g / ml / pcs; every movement with who and when; a
// delivery that looks wrong (PUR-4) needs a second tap before it enters stock.
export default function Inventory(){
 const {stockItems,movements,settings,commands,act,busy,shift,user,balance,costs,menu,canMake}=useApp()
 const [selected,setSelected]=useState<StockItem>();const [history,setHistory]=useState<StockItem>()
 const [kind,setKind]=useState<'purchase'|'waste'|'count'|'adjustment'|'opening'>('purchase');const [amount,setAmount]=useState('');const [unit,setUnit]=useState('');const [reason,setReason]=useState('');const [cost,setCost]=useState('0');const [drawer,setDrawer]=useState(false);const [negative,setNegative]=useState(false);const [photo,setPhoto]=useState<string>();const [photoBusy,setPhotoBusy]=useState(false)
 const [confirm,setConfirm]=useState<'high'|'low'>()
 const [low,setLow]=useState(false);const [area,setArea]=useState('');const [query,setQuery]=useState('')
 // Pilot rule: deliveries and adjustments are manager work and stay off the till while a shift is open.
 const inventory=can(user.role,'inventory')&&!(user.primary&&shift),waste=can(user.role,'waste')
 if(!inventory&&!waste)return <Navigate to="/pos"/>
 const areas=[...new Set(stockItems.map(s=>s.area).filter((a):a is string=>Boolean(a)))].sort()
 const shown=search(stockItems.filter(s=>(!low||balance(s.id)<=s.threshold)&&(!area||s.area===area)),query)
 const lowItems=stockItems.filter(s=>balance(s.id)<=s.threshold)
 const units=(s:StockItem)=>[{value:s.unit,label:s.unit},...(s.unit==='g'?[{value:'kg',label:'kg (1.000 g)'}]:s.unit==='ml'?[{value:'l',label:'liter (1.000 ml)'}]:[]),...(s.packs??[]).map(p=>({value:p.name,label:`${p.name} (${quantity(p.qty)} ${s.unit})`}))]
 const deliveries=(id:string)=>movements.filter(m=>m.stockId===id&&m.kind==='purchase'&&m.qty>0).sort((a,b)=>a.at.localeCompare(b.at)).map(m=>m.qty)
 const pace=(s:StockItem)=>daysLeft(balance(s.id),usagePerDay(movements,s.id))
 function open(s:StockItem){setSelected(s);setAmount('');setUnit(s.packs?.[0]?.name??s.unit);setKind(inventory?'purchase':'waste');setReason('');setCost('0');setDrawer(false);setNegative(false);setPhoto(undefined);setConfirm(undefined)}
 const parsed=()=>{if(!selected)return 0;try{return amount==='0'||amount===''?0:convert(amount,unit,selected.unit,selected.packs)}catch{return 0}}
 async function save(){if(!selected)return
  await act(async()=>{let qty=kind==='count'&&amount.trim()==='0'?0:convert(amount,unit,selected.unit,selected.packs)
   if(kind==='adjustment'&&negative)qty=-qty
   // PUR-4: over 5× or under ⅕ of the usual delivery stops here once; the second tap confirms it.
   if(kind==='purchase'&&!confirm){const verdict=sanity(qty,deliveries(selected.id));if(verdict!=='ok'){setConfirm(verdict);throw new Error(verdict==='high'?`Jumlahnya ${quantity(qty)} ${selected.unit}, jauh di atas kiriman biasanya. Periksa satuan, lalu tekan lagi untuk menyimpan.`:`Jumlahnya ${quantity(qty)} ${selected.unit}, jauh di bawah kiriman biasanya. Periksa satuan, lalu tekan lagi untuk menyimpan.`)}}
   await commands.stockRecord(selected.id,kind,qty,reason,Number(cost),drawer&&kind==='purchase',photo);setSelected(undefined)},'Pergerakan stok tersimpan')}
 async function choosePhoto(file:File){setPhotoBusy(true);try{setPhoto(await compressMenuPhoto(file))}catch(e){setConfirm(undefined);throw e}finally{setPhotoBusy(false)}}
 const running=(id:string)=>{let n=0;return movements.filter(m=>m.stockId===id).sort((a,b)=>a.at.localeCompare(b.at)).map(m=>({...m,after:(n+=m.qty)})).reverse().slice(0,100)}
 return <section className="page-content">
  <div className="page-heading"><div><p className="eyebrow">Setiap gram tercatat</p><h1>Stok bahan</h1><p className="muted">Terima dalam kemasan, pakai dalam gram, hitung per area.</p></div><Package size={27} className="muted"/></div>
  <div className="stock-summary"><div><span className="muted">Bahan dipantau</span><strong>{stockItems.length}</strong></div><div><span className="muted">Di bawah par</span><strong>{lowItems.length}</strong></div><div><span className="muted">Nilai stok</span><strong>{rupiah(stockItems.reduce((n,s)=>n+Math.max(0,balance(s.id))*(costs.get(s.id)??0),0))}</strong></div></div>
  {(()=>{const a=menu.filter(m=>m.active).map(m=>({m,...canMake(m)})).filter(x=>x.soldOut||x.low);return a.length?<article className="panel"><div className="panel-heading"><h2>Menu habis atau hampir habis</h2><span className="badge badge-warning">{a.length}</span></div>{a.map(x=><div className="bill-row" key={x.m.id}><span>{x.m.name}</span><strong>{x.soldOut?(x.m.soldOut?'Habis (ditandai)':'Habis · bahan kurang'):`Sisa ${x.left} porsi`}</strong></div>)}</article>:null})()}
  <p className="callout"><AlertTriangle size={18}/> Stok resep adalah perkiraan pemakaian; hitung fisik mencocokkannya. Stok negatif tetap ditampilkan agar penjualan tidak hilang.</p>
  <div className="search-box"><input aria-label="Cari bahan" placeholder="Cari bahan atau nama lainnya" value={query} onChange={e=>setQuery(e.target.value)}/></div>
  <div className="section-label"><h2>Persediaan</h2><div className="button-row"><Select ariaLabel="Area simpan" value={area} onChange={setArea} options={[{value:'',label:'Semua area'},...areas.map(a=>({value:a,label:a}))]}/><label className="inline-check"><input type="checkbox" checked={low} onChange={e=>setLow(e.target.checked)}/> Di bawah par saja</label></div></div>
  <div className="stock-list">{shown.map(s=><article className="stock-row" key={s.id}><span className="stock-icon">{s.photo?<img src={s.photo} alt="" loading="lazy"/>:<Package size={21}/>}</span>
   <div className="stock-name"><h3>{s.name}</h3><p className="small muted">Par {quantity(s.threshold)} {s.unit}{s.area?` · ${s.area}`:''}{s.packs?.length?` · 1 ${s.packs[0].name} = ${quantity(s.packs[0].qty)} ${s.unit}`:''}{costs.has(s.id)?` · ${rupiah(Math.round(costs.get(s.id)!*1000))}/${s.unit}`:''}</p></div>
   <div className="stock-quantity"><strong>{quantity(balance(s.id))}</strong><span>{s.unit}</span>{balance(s.id)<=s.threshold&&<span className="badge badge-warning">{balance(s.id)<0?'Selisih stok':pace(s)===Infinity?'Di bawah par':`Di bawah par · ±${pace(s)} hari lagi`}</span>}</div>
   <div className="button-row"><Button variant="ghost" size="icon" aria-label={`Riwayat ${s.name}`} onClick={()=>setHistory(s)}><History size={19}/></Button><Button variant="secondary" onClick={()=>open(s)}><Plus size={17}/><span>Catat stok</span></Button></div>
  </article>)}</div>
  {!stockItems.length&&<div className="empty-state"><Package size={40}/><h2>Mulai dari bahan yang sering dipakai</h2><p>Tambahkan bahan melalui Lainnya → Daftar bahan, atau impor CSV.</p></div>}
  <Dialog open={Boolean(selected)} onOpenChange={()=>setSelected(undefined)} title={selected?.name||'Catat stok'} description="Setiap perubahan memiliki alasan dan jejak pencatatan.">
   {selected&&<>
    <Select label="Jenis pencatatan" value={kind} onChange={v=>{setKind(v as typeof kind);setConfirm(undefined)}} options={[...(inventory?[{value:'purchase',label:'Kiriman / pembelian'},{value:'opening',label:'Saldo awal'}]:[]),{value:'waste',label:'Terbuang / rusak'},...(inventory?[{value:'count',label:'Hasil hitung fisik'},{value:'adjustment',label:'Penyesuaian'}]:[])]}/>
    <div className="form-grid">
     <label>{kind==='count'?'Jumlah fisik saat ini':'Jumlah'}<input inputMode="decimal" value={amount} onChange={e=>{setAmount(e.target.value);setConfirm(undefined)}} placeholder="0"/></label>
     <Select label="Satuan" value={unit} onChange={v=>{setUnit(v);setConfirm(undefined)}} options={units(selected)}/>
    </div>
    {amount&&<p className="small muted">= {quantity(parsed())} {selected.unit}{kind==='count'?` (sekarang ${quantity(balance(selected.id))} ${selected.unit})`:''}</p>}
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
    <Button loading={busy} disabled={busy||!amount||!reason.trim()} className="full" onClick={()=>void save()}><ArrowDownLeft size={18}/> {confirm?'Ya, jumlahnya benar':'Simpan pergerakan'}</Button>
   </>}
  </Dialog>
  <Dialog open={Boolean(history)} onOpenChange={()=>setHistory(undefined)} title={`Riwayat ${history?.name||''}`} description="Setiap pergerakan, siapa, kapan, dan saldo setelahnya.">
   <div className="history-list">{history&&running(history.id).map(m=><div key={m.id}><div><strong>{m.reason}</strong><p className="small muted">{when(m.at,settings?.timezone)} · {kinds[m.kind]}</p><p className="small muted">Oleh {m.actor===user.id?user.name:m.actor.slice(0,8)}{m.cost>0?` · ${rupiah(m.cost)}`:''}</p>{m.photo&&<img className="admin-menu-thumb" src={m.photo} alt="Nota"/>}</div><b className={m.qty<0?'negative':'positive'}>{m.qty>0?'+':''}{quantity(m.qty)} {history.unit}<br/><small className="muted">sisa {quantity(m.after)}</small></b></div>)}</div>
  </Dialog>
 </section>
}
