import { useRef,useState } from 'react'
import { Navigate } from '@tanstack/react-router'
import { ArrowLeft,CalendarClock,CalendarDays,Check,ChevronDown,ChevronRight,ClipboardList,Clock,Coins,Lock,Play,RotateCw,ShieldCheck,TriangleAlert } from 'lucide-react'
import { useApp, useMovements } from '../../app/context'
import { ApprovalDialog,type ApprovalRequest } from '../../app/Approval'
import { Button } from '../../components/ui/button'
import { Select } from '../../components/ui/select'
import { countGap,countsDue,itemsLost,quantity,rupiah,when } from '../../domain/calculate'
import { BIG,blank,measure,type Entry } from '../../domain/measure'
import { can } from '../../domain/permissions'
import { uid } from '../../lib/db'
import type { Approval,CountSession,StockItem } from '../../domain/types'
const unitName=(u:string)=>u==='l'?'L':u
const cap=(s:string)=>s.charAt(0).toUpperCase()+s.slice(1)
// Amounts as people say them: 13 L and 2,35 kg instead of 13.000 ml and 2.350 g; a true minus as on the Figma (−105 g, −Rp7.350).
const nice=(v:number,unit:string)=>(Math.abs(v)>=1e6&&BIG[unit]?`${quantity(v/1000)} ${unitName(BIG[unit])}`:`${quantity(v)} ${unit}`).replace(/^-/,'−')
const money=(v:number)=>rupiah(v).replace(/^-/,'−')
// F6: count by storage area with the expected amount hidden, pause and resume, then a variance review
// that a manager approves (PIN for everyone else) into one count.record operation.
export default function Counts(){
 const {stockItems,counts,settings,commands,act,busy,user,manager,costs,db,setError,menu,shift,shifts}=useApp()
 const movements=useMovements()
 const [area,setArea]=useState('')
 const [session,setSession]=useState<CountSession>()
 const [typed,setTyped]=useState<Record<string,Entry>>({})
 const [at,setAt]=useState(0)
 const [box,setBox]=useState('')
 const [reasons,setReasons]=useState<Record<string,string>>({})
 const [ask,setAsk]=useState<ApprovalRequest>()
 const [reviewing,setReviewing]=useState<CountSession>()
 const entry=useRef<HTMLElement>(null)
 if(!can(user.role,'counts'))return <Navigate to="/pos"/>
 const tz=settings?.timezone,hhmm=(iso:string)=>when(iso,tz,{hour:'2-digit',minute:'2-digit'})
 const item=(id:string)=>stockItems.find(s=>s.id===id)
 const who=(id:string)=>id===user.id?user.name:shifts.find(s=>s.actor===id)?.cashier
 const firstBox=(id:string)=>item(id)?.packs?.[0]?.name??''
 const areas=[...new Set(stockItems.map(s=>s.area).filter((a):a is string=>Boolean(a)))].sort()
 const drafts=counts.filter(c=>c.status==='draft'),submitted=counts.filter(c=>c.status==='submitted'),done=counts.filter(c=>c.status==='approved').sort((a,b)=>(b.approvedAt??'').localeCompare(a.approvedAt??'')).slice(0,20)
 const due=countsDue(stockItems,movements,counts)
 // CNT-1: a session lives in this device until it is submitted; every keystroke is saved so a pause costs nothing.
 // Walk order: by area, then by name (ids are random, so table order means nothing to the counter).
 async function start(){const lines=stockItems.filter(s=>!area||s.area===area).sort((a,b)=>(a.area??'').localeCompare(b.area??'')||a.name.localeCompare(b.name)).map(s=>({stockId:s.id}));if(!lines.length){setError(stockItems.length?'Tidak ada bahan di area ini':'Belum ada bahan untuk dihitung. Tambahkan dulu di Lainnya → Daftar bahan.');return}
  const c:CountSession={id:uid(),area:area||'Semua area',status:'draft',lines,startedBy:user.id,startedAt:new Date().toISOString()};await db.counts.put(c);resume(c)}
 function resume(c:CountSession){const lines=c.lines.filter(l=>item(l.stockId)),n=Math.max(0,lines.findIndex(l=>l.counted===undefined))
  setSession(c);setAt(n);setBox(firstBox(lines[n]?.stockId??''));setTyped(Object.fromEntries(c.lines.map(l=>[l.stockId,{...blank,loose:l.counted===undefined?'':String(l.counted/1000).replace('.',',')}])))}
 async function type(stockId:string,e:Entry){if(!session)return;setTyped(t=>({...t,[stockId]:e}));const s=item(stockId);let counted:number|undefined
  try{counted=s?measure(s,e):undefined}catch{counted=undefined}
  const next={...session,lines:session.lines.map(l=>l.stockId===stockId?{...l,counted}:l)};setSession(next);await db.counts.put(next)}
 async function submit(){if(!session)return;const s=session;await act(async()=>{await commands.submitCount(s);setSession(undefined)},'Hasil hitung dikirim untuk ditinjau manajer')}
 // CNT-2: expected = stock on hand when the count was taken (CT-01: the server sends it with a submitted count; a count sent from
 // here is measured against the movements up to its submit); gap valued at the latest cost; flagged over 5%. Ties (no cost yet)
 // put flagged lines first.
 const review=(c:CountSession)=>c.lines.filter(l=>l.counted!==undefined).map(l=>{const at=l.at??(c.status==='submitted'?c.submittedAt:undefined),expected=l.expected??movements.filter(m=>m.stockId===l.stockId&&(!at||m.at<=at)).reduce((n,m)=>n+m.qty,0);return {...l,...countGap(expected,l.counted!,costs.get(l.stockId)??0),expected}}).sort((a,b)=>Math.abs(b.value)-Math.abs(a.value)||Number(b.flagged)-Number(a.flagged))
 async function approve(c:CountSession,approval?:Approval){const rows=review(c)
  if(rows.some(r=>r.flagged&&!(reasons[r.stockId]??r.reason??'').trim())){setError('Isi alasan untuk setiap selisih di atas 5%');return}
  const lines=rows.map(r=>({stockId:r.stockId,counted:r.counted,reason:(reasons[r.stockId]??r.reason??'').trim()}))
  if(!manager&&!approval){setAsk({action:'count',orderId:c.id,what:`Setujui hitungan ${c.area} · ${rows.filter(r=>r.flagged).length} selisih`});return}
  await act(async()=>{await commands.recordCount({id:c.id,area:c.area,lines},approval);setReasons({});setReviewing(undefined)},'Hitungan disetujui; stok mengikuti hasil hitung')}
 // Recount: the same count goes back to a draft on this device with the flagged lines blank, counted blind again,
 // and is sent again under the same id (count.submit upserts until the count is approved).
 async function recount(c:CountSession){const flagged=new Set(review(c).filter(r=>r.flagged).map(r=>r.stockId)),d:CountSession={...c,status:'draft',lines:c.lines.map(l=>flagged.has(l.stockId)?{stockId:l.stockId}:l)}
  await db.counts.put(d);setReviewing(undefined);resume(d)}
 const pin=<ApprovalDialog request={ask} onClose={()=>setAsk(undefined)} onApproved={a=>{setAsk(undefined);if(reviewing)void approve(reviewing,a)}}/>
 const lines=session?.lines.filter(l=>item(l.stockId))??[]
 // Figma C10: a focused screen. The list walks the area; the right panel takes one item at a time with its own keypad.
 if(session&&lines.length){const i=Math.min(at,lines.length-1),s=item(lines[i].stockId)!,e=typed[s.id]??blank,counted=lines.filter(l=>l.counted!==undefined).length
  const next=[...lines.slice(i+1),...lines.slice(0,i)].find(l=>l.counted===undefined)
  const boxes=[...(s.packs??[]).map(p=>({key:p.name,label:`${cap(p.name)} penuh`,unit:p.name})),{key:'',label:s.packs?.length?`${cap(s.packs.at(-1)!.name)} terbuka`:'Jumlah',unit:e.big?BIG[s.unit]:s.unit}]
  const target=boxes.some(b=>b.key===box)?box:boxes[0].key,value=(k:string)=>k===''?e.loose:e.packs[k]??''
  const put=(k:string,v:string):Entry=>k===''?{...e,loose:v}:{...e,packs:{...e.packs,[k]:v}}
  let total:number|undefined,problem='';try{total=measure(s,e)}catch(err){problem=err instanceof Error?err.message:String(err)}
  const go=(l:typeof lines[number])=>{setAt(lines.indexOf(l));setBox(firstBox(l.stockId))}
  const press=(k:string)=>{const v=value(target);void type(s.id,put(target,k==='del'?v.slice(0,-1):k===','?(v.includes(',')?v:(v||'0')+','):v==='0'?k:(v+k).slice(0,12)))}
  // Switching g↔kg or ml↔L converts what is already typed, so the count itself does not change. STOK-10: a value the other
  // unit cannot hold exactly (1.234,5 g would round to 1,235 kg, 0,4 g to 0) keeps its unit instead.
  const flip=()=>{const n=Number(e.loose.replace(',','.')),x=e.big?n*1000:n/1000,r=Math.round(x*1000)/1000
   if(e.loose.trim()&&Number.isFinite(n)&&Math.abs(r-x)>1e-9){setError(`Ketik dalam ${unitName(s.unit)} untuk pecahan di bawah 1 ${unitName(s.unit)}`);return}
   const v=e.loose.trim()&&Number.isFinite(n)?String(r).replace('.',','):e.loose;void type(s.id,{...e,loose:v,big:!e.big})}
  const hint=(x:StockItem)=>[...(session.area==='Semua area'&&x.area?[x.area]:[]),...(x.production?['prep']:[]),...(x.packs?.length?x.packs.map(p=>`${p.name} ${nice(p.qty,x.unit)}`):[x.unit])].join(', ')
  const words=(x:StockItem,v:number)=>{const t=typed[x.id]??blank,parts=(x.packs??[]).filter(p=>(t.packs[p.name]??'').trim()).map(p=>`${t.packs[p.name]} ${p.name}`);return parts.length?`${[...parts,...(t.loose.trim()?[`${t.loose} ${unitName(t.big?BIG[x.unit]:x.unit)}`]:[])].join(' + ')} = ${nice(v,x.unit)}`:nice(v,x.unit)}
  const closing=shift&&!counts.some(c=>c.id!==session.id&&c.status!=='draft'&&(c.submittedAt??c.approvedAt??'')>=shift.openedAt),by=who(session.startedBy),incomplete=Boolean(closing)&&counted<lines.length // the count before closing covers every bahan (zero is a count)
  return <section className="count-screen" aria-labelledby="count-title">
   <header className="count-top">
    <button type="button" className="count-back" aria-label="Kembali ke Hitung stok" onClick={()=>setSession(undefined)}><ArrowLeft size={20}/></button>
    <div className="count-title"><h1 id="count-title">Hitung: {session.area}</h1><p>{closing?'Hitung sebelum tutup, dimulai':'Dimulai'}{by?` ${by}`:''} {hhmm(session.startedAt)}.{closing?' Sif bisa ditutup setelah hitungan ini dikirim.':''}</p></div>
    <div className="count-progress"><span>{counted} dari {lines.length} dihitung{incomplete?' · semua bahan wajib dihitung sebelum tutup':''}</span><i role="progressbar" aria-label="Bahan dihitung" aria-valuemin={0} aria-valuemax={lines.length} aria-valuenow={counted}><b style={{width:`${counted/lines.length*100}%`}}/></i></div>
    <div className="count-actions"><Button variant="secondary" onClick={()=>setSession(undefined)}><Clock size={20}/> Jeda</Button>
     <Button variant="secondary" loading={busy} disabled={busy||!counted||incomplete} title={incomplete?`${lines.length-counted} bahan belum dihitung`:undefined} onClick={()=>submit()}><Check size={20}/> Kirim untuk ditinjau</Button></div>
   </header>
   <div className="count-body">
    <article className="count-entry" ref={entry}>
     <h2>{s.name}</h2>
     <p className="muted">{s.packs?.length?`Hitung ${s.packs.map(p=>p.name).join(' dan ')} penuh, lalu perkirakan ${s.packs.at(-1)!.name} yang terbuka.`:'Hitung semua yang ada di area ini.'} Jumlah seharusnya tetap tersembunyi sampai selesai.</p>
     <div className="count-boxes">{boxes.map(b=><label key={b.key} className={`count-box${target===b.key?' on':''}`}><span>{b.label}</span>
      <span className="count-field"><input inputMode="none" autoComplete="off" placeholder="0" value={value(b.key)} onFocus={()=>setBox(b.key)} onChange={ev=>void type(s.id,put(b.key,ev.target.value))} onKeyDown={ev=>{if(ev.key==='Enter'&&next)go(next)}}/>
       {b.key===''&&BIG[s.unit]?<button type="button" className="count-unit" aria-label={`Satuan ${unitName(b.unit)}, ganti`} onClick={flip}>{unitName(b.unit)}<ChevronDown size={13}/></button>:<small>{unitName(b.unit)}</small>}</span></label>)}</div>
     <p className={`count-total${problem?' negative':''}`} aria-live="polite">{problem||(total===undefined?'Belum dihitung':`= ${quantity(total)} ${s.unit}`)}</p>
     <div className="count-keypad">{['1','2','3','4','5','6','7','8','9',',','0'].map(k=><button type="button" key={k} aria-label={k===','?'Koma':undefined} onClick={()=>press(k)}>{k}</button>)}<button type="button" onClick={()=>press('del')}>Hapus</button></div>
     {next?<Button className="btn-accent full count-next" onClick={()=>go(next)}><ChevronRight size={20}/> Berikutnya: {item(next.stockId)?.name}</Button>
      :<Button className="btn-accent full count-next" loading={busy} disabled={busy||!counted||incomplete} onClick={()=>submit()}><Check size={20}/> Selesai menghitung</Button>}
    </article>
    <div className="count-list">{lines.map((l,n)=>{const x=item(l.stockId)!,got=l.counted!==undefined;return <button type="button" key={l.stockId} className={`count-line${n===i?' current':''}${got?' counted':''}`} aria-current={n===i||undefined} onClick={()=>{go(l);entry.current?.scrollIntoView({block:'nearest',behavior:'smooth'})}}>
     {got&&n!==i?<Check size={16}/>:<ChevronRight size={16}/>}<span><strong>{x.name}</strong><small>{hint(x)}</small></span>
     <span className={n===i||!got?'pending':undefined}>{n===i?'Sedang dihitung':got?words(x,l.counted!):'Belum dihitung'}</span></button>})}</div>
   </div>
   {pin}
  </section>}
 // Figma M2: the review is a page of its own, gaps sorted by rupiah, flagged lines tinted and asking for a reason.
 if(reviewing){const c=reviewing,rows=review(c),flagged=rows.filter(r=>r.flagged).length,priced=rows.some(r=>costs.get(r.stockId)),approved=c.status==='approved',gap=rows.reduce((n,r)=>n+r.value,0),worth=rows.reduce((n,r)=>n+Math.max(0,r.expected)*(costs.get(r.stockId)??0),0)
  const walk=Math.max(rows.length,(c.area==='Semua area'?stockItems:stockItems.filter(s=>s.area===c.area)).length),mins=c.submittedAt?Math.round((Date.parse(c.submittedAt)-Date.parse(c.startedAt))/60000):undefined,by=who(c.startedBy)
  return <section className="page-content count-review" aria-labelledby="review-title">
   <div className="page-heading"><div><button type="button" className="crumb" onClick={()=>setReviewing(undefined)}>Hitung stok</button>
    <div className="title-row"><h1 id="review-title">{c.area}, {when(c.submittedAt??c.startedAt,tz,{weekday:'long',day:'numeric',month:'short'}).replace(',','')}</h1><span className={`dot-chip ${approved?'good':'warning'}`}>{approved?`Disetujui ${c.approvedBy??''}`.trim():'Menunggu persetujuan'}</span></div></div>
    {!approved&&<div className="button-row">{flagged>0&&<Button variant="secondary" onClick={()=>recount(c)}><RotateCw size={20}/> Hitung ulang yang ditandai</Button>}
     <Button className="btn-accent" loading={busy} disabled={busy} onClick={()=>approve(c)}>{manager?<><Check size={20}/> Setujui hitungan</>:<><Lock size={20}/> Setujui dengan PIN</>}</Button></div>}</div>
   <div className="metrics count-metrics">
    <article className="metric tone-lavender"><span><Coins size={16}/> Nilai selisih</span><strong>{priced?money(gap||0):'—'}</strong><small>{worth>0?`${(Math.abs(gap)/worth*100).toLocaleString('id-ID',{maximumFractionDigits:1})}% dari nilai stok`:'Harga beli belum tercatat'}</small></article>
    <article className="metric tone-sky"><span><ClipboardList size={16}/> Dihitung</span><strong>{rows.length} dari {walk}</strong><small>{[by,mins===undefined?'':mins<1?'kurang dari 1 menit':`${mins} menit`].filter(Boolean).join(', ')||c.area}</small></article>
    <article className="metric tone-mint"><span><TriangleAlert size={16}/> Ditandai</span><strong>{flagged} bahan</strong><small>Selisih di atas 5%</small></article>
   </div>
   <article className="panel count-review-panel"><div className="table-scroll"><table className="data-table count-table"><thead><tr><th>Bahan</th><th className="num">Seharusnya</th><th className="num">Dihitung</th><th className="num">Selisih</th><th className="num">Nilai selisih</th><th className="num">Item hilang</th><th>Alasan</th></tr></thead><tbody>
    {rows.map(r=>{const x=item(r.stockId),unit=x?.unit??'',lost=itemsLost(r.gap,r.stockId,menu);return <tr key={r.stockId} className={r.flagged?'flagged':undefined}>
     <td><strong>{x?.name}</strong></td><td className="num muted" data-label="Seharusnya">{nice(r.expected,unit)}</td><td className="num" data-label="Dihitung">{nice(r.counted!,unit)}</td><td className="num" data-label="Selisih">{r.gap>0?'+':''}{nice(r.gap,unit)}</td>
     <td className="num" data-label="Nilai selisih"><strong>{costs.get(r.stockId)?money(r.value||0):'—'}</strong></td><td className="num" data-label="Item hilang"><strong>{lost?`≈ ${lost.n} ${lost.name}`:'—'}</strong></td>
     <td data-label="Alasan">{approved?(r.reason||<small className="muted">{r.flagged?'—':'Dalam 5%'}</small>):r.flagged?<span className="count-reason"><input list="count-reasons" placeholder="Pilih alasan" aria-label={`Alasan selisih ${x?.name??''}`} value={reasons[r.stockId]??r.reason??''} onChange={e=>setReasons({...reasons,[r.stockId]:e.target.value})}/><ChevronDown size={16} aria-hidden/></span>:<small className="muted">Dalam 5%</small>}</td></tr>})}
   </tbody></table></div>
   {/* Common reasons to pick from; any other reason can still be typed. */}
   <datalist id="count-reasons">{['Tumpah, tidak dicatat','Terbuang, tidak dicatat','Porsi berlebih','Kiriman belum dicatat','Salah hitung sebelumnya','Hilang'].map(x=><option key={x} value={x}/>)}</datalist>
   </article>
   {pin}
  </section>}
 return <section className="page-content">
  <div className="page-heading"><div><h1>Hitung stok</h1><p className="muted">Per area, di tablet, tanpa melihat angka sistem.</p></div></div>
  <div className="metrics count-metrics">
   <article className="metric tone-lavender"><span><CalendarClock size={16}/> Hitungan mingguan</span><strong>{due.weekly.length}</strong><small>bahan terpakai tersering belum dihitung 7 hari</small></article>
   <article className="metric tone-sky"><span><CalendarDays size={16}/> Hitungan bulanan</span><strong>{due.monthly.length}</strong><small>bahan belum dihitung 30 hari</small></article>
   <article className="metric tone-mint"><span><ShieldCheck size={16}/> Menunggu persetujuan</span><strong>{submitted.length}</strong><small>hasil hitung yang perlu ditinjau</small></article>
  </div>
  <div className="report-columns count-columns">
   <article className="panel"><div className="panel-heading"><h2>Mulai hitungan</h2></div>
    <Select label="Area simpan" value={area} onChange={setArea} options={[{value:'',label:'Semua area'},...areas.map(a=>({value:a,label:a}))]}/>
    <Button className="btn-accent" onClick={()=>start()}><Play size={16}/> Mulai menghitung</Button>
    {drafts.length>0&&<><h3 className="mt">Dijeda</h3><div className="count-rows">{drafts.map(c=><div className="count-row" key={c.id}><span><strong>{c.area}</strong><small>{when(c.startedAt,tz)} · {c.lines.filter(l=>l.counted!==undefined).length}/{c.lines.length} bahan</small></span><Button size="sm" variant="secondary" onClick={()=>resume(c)}>Lanjutkan</Button></div>)}</div></>}
    {due.weekly.length>0&&<p className="callout">Jatuh tempo minggu ini: {due.weekly.map(s=>s.name).slice(0,6).join(', ')}{due.weekly.length>6?` dan ${due.weekly.length-6} lagi`:''}.</p>}
   </article>
   <article className="panel"><div className="panel-heading"><h2>Perlu ditinjau</h2><span className={`dot-chip${submitted.length?' warning':''}`}>{submitted.length}</span></div>
    {submitted.length?<div className="count-rows">{submitted.map(c=><div className="count-row" key={c.id}><span><strong>{c.area}</strong><small>{when(c.submittedAt!,tz)} · {review(c).filter(r=>r.flagged).length} selisih di atas 5%</small></span><Button size="sm" onClick={()=>setReviewing(c)}><ShieldCheck size={15}/> Tinjau</Button></div>)}</div>:<p className="muted">Hasil hitung yang dikirim muncul di sini.</p>}
    <h3 className="mt">Disetujui</h3>
    {done.length?<div className="count-rows">{done.map(c=><div className="count-row" key={c.id}><span><strong>{c.area}</strong><small>{when(c.approvedAt!,tz)} · {c.lines.length} bahan · {c.approvedBy}</small></span><Button size="sm" variant="ghost" onClick={()=>setReviewing(c)}>Lihat</Button></div>)}</div>:<p className="muted">Belum ada hitungan yang disetujui.</p>}
   </article>
  </div>
  {pin}
 </section>
}
