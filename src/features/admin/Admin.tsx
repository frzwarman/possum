// Area pemilik: halaman masuk sendiri, di luar shell kasir. Tidak menyentuh Dexie, sif, atau
// perangkat utama — hanya membaca keanggotaan dan memanggil RPC manage_staff. Server tetap
// penentu: manage_staff menolak siapa pun yang bukan pemilik aktif restoran ini.
import { useEffect,useState,type FormEvent } from 'react'
import { ArrowRight,ShieldCheck,Terminal,LogOut,Store } from 'lucide-react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { Button } from '../../components/ui/button'
import { Select } from '../../components/ui/select'
import { configured,supabase } from '../../lib/supabase'
import type { Role } from '../../domain/types'
interface Staff { user_id:string; restaurant_id:string; name:string; role:Role; active:boolean }
const label:Record<Role,string>={owner:'Pemilik',manager:'Manajer',cashier:'Kasir'}
export default function Admin(){
 // Tanpa ini bundel lama bisa tertahan selamanya: prompt pembaruan hanya ada di shell kasir,
 // yang baru dipasang setelah masuk. Di layar ini tidak ada yang bisa hilang saat memuat ulang.
 const {needRefresh:[needRefresh],updateServiceWorker}=useRegisterSW();useEffect(()=>{if(needRefresh)void updateServiceWorker(true)},[needRefresh])
 const [me,setMe]=useState<Staff|null>(null);const [staff,setStaff]=useState<Staff[]>([]);const [error,setError]=useState('');const [notice,setNotice]=useState('');const [busy,setBusy]=useState(true);const [pending,setPending]=useState('')
 async function load(){const {data:{session}}=await supabase!.auth.getSession();if(!session){setMe(null);return}
  const {data,error:e}=await supabase!.from('memberships').select('user_id,restaurant_id,name,role,active').order('name');if(e)throw e
  const rows=data as Staff[],mine=rows.find(r=>r.user_id===session.user.id)
  if(!mine||!mine.active||mine.role!=='owner'){await supabase!.auth.signOut();setMe(null);throw new Error('Area ini hanya untuk pemilik restoran. Staf masuk lewat halaman kasir.')}
  setMe(mine);setStaff(rows)}
 async function run(action:()=>Promise<void>,message?:string){if(busy)return;setBusy(true);setError('');setNotice('');try{await action();if(message)setNotice(message)}catch(e){setError(e instanceof Error?e.message:'Tindakan gagal')}finally{setBusy(false)}}
 // busy mulai true: daftar staf tampil sebagai skeleton sampai pembacaan pertama selesai.
 useEffect(()=>{if(!configured){setBusy(false);setError('Koneksi restoran belum diatur. Isi VITE_SUPABASE_URL dan VITE_SUPABASE_PUBLISHABLE_KEY.');return}void load().catch(e=>setError(e instanceof Error?e.message:'Gagal memuat')).finally(()=>setBusy(false))},[])
 function signIn(e:FormEvent<HTMLFormElement>){e.preventDefault();const form=new FormData(e.currentTarget);void run(async()=>{const {error:e2}=await supabase!.auth.signInWithPassword({email:String(form.get('email')),password:String(form.get('password'))});if(e2)throw e2;await load()})}
 const change=(s:Staff,patch:Partial<Staff>)=>{setPending(s.user_id);void run(async()=>{const {error:e}=await supabase!.rpc('manage_staff',{target:s.user_id,new_role:patch.role??s.role,new_active:patch.active??s.active});if(e)throw e;await load()},'Akun staf diperbarui').finally(()=>setPending(''))}
 if(!me)return <main className="login-page"><div className="login-brand"><span className="brand-mark"><ShieldCheck size={28}/></span><span>admin<span className="brand-dot">.</span></span></div>
  <section className="login-card"><span className="eyebrow">Area pemilik restoran</span><h1>Kelola akun,<br/>bukan kasir.</h1><p className="muted">Masuk dengan akun pemilik untuk mengatur peran dan izin masuk staf. Halaman ini tidak membuka kasir, sif, atau data penjualan.</p>
  <form onSubmit={signIn}><label>Email pemilik<input name="email" type="email" required autoComplete="username"/></label><label>Kata sandi<input name="password" type="password" required minLength={8} autoComplete="current-password"/></label><Button className="full" loading={busy} disabled={!configured}>Masuk sebagai pemilik <ArrowRight size={18}/></Button></form>
  {error&&<p role="alert" className="error">{error}</p>}
  <div className="separator"><span>Bukan pemilik?</span></div><a href="/"><Button variant="secondary" className="full">Ke halaman kasir <ArrowRight size={18}/></Button></a>
  <p className="small muted"><ShieldCheck size={15}/> Akun staf ditolak di sini. Peran dan izin diperiksa ulang oleh server pada setiap perubahan.</p></section>
  <p className="login-foot">Meja · area pemilik</p></main>
 return <div className="admin-page"><header className="admin-bar"><span className="brand-mark"><ShieldCheck size={19}/></span>
  <div className="admin-bar-title"><strong>Area pemilik</strong><small>{me.name} · restoran {me.restaurant_id.slice(0,8)}</small></div>
  <a href="/" className="text-button"><Store size={14}/> Halaman kasir</a>
  <Button variant="secondary" size="sm" disabled={busy} onClick={()=>void run(async()=>{await supabase!.auth.signOut();setMe(null);setStaff([])})}><LogOut size={16}/> Keluar</Button></header>
 <main className="admin-main"><div className="page-heading"><div><p className="eyebrow">Kelola siapa yang boleh masuk</p><h1>Akun staf</h1><p className="muted">Peran dan izin masuk. Sandi dan email tidak pernah dibaca aplikasi.</p></div></div>
  <div className="admin-stats"><div className="admin-stat"><span>Total akun</span><strong>{staff.length}</strong></div><div className="admin-stat"><span>Aktif</span><strong>{staff.filter(s=>s.active).length}</strong></div><div className="admin-stat"><span>Nonaktif</span><strong>{staff.filter(s=>!s.active).length}</strong></div></div>
  <article className="panel"><div className="panel-heading"><h2>Daftar akun</h2><span className="badge">Perubahan langsung berlaku</span></div>
  {busy&&!staff.length&&[0,1,2].map(i=><div className="skeleton skeleton-row" key={i} role="status" aria-label="Memuat akun staf"/>)}
  {staff.map(s=><div className="staff-row" key={s.user_id}>
   <span className="staff-avatar" aria-hidden>{s.name.slice(0,1).toUpperCase()}</span>
   <div><div className="staff-name">{s.name}{s.user_id===me.user_id&&<span className="chip">Anda</span>}</div>
    <div className="staff-meta"><span className={`status-dot ${s.active?'':'offline'}`}/>{s.active?'Aktif':'Nonaktif'}{s.user_id===me.user_id?' · peran dan akses sendiri diubah lewat terminal':s.active?'':' · ditolak server saat masuk'}</div></div>
   <div className="staff-controls"><Select ariaLabel={`Peran ${s.name}`} disabled={busy||s.user_id===me.user_id} value={s.role} onChange={v=>change(s,{role:v as Role})} options={(Object.keys(label) as Role[]).map(r=>({value:r,label:label[r]}))}/>
   {s.user_id===me.user_id?<span className="chip">Dikunci</span>:<Button variant={s.active?'destructive':'secondary'} loading={pending===s.user_id} disabled={busy} onClick={()=>change(s,{active:!s.active})}>{s.active?'Nonaktifkan':'Aktifkan'}</Button>}</div></div>)}</article>
  <p className="callout">Menonaktifkan akun berlaku di server: sif yang sedang berjalan tetap harus ditutup dan operasi yang belum tersinkron dari perangkat itu akan ditolak. Nonaktifkan setelah sif selesai.</p>
  <article className="panel"><div className="panel-heading"><h2><Terminal size={17}/> Akun baru dan sandi</h2></div><p className="muted">Pendaftaran publik dimatikan. Membuat akun, mengganti sandi, dan melihat email butuh kunci service role yang hanya ada di terminal pemilik — tidak pernah di aplikasi.</p>
  <div className="code-block"><code>{`pnpm staff add <email> <peran> <nama> --restaurant ${me.restaurant_id}\npnpm staff reset-password <email>\npnpm staff list`}</code></div>
  <p className="small muted">Sandi awal ditampilkan sekali. Serahkan langsung ke staf, jangan lewat chat atau email.</p></article>
  {error&&<p role="alert" className="error">{error}</p>}</main>
 {notice&&<div className="toast" role="status"><span className="status-dot"/>{notice}</div>}</div>
}
