import { useState } from 'react'
import { Link,Navigate } from '@tanstack/react-router'
import { CookingPot,Clock,ListChecks } from 'lucide-react'
import { useApp } from '../../app/context'
import { Button } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { canMake,convert,expiring,prepList,quantity,rupiah,when } from '../../domain/calculate'
import { can } from '../../domain/permissions'
import type { StockItem } from '../../domain/types'
// Big units read better: 1.200 ml shows as 1,2 L and 2.000 g as 2 kg; pcs stay pcs.
export const amount=(v:number,unit:string)=>unit!=='pcs'&&Math.abs(v)>=1_000_000?`${quantity(v/1000)} ${unit==='ml'?'L':'kg'}`:`${quantity(v)} ${unit}`
const words=(xs:string[])=>xs.length>1?`${xs.slice(0,-1).join(', ')} dan ${xs.at(-1)}`:xs[0]??''
// F4: a prep item (sambal, ayam ungkep) is stocked. One batch takes its inputs out of stock and puts
// the actual yield in; the gap to the recipe yield is written into the movement's reason.
export default function Production(){
 const {stockItems,movements,settings,commands,act,busy,user,costs,balance}=useApp()
 const [run,setRun]=useState<{item:StockItem;batches:number}>()
 if(!can(user.role,'prep'))return <Navigate to="/pos"/>
 const stock=(id:string)=>stockItems.find(s=>s.id===id)
 const made=stockItems.filter(s=>s.production)
 const todo=prepList(stockItems,balance)
 const soon=expiring(stockItems,movements,2)
 const runs=movements.filter(m=>m.kind==='production'&&m.qty>0).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,30)
 // Cost of one batch at each input's latest price (purchase, production or transfer); unknown if any input was never priced.
 const batchCost=(s:StockItem)=>s.production!.inputs.every(i=>costs.has(i.stockId))?Math.round(s.production!.inputs.reduce((sum,i)=>sum+i.qty*costs.get(i.stockId)!,0)):undefined
 const perUnit=(cost:number,qty:number,unit:string)=>`${rupiah(Math.round(cost*1000/qty))}/${unit}`
 return <section className="page-content">
  <div className="page-heading"><div><h1>Produksi</h1><p className="muted">Bahan olahan per batch: bahan turun sesuai resep, hasil nyata naik.</p></div></div>
  <div className="station-side">
   <article className="panel"><div className="panel-heading"><h2><ListChecks size={17}/> Daftar prep hari ini</h2><span className="badge">{todo.length}</span></div>
    {todo.length?todo.map(p=><div className="bill-row" key={p.item.id}><span>{p.item.name} · sisa {quantity(p.balance)} {p.item.unit} (par {quantity(p.item.threshold)})</span><Button size="sm" variant="secondary" onClick={()=>setRun({item:p.item,batches:p.batches})}>Buat {p.batches} batch</Button></div>):<p className="muted">Semua bahan olahan di atas par.</p>}
   </article>
   <article className="panel"><div className="panel-heading"><h2><Clock size={17}/> Segera kedaluwarsa</h2><span className="badge">{soon.length}</span></div>
    {soon.length?soon.map(e=><div className="bill-row" key={e.movement.id}><span>{e.item.name} · {when(e.movement.at,settings?.timezone,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}{e.expired?' · kedaluwarsa':` · sampai ${when(e.expiresAt,settings?.timezone,{hour:'2-digit',minute:'2-digit'})}`}</span><Button size="sm" variant="secondary" disabled={busy||balance(e.item.id)<=0} onClick={()=>act(()=>commands.stockRecord(e.item.id,'waste',e.remaining,'Kedaluwarsa'),'Sisa batch dicatat terbuang')}>Buang sisa {quantity(e.remaining)} {e.item.unit}</Button></div>):<p className="muted">Tidak ada batch yang mendekati masa simpan.</p>}
   </article>
  </div>
  <div className="stock-list mt">{made.map(s=><article className="stock-row" key={s.id}><span className="stock-icon"><CookingPot size={21}/></span>
   <div className="stock-name"><h3>{s.name}</h3><p className="small muted">1 batch: {s.production!.inputs.map(i=>`${stock(i.stockId)?.name} ${quantity(i.qty)} ${stock(i.stockId)?.unit}`).join(', ')} → {quantity(s.production!.output)} {s.unit}{s.shelfLife?` · tahan ${s.shelfLife} jam`:''}</p>
    <p className="small muted">{batchCost(s)===undefined?'Biaya per batch: harga sebagian bahan belum tercatat':`Biaya per batch ≈ ${rupiah(batchCost(s)!)} · ${perUnit(batchCost(s)!,s.production!.output,s.unit)}`}</p></div>
   <div className="stock-quantity"><strong>{quantity(balance(s.id))}</strong><span>{s.unit}</span></div>
   <div className="button-row"><Button variant="secondary" onClick={()=>setRun({item:s,batches:1})}>Catat produksi</Button></div>
  </article>)}</div>
  {!made.length&&<div className="empty-state"><CookingPot size={42} strokeWidth={1.3}/><h2>Belum ada bahan olahan</h2><p>Buka Lainnya → Daftar bahan, pilih bahan seperti sambal, lalu isi resep batch-nya.</p><Button asChild variant="secondary"><Link to="/settings">Ke Daftar bahan</Link></Button></div>}
  <article className="panel mt"><div className="panel-heading"><h2>Riwayat batch</h2><span className="badge">{runs.length}</span></div>
   {runs.length?<div className="history-list">{runs.map(m=><div key={m.id}><span><strong>{m.reason}</strong><br/><small className="muted">{when(m.at,settings?.timezone)}{m.cost>0&&` · biaya ${rupiah(m.cost)} (${perUnit(m.cost,m.qty,stock(m.stockId)?.unit??'')})`}</small></span><b className="positive">+{quantity(m.qty)} {stock(m.stockId)?.unit}</b></div>)}</div>:<p className="muted">Batch yang dicatat muncul di sini.</p>}
  </article>
  <PrepDialog open={Boolean(run)} item={run?.item} batches={run?.batches} onClose={()=>setRun(undefined)}/>
 </section>
}
// Figma C8 "Catat prep", opened from Stok and from each row here: the kitchen says what it made and how many portions
// came out. One batch by default; "Jumlah lain" opens the batch count and the exact yield.
export function PrepDialog({open,item,batches=1,onClose}:{open:boolean;item?:StockItem;batches?:number;onClose:()=>void}){
 return <Dialog open={open} onOpenChange={onClose} title="Catat prep" description="Dapur memberi tahu apa yang dibuat. Hitung dalam porsi." className="prep-dialog">{open&&<PrepForm item={item} start={batches} onDone={onClose}/>}</Dialog>
}
function PrepForm({item,start,onDone}:{item?:StockItem;start:number;onDone:()=>void}){
 const {stockItems,menu,commands,act,busy,setError,costs,balance,canMake:sellable}=useApp()
 const made=stockItems.filter(s=>s.production)
 const [id,setId]=useState(item?.id??made[0]?.id);const s=made.find(x=>x.id===id)
 const [batches,setBatches]=useState(String(start));const [output,setOutput]=useState(String((s?.production?.output??0)*start/1000));const [note,setNote]=useState('');const [other,setOther]=useState(start!==1)
 if(!s)return <p className="muted">Belum ada bahan olahan. Buka Lainnya → Daftar bahan, pilih bahan seperti sambal, lalu isi resep batch-nya.</p>
 const p=s.production!,n=/^[1-9]\d{0,2}$/.test(batches)?Number(batches):0,expected=p.output*n,short=Math.floor(expected*.9/1000)*1000
 const inputs=p.inputs.map(i=>({stockId:i.stockId,qty:i.qty*n}))
 const qty=(()=>{try{return convert(output,s.unit,s.unit)}catch{return 0}})()
 const stock=(id:string)=>stockItems.find(x=>x.id===id),size=(v:number)=>s.unit==='pcs'?`${quantity(v)} porsi`:amount(v,s.unit)
 const main=p.inputs[0],cost=p.inputs.every(i=>costs.has(i.stockId))?Math.round(inputs.reduce((sum,i)=>sum+i.qty*costs.get(i.stockId)!,0)):undefined
 // What can be sold again once this batch is in: sold out now (not marked by hand), enough of everything after it.
 const after=(id:string)=>balance(id)+(id===s.id?qty:0)-(inputs.find(i=>i.stockId===id)?.qty??0)
 const back=menu.filter(m=>m.active&&!m.soldOut&&sellable(m).soldOut&&m.recipe.some(r=>r.stockId===s.id)&&canMake(m,after)>=1)
 function choose(x:StockItem){setId(x.id);setBatches('1');setOther(false);setOutput(String(x.production!.output/1000))}
 function save(){if(!s)return
  try{const qty=convert(output,s.unit,s.unit)
   // PREP-2: the actual yield is what enters stock; a gap to the recipe is logged in plain words.
   const gap=qty!==expected?`hasil ${quantity(qty)}/${quantity(expected)} ${s.unit}`:''
   void act(async()=>{await commands.produce(s.id,qty,inputs,[note.trim(),gap].filter(Boolean).join(' · ').slice(0,200));onDone()},'Batch tercatat; stok diperbarui')}
  catch(e){setError(e instanceof Error?e.message:'Hasil produksi tidak valid')}}
 return <>
  <fieldset className="option-group"><legend>Apa yang dibuat dapur?</legend><div className="opt-pills">{made.map(x=><label key={x.id} className={`opt-pill ${x.id===s.id?'on':''}`}><input type="radio" name="prep-item" checked={x.id===s.id} onChange={()=>choose(x)}/>{x.name}</label>)}</div></fieldset>
  <fieldset className="option-group"><legend>{s.unit==='pcs'?'Berapa porsi yang jadi?':'Berapa banyak yang jadi?'}{main&&<small>Resep menghasilkan {size(p.output)} dari {amount(main.qty,stock(main.stockId)?.unit??'')} {stock(main.stockId)?.name}</small>}</legend>
   <div className="opt-pills">{[expected,short].filter((v,i,a)=>v>0&&a.indexOf(v)===i).map(v=><label key={v} className={`opt-pill ${!other&&qty===v?'on':''}`}><input type="radio" name="prep-yield" checked={!other&&qty===v} onChange={()=>{setOther(false);setOutput(String(v/1000))}}/>{size(v)}</label>)}
    <label className={`opt-pill ${other?'on':''}`}><input type="radio" name="prep-yield" checked={other} onChange={()=>setOther(true)}/>Jumlah lain</label></div>
  </fieldset>
  {other&&<div className="form-grid">
   <label>Jumlah batch<input type="number" inputMode="numeric" min={1} max={999} value={batches} onChange={e=>{setBatches(e.target.value);if(/^[1-9]\d{0,2}$/.test(e.target.value))setOutput(String(p.output*Number(e.target.value)/1000))}}/></label>
   <label>Hasil sebenarnya ({s.unit})<input inputMode="decimal" value={output} onChange={e=>setOutput(e.target.value)}/></label>
   <label className="prep-note">Catatan (opsional)<input value={note} onChange={e=>setNote(e.target.value)} placeholder="Contoh: dimasak Bu Rini"/></label>
  </div>}
  {n>0&&<div className="recipe-note"><CookingPot size={20}/><div><p>{n>1?`${n} batch `:''}{s.name} memakai {words(inputs.map(i=>`${amount(i.qty,stock(i.stockId)?.unit??'')} ${stock(i.stockId)?.name}`))}.{back.length>0&&` ${words(back.map(m=>m.name))} bisa dijual lagi.`}</p>
   {inputs.filter(i=>balance(i.stockId)<i.qty).map(i=><small key={i.stockId} className="negative">Stok {stock(i.stockId)?.name} tinggal {amount(balance(i.stockId),stock(i.stockId)?.unit??'')}; setelah dicatat jadi minus.</small>)}
   {qty>0&&qty!==expected&&<small>Resep mengharapkan {size(expected)}; selisih {quantity(qty-expected)} dicatat.</small>}
   {cost!==undefined&&<small>Perkiraan biaya {rupiah(cost)}, dari harga beli terakhir tiap bahan.</small>}</div></div>}
  <Button className="full btn-accent prep-save" loading={busy} disabled={busy||!n||!qty} onClick={save}>{n&&qty?`Tambah ${size(qty)} ke stok`:'Tambah ke stok'}</Button>
 </>
}
