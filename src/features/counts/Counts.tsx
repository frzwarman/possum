import { useState } from 'react'
import { Navigate } from '@tanstack/react-router'
import { ClipboardList,Check,Play,Pause,ShieldCheck } from 'lucide-react'
import { useApp } from '../../app/context'
import { ApprovalDialog,type ApprovalRequest } from '../../app/Approval'
import { Button } from '../../components/ui/button'
import { Select } from '../../components/ui/select'
import { Dialog } from '../../components/ui/dialog'
import { convert,countGap,countsDue,quantity,rupiah,when } from '../../domain/calculate'
import { can } from '../../domain/permissions'
import { uid } from '../../lib/db'
import type { Approval,CountSession,StockItem } from '../../domain/types'
// F6: count by storage area with the expected amount hidden, pause and resume, then a variance review
// that a manager approves (PIN for everyone else) into one count.record operation.
export default function Counts(){
 const {stockItems,movements,counts,settings,commands,act,busy,user,manager,balance,costs,db,setError}=useApp()
 const [area,setArea]=useState('')
 const [session,setSession]=useState<CountSession>()
 const [typed,setTyped]=useState<Record<string,{amount:string;unit:string}>>({})
 const [reasons,setReasons]=useState<Record<string,string>>({})
 const [ask,setAsk]=useState<ApprovalRequest>()
 const [reviewing,setReviewing]=useState<CountSession>()
 if(!can(user.role,'counts'))return <Navigate to="/pos"/>
 const item=(id:string)=>stockItems.find(s=>s.id===id)
 const areas=[...new Set(stockItems.map(s=>s.area).filter((a):a is string=>Boolean(a)))].sort()
 const drafts=counts.filter(c=>c.status==='draft'),submitted=counts.filter(c=>c.status==='submitted'),done=counts.filter(c=>c.status==='approved').sort((a,b)=>(b.approvedAt??'').localeCompare(a.approvedAt??'')).slice(0,20)
 const due=countsDue(stockItems,movements,counts)
 const units=(s:StockItem)=>[{value:s.unit,label:s.unit},...(s.unit==='g'?[{value:'kg',label:'kg'}]:s.unit==='ml'?[{value:'l',label:'liter'}]:[]),...(s.packs??[]).map(p=>({value:p.name,label:`${p.name} (${quantity(p.qty)} ${s.unit})`}))]
 // CNT-1: a session lives in this device until it is submitted; every keystroke is saved so a pause costs nothing.
 async function start(){const lines=stockItems.filter(s=>!area||s.area===area).map(s=>({stockId:s.id}));if(!lines.length){setError('Tidak ada bahan di area ini');return}
  const c:CountSession={id:uid(),area:area||'Semua area',status:'draft',lines,startedBy:user.id,startedAt:new Date().toISOString()};await db.counts.put(c);resume(c)}
 function resume(c:CountSession){setSession(c);setTyped(Object.fromEntries(c.lines.map(l=>[l.stockId,{amount:l.counted===undefined?'':String(l.counted/1000),unit:item(l.stockId)?.unit??''}])))}
 async function type(stockId:string,amount:string,unit:string){if(!session)return;setTyped(t=>({...t,[stockId]:{amount,unit}}));const s=item(stockId);let counted:number|undefined
  try{counted=amount.trim()===''?undefined:amount.trim()==='0'?0:s?convert(amount,unit||s.unit,s.unit,s.packs):undefined}catch{counted=undefined}
  const next={...session,lines:session.lines.map(l=>l.stockId===stockId?{...l,counted}:l)};setSession(next);await db.counts.put(next)}
 async function submit(){if(!session)return;const s=session;await act(async()=>{await commands.submitCount(s);setSession(undefined)},'Hasil hitung dikirim untuk ditinjau manajer')}
 // CNT-2: expected = stock on hand now; gap valued at the latest cost; flagged over 5%.
 const review=(c:CountSession)=>c.lines.filter(l=>l.counted!==undefined).map(l=>{const expected=c.status==='approved'&&l.expected!==undefined?l.expected:balance(l.stockId);return {...l,...countGap(expected,l.counted!,costs.get(l.stockId)??0),expected}}).sort((a,b)=>Math.abs(b.value)-Math.abs(a.value))
 async function approve(c:CountSession,approval?:Approval){const rows=review(c)
  if(rows.some(r=>r.flagged&&!(reasons[r.stockId]??r.reason??'').trim())){setError('Isi alasan untuk setiap selisih di atas 5%');return}
  const lines=rows.map(r=>({stockId:r.stockId,counted:r.counted,reason:(reasons[r.stockId]??r.reason??'').trim()}))
  if(!manager&&!approval){setAsk({action:'count',orderId:c.id,what:`Setujui hitungan ${c.area} · ${rows.filter(r=>r.flagged).length} selisih`});return}
  await act(async()=>{await commands.recordCount({id:c.id,area:c.area,lines},approval);setReasons({});setReviewing(undefined)},'Hitungan disetujui; stok mengikuti hasil hitung')}
 return <section className="page-content">
  <div className="page-heading"><div><p className="eyebrow">Hitung stok</p><h1>Hitung stok</h1><p className="muted">Per area, di tablet, tanpa melihat angka sistem.</p></div><ClipboardList size={27} className="muted"/></div>
  <div className="metrics">
   <article className="metric featured"><span>Hitungan mingguan</span><strong>{due.weekly.length}</strong><small>bahan terpakai tersering belum dihitung 7 hari</small></article>
   <article className="metric"><span>Hitungan bulanan</span><strong>{due.monthly.length}</strong><small>bahan belum dihitung 30 hari</small></article>
   <article className="metric"><span>Menunggu persetujuan</span><strong>{submitted.length}</strong><small>hasil hitung yang perlu ditinjau</small></article>
   <article className="metric"><span>Dijeda</span><strong>{drafts.length}</strong><small>hitungan yang bisa dilanjutkan</small></article>
  </div>
  <div className="report-columns">
   <article className="panel"><div className="panel-heading"><h2>Mulai hitungan</h2></div>
    <Select label="Area simpan" value={area} onChange={setArea} options={[{value:'',label:'Semua area'},...areas.map(a=>({value:a,label:a}))]}/>
    <Button onClick={()=>void start()}><Play size={16}/> Mulai menghitung</Button>
    {drafts.length>0&&<><h3 className="mt">Dijeda</h3>{drafts.map(c=><div className="bill-row" key={c.id}><span>{c.area} · {when(c.startedAt,settings?.timezone)} · {c.lines.filter(l=>l.counted!==undefined).length}/{c.lines.length} bahan</span><Button size="sm" variant="secondary" onClick={()=>resume(c)}>Lanjutkan</Button></div>)}</>}
    {due.weekly.length>0&&<p className="callout">Jatuh tempo minggu ini: {due.weekly.map(s=>s.name).slice(0,6).join(', ')}{due.weekly.length>6?` dan ${due.weekly.length-6} lagi`:''}.</p>}
   </article>
   <article className="panel"><div className="panel-heading"><h2>Perlu ditinjau</h2><span className="badge">{submitted.length}</span></div>
    {submitted.length?submitted.map(c=><div className="bill-row" key={c.id}><span>{c.area} · {when(c.submittedAt!,settings?.timezone)} · {review(c).filter(r=>r.flagged).length} selisih di atas 5%</span><Button size="sm" onClick={()=>setReviewing(c)}><ShieldCheck size={15}/> Tinjau</Button></div>):<p className="muted">Hasil hitung yang dikirim muncul di sini.</p>}
    <h3 className="mt">Disetujui</h3>
    {done.length?done.map(c=><div className="bill-row" key={c.id}><span>{c.area} · {when(c.approvedAt!,settings?.timezone)} · {c.lines.length} bahan · {c.approvedBy}</span><Button size="sm" variant="ghost" onClick={()=>setReviewing(c)}>Lihat</Button></div>):<p className="muted">Belum ada hitungan yang disetujui.</p>}
   </article>
  </div>
  <Dialog open={Boolean(session)} onOpenChange={()=>setSession(undefined)} title={`Menghitung ${session?.area??''}`} description="Isi yang terlihat; kosongkan yang belum dihitung. Angka sistem disembunyikan.">
   {session&&<>
    {session.lines.map(l=>{const s=item(l.stockId);if(!s)return null;const t=typed[l.stockId]??{amount:'',unit:s.unit};return <div className="form-grid" key={l.stockId}>
     <label>{s.name}<input inputMode="decimal" value={t.amount} onChange={e=>void type(l.stockId,e.target.value,t.unit||s.unit)} placeholder="0"/></label>
     <Select label="Satuan" value={t.unit||s.unit} onChange={v=>void type(l.stockId,t.amount,v)} options={units(s)}/>
    </div>})}
    <div className="button-row"><Button variant="secondary" onClick={()=>setSession(undefined)}><Pause size={16}/> Jeda</Button><Button disabled={!session.lines.some(l=>l.counted!==undefined)} onClick={()=>void submit()}><Check size={16}/> Kirim untuk ditinjau</Button></div>
   </>}
  </Dialog>
  <Dialog open={Boolean(reviewing)} onOpenChange={()=>setReviewing(undefined)} title={`Tinjau ${reviewing?.area??''}`} description={reviewing?.status==='approved'?`Disetujui ${reviewing.approvedBy}`:'Selisih diurutkan dari nilai rupiah terbesar. Di atas 5% perlu alasan.'} wide>
   {reviewing&&<>
    <div className="table-scroll"><table className="data-table"><thead><tr><th>Bahan</th><th>Sistem</th><th>Dihitung</th><th>Selisih</th><th>Nilai</th></tr></thead><tbody>
     {review(reviewing).map(r=><tr key={r.stockId} className={r.flagged?'negative':undefined}><td>{item(r.stockId)?.name}{reviewing.status!=='approved'&&r.flagged&&<input placeholder="Alasan selisih" value={reasons[r.stockId]??r.reason??''} onChange={e=>setReasons({...reasons,[r.stockId]:e.target.value})}/>}{reviewing.status==='approved'&&r.reason&&<small className="muted"> · {r.reason}</small>}</td><td>{quantity(r.expected)} {item(r.stockId)?.unit}</td><td>{quantity(r.counted!)}</td><td>{r.gap>0?'+':''}{quantity(r.gap)}</td><td>{rupiah(r.value)}</td></tr>)}
    </tbody></table></div>
    {reviewing.status!=='approved'&&<Button className="full mt" loading={busy} disabled={busy} onClick={()=>void approve(reviewing)}><ShieldCheck size={17}/> {manager?'Setujui hitungan':'Minta persetujuan manajer'}</Button>}
   </>}
  </Dialog>
  <ApprovalDialog request={ask} onClose={()=>setAsk(undefined)} onApproved={a=>{setAsk(undefined);if(reviewing)void approve(reviewing,a)}}/>
 </section>
}
