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
import { store,type Bootstrap } from '../../lib/sync'
import { pauseNote,pinPause,pinTried,signInError } from '../../lib/signin'
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
 const user:Identity={id,name:boot.name,role:boot.role,restaurantId:boot.restaurantId,primary:boot.primary,deviceId,demo:false,mode:boot.device?.mode??null};const db=databaseFor(user);await db.meta.delete('stale') // a fresh identity: the pull's older verdict on the last one no longer applies
 // The device keeps the team list so staff can pick their name and type their PIN next time. AUTH-13: a member of
 // another restaurant signing in here (a visiting manager of a linked outlet) does not replace the till's own picker
 // and store name: the list is replaced when the device is paired with that restaurant, or has no other one yet.
 try{const known=localStorage.getItem('takar-restaurant');if(!(known&&known!==boot.restaurantId&&!boot.device?.enrolled)){if(boot.team)localStorage.setItem('takar-team',JSON.stringify(boot.team));if(boot.settings?.name)localStorage.setItem('takar-store',boot.settings.name);localStorage.setItem('takar-restaurant',boot.restaurantId)}}catch{/* private mode */}
 const pending=await db.outbox.where('state').anyOf('pending','rejected').count();if(!pending)await store(db,boot as Bootstrap)
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
 // `who` is the member picked on the pad: three wrong PINs pause that person's pad for five minutes (AUTH-03), and
 // only a refused PIN counts (AUTH-11: no answer from the server is reported as that, not as a wrong PIN).
 const wrong=(who?:string)=>who?'PIN salah atau akun tidak aktif':'Email atau kata sandi salah, atau akun tidak aktif'
 async function signIn(email:string,password:string,who?:string){setLoading(true);setError('')
  try{if(!supabase)throw new Error('Koneksi restoran belum diatur. Gunakan demo lokal atau isi konfigurasi Supabase.')
   const wait=who?pinPause(who):0;if(wait)throw new Error(pauseNote(wait))
   const {data,error:e}=await supabase.auth.signInWithPassword({email,password});if(e){const said=signInError(e,wrong(who));if(who&&said.name==='Wrong'){pinTried(who,false);const now=pinPause(who);if(now)throw new Error(pauseNote(now))}throw said}
   if(who)pinTried(who,true)
   // An account the server no longer accepts (deactivated) gets no session left on the device.
   let user:Identity;try{user=await bootstrap(data.user!.id,deviceId)}catch(b){await supabase.auth.signOut({scope:'local'}).catch(()=>undefined);throw signInError(b as {message?:string},wrong(who))}
   // CTL-4: the hash of the secret stays on this device so the lock screen can check it offline, whoever signed in and
   // whichever way (AUTH-02, SYNC-07: a till in an outage must open for the person who locked it). A password that is
   // not a 6-digit PIN is marked, so the lock asks for a password instead of showing the pad. logout() removes it.
   try{localStorage.setItem('takar-pin-hash',(/^\d{6}$/.test(password)?'':'pw:')+await pinHash(password,user.id))}catch{/* private mode */}
   onLogin(user)}
  catch(e){setError(e instanceof Error?e.message:'Login gagal');setPin('')}finally{setLoading(false)}}
 // Each demo role has its own local data, so trying the cashier view never touches the owner's demo.
 function demo(){onLogin({id:`demo-${demoRole}`,name:`${roleLabel[demoRole]} Demo`,role:demoRole,restaurantId:'local-demo',deviceId,primary:true,demo:true})}
 const member=members.find(m=>m.id===who);const people=!byEmail&&members.length>0
 // The pause is read at every render; the clock below re-renders the screen every 30 s, so it lifts on its own.
 const paused=member?pinPause(member.id):0
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
  :<form className="signin-card" onSubmit={e=>{e.preventDefault();if(member.login&&!paused)void signIn(member.login,pin,member.id)}}>
   <div className="signin-who"><span className="avatar">{initials(member.name)}</span><h2>Hai {member.name}</h2><p className="muted">{roleLabel[member.role]}.<br/>PIN Anda 6 angka.</p>
    <Button type="button" variant="secondary" onClick={()=>{setWho('');setPin('');setError('')}}><ArrowLeft size={18}/> Bukan Anda? Pilih nama</Button>
    {error&&<p role="alert" className="error">{error}</p>}</div>
   {/* The sixth digit signs in, as on the Figma; no extra button to find. */}
   <div className="signin-pin"><strong>{loading?<Spinner label="Memeriksa…"/>:'Masukkan PIN'}</strong><PinPad label="Masukkan PIN" value={pin} onChange={v=>{setPin(v);if(v.length===6&&member.login&&configured&&!loading&&!paused)void signIn(member.login,v,member.id)}} hint={paused?pauseNote(paused):'3 kali salah mengunci masuk selama 5 menit.'}/></div>
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
