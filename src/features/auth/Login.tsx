import { useEffect,useState } from 'react'
import { Spinner } from '../../components/ui/loading'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ArrowRight,ArrowLeft,ShieldCheck,KeyRound,Mail,LockKeyhole } from 'lucide-react'
import { Mark } from '../../components/logo'
import { PinPad } from '../../components/ui/pinpad'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { Button } from '../../components/ui/button'
import { Select } from '../../components/ui/select'
import { roleLabel,roleTitle,roles } from '../../domain/permissions'
import { configured,supabase } from '../../lib/supabase'
import { databaseFor,uid } from '../../lib/db'
import type { Identity,Role } from '../../domain/types'
const schema=z.object({email:z.email('Masukkan email yang valid'),password:z.string().min(6,'Minimal 6 karakter')})
export interface TeamMember { id:string; name:string; role:Role; login?:string }
// The PIN never leaves the device in clear: its hash unlocks the screen after 2 minutes idle, offline too.
// PBKDF2 with many rounds: a 6-digit PIN is small, so make each guess against the stored hash cost ~0.1 s.
export async function pinHash(pin:string,userId:string){const enc=new TextEncoder();const key=await crypto.subtle.importKey('raw',enc.encode(pin),'PBKDF2',false,['deriveBits']);const bytes=await crypto.subtle.deriveBits({name:'PBKDF2',salt:enc.encode(`takar:${userId}`),iterations:200000,hash:'SHA-256'},key,256);return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('')}
export const team=():TeamMember[]=>{try{return JSON.parse(localStorage.getItem('takar-team')||'[]')}catch{return []}}
// Two letters, as the Figma avatars draw them: first letters of two words, or the first two of a single name (Kinoy → KI).
export const initials=(n:string)=>{const w=n.trim().split(/\s+/);return (w.length>1?w[0][0]+w[1][0]:w[0].slice(0,2)).toUpperCase()}
// The server decides who this account is and how this device is paired; local data is refreshed from
// it unless unsynced work is waiting. Runs at sign-in and after pairing the device.
export async function bootstrap(id:string,deviceId:string):Promise<Identity>{
 const {data:boot,error:b}=await supabase!.rpc('bootstrap',{device_id:deviceId});if(b)throw b
 const user:Identity={id,name:boot.name,role:boot.role,restaurantId:boot.restaurantId,primary:boot.primary,deviceId,demo:false,mode:boot.device?.mode??null};const db=databaseFor(user)
 // The device keeps the team list so staff can pick their name and type their PIN next time.
 try{if(boot.team)localStorage.setItem('takar-team',JSON.stringify(boot.team));if(boot.settings?.name)localStorage.setItem('takar-store',boot.settings.name)}catch{/* private mode */}
 const pending=await db.outbox.where('state').anyOf('pending','rejected').count();if(!pending){await db.transaction('rw',db.tables,async()=>{await db.settings.put(boot.settings);await db.menu.clear();await db.menu.bulkPut(boot.menu);await db.stock.clear();await db.stock.bulkPut(boot.stock);await db.orders.bulkPut(boot.orders);await db.shifts.bulkPut(boot.shifts);await db.cash.bulkPut(boot.cash);await db.movements.clear();await db.movements.bulkPut(boot.movements);await db.counts.bulkPut(boot.counts??[]);await db.purchaseOrders.bulkPut(boot.purchaseOrders??[]);await db.suppliers.bulkPut(boot.suppliers??[]);await db.salesOrders.bulkPut(boot.salesOrders??[]);await db.transfers.bulkPut(boot.outletData?.transfers??[]);await db.meta.put({id:'outlets',value:JSON.stringify(boot.outletData?.outlets??[])});await db.meta.put({id:'costs',value:JSON.stringify(boot.costs??{})});await db.meta.put({id:'pullCursor',value:boot.now??new Date().toISOString()});await db.meta.put({id:'device',value:JSON.stringify(boot.device??{})});await db.meta.put({id:'initialized',value:'yes'})})}
 return user
}
export default function Login({onLogin}:{onLogin:(u:Identity)=>void}){
 // Tanpa ini bundel lama bisa tertahan selamanya: prompt pembaruan hanya ada di shell kasir,
 // yang baru dipasang setelah masuk. Di layar ini tidak ada yang bisa hilang saat memuat ulang.
 const {needRefresh:[needRefresh],updateServiceWorker}=useRegisterSW();useEffect(()=>{if(needRefresh)void updateServiceWorker(true)},[needRefresh])
 const [error,setError]=useState('');const [loading,setLoading]=useState(false);const [demoRole,setDemoRole]=useState<Role>('owner')
 const members=team().filter(m=>m.login)
 const [byEmail,setByEmail]=useState(members.length===0);const [who,setWho]=useState('');const [pin,setPin]=useState('');const [tryDemo,setTryDemo]=useState(false)
 const form=useForm<z.infer<typeof schema>>({resolver:zodResolver(schema)})
 const deviceId=localStorage.getItem('meja-device')||uid();localStorage.setItem('meja-device',deviceId)
 async function signIn(email:string,password:string,remember?:string){setLoading(true);setError('')
  try{if(!supabase)throw new Error('Koneksi restoran belum diatur. Gunakan demo lokal atau isi konfigurasi Supabase.')
   const {data,error:e}=await supabase.auth.signInWithPassword({email,password});if(e)throw new Error(remember?'PIN salah atau akun tidak aktif':e.message)
   const user=await bootstrap(data.user!.id,deviceId)
   // CTL-4: the PIN's hash stays on this device so the lock screen can check it offline.
   // Owners and managers never leave a PIN hash on a shared device: their lock screen asks the server instead.
   try{if(remember&&!['owner','manager'].includes(user.role))localStorage.setItem('takar-pin-hash',await pinHash(remember,user.id));else localStorage.removeItem('takar-pin-hash')}catch{/* private mode */}
   onLogin(user)}
  catch(e){setError(e instanceof Error?e.message:'Login gagal');setPin('')}finally{setLoading(false)}}
 // Each demo role has its own local data, so trying the cashier view never touches the owner's demo.
 function demo(){onLogin({id:`demo-${demoRole}`,name:`${roleLabel[demoRole]} Demo`,role:demoRole,restaurantId:'local-demo',deviceId,primary:true,demo:true})}
 const member=members.find(m=>m.id===who);const people=!byEmail&&members.length>0
 const store=(()=>{try{return localStorage.getItem('takar-store')||''}catch{return ''}})()
 // The shared tablet can sit on this screen for hours: keep the clock in the corner current.
 const [tick,setTick]=useState(()=>new Date());useEffect(()=>{const t=setInterval(()=>setTick(new Date()),30000);return()=>clearInterval(t)},[])
 const now=`${tick.toLocaleDateString('id-ID',{weekday:'long'})} ${tick.toLocaleDateString('id-ID',{day:'numeric',month:'long'})}, ${tick.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})}`
 const demoBox=<div className="signin-demo"><Select label="Coba sebagai" value={demoRole} onChange={v=>setDemoRole(v as Role)} options={roles.map(r=>({value:r,label:roleTitle[r]}))}/><Button variant="secondary" className="full" onClick={demo}>Jelajahi demo lokal <ArrowRight size={18}/></Button><p className="small muted"><ShieldCheck size={15}/> Demo tersimpan di perangkat ini. Tidak terhubung ke data restoran.</p></div>
 // Figma C0a/C0b: pick your name, then a card with your PIN. Everyone signs in as themselves on the shared tablet.
 if(people)return <main className="signin">
  <header className="signin-top"><div className="login-brand"><span className="brand-mark"><Mark size={40}/></span><span>takar</span></div><span>{[store,now].filter(Boolean).join('. ')}</span></header>
  {!member?<section className="signin-pick">
   <h1>Siapa yang bertugas hari ini?</h1><p className="muted">Ketuk nama Anda, lalu masukkan PIN.</p>
   <div className="signin-people">{members.map(m=><button type="button" key={m.id} className="signin-person" onClick={()=>{setWho(m.id);setPin('');setError('')}}><span className="avatar">{initials(m.name)}</span><strong>{m.name}</strong><small>{roleLabel[m.role]}</small>{['owner','manager'].includes(m.role)&&<span className="signin-chip">Menyetujui dan menutup hari</span>}</button>)}</div>
   <p className="small muted">Tidak ada di daftar? Pemilik atau manajer menambahkan staf dari laptop.</p>
   <p className="signin-links"><button type="button" className="text-button" onClick={()=>setByEmail(true)}><Mail size={14}/> Masuk dengan email</button><button type="button" className="text-button" onClick={()=>setTryDemo(!tryDemo)}>Coba demo lokal</button></p>
   {tryDemo&&demoBox}
  </section>
  :<form className="signin-card" onSubmit={e=>{e.preventDefault();if(member.login)void signIn(member.login,pin,pin)}}>
   <div className="signin-who"><span className="avatar">{initials(member.name)}</span><h2>Hai {member.name}</h2><p className="muted">{roleLabel[member.role]}.<br/>PIN Anda 6 angka.</p>
    <Button type="button" variant="secondary" onClick={()=>{setWho('');setPin('');setError('')}}><ArrowLeft size={18}/> Bukan Anda? Pilih nama</Button>
    {error&&<p role="alert" className="error">{error}</p>}</div>
   {/* The sixth digit signs in, as on the Figma; no extra button to find. */}
   <div className="signin-pin"><strong>{loading?<Spinner label="Memeriksa…"/>:'Masukkan PIN'}</strong><PinPad label="Masukkan PIN" value={pin} onChange={v=>{setPin(v);if(v.length===6&&member.login&&configured&&!loading)void signIn(member.login,v,v)}} hint="3 kali salah mengunci masuk selama 5 menit."/></div>
  </form>}
  {!member&&<p className="signin-foot"><LockKeyhole size={18}/> Setiap orang masuk dengan PIN sendiri, jadi setiap penjualan dan pembatalan tercatat atas namanya.</p>}
 </main>
 return <main className="login-page">
  <header className="login-top"><div className="login-brand"><span className="brand-mark"><Mark size={32}/></span><span>takar</span></div><small>{new Date().toLocaleDateString('id-ID',{weekday:'long',day:'numeric',month:'long'})}</small></header>
  <section className="login-card">
   <span className="eyebrow">Setiap gram tercatat</span>
   <h1>Siap melayani,<br/>satu pesanan lagi.</h1><p className="muted">Catat pesanan, kirim ke stasiun, dan tutup hari dengan stok yang cocok.</p>
   <form onSubmit={form.handleSubmit(v=>signIn(v.email,v.password))}>
    <label>Email staf<input autoComplete="username" type="email" {...form.register('email')}/></label>
    {form.formState.errors.email&&<p className="error">{form.formState.errors.email.message}</p>}
    <label>Kata sandi<input autoComplete="current-password" type="password" {...form.register('password')}/></label>
    {form.formState.errors.password&&<p className="error">{form.formState.errors.password.message}</p>}
    <Button className="full" loading={loading} disabled={!configured}>Masuk ke restoran <ArrowRight size={18}/></Button>
    {members.length>0&&<p className="small muted"><button type="button" className="text-button" onClick={()=>setByEmail(false)}><KeyRound size={14}/> Masuk dengan nama dan PIN</button></p>}
   </form>
   {error&&<p role="alert" className="error">{error}</p>}
   <div className="separator"><span>Ingin mencoba terlebih dahulu?</span></div>
   {demoBox}
   <p className="small muted">Akun dan PIN dibuat oleh pemilik. Lupa PIN? Minta pemilik menggantinya.</p>
  </section>
 </main>
}
