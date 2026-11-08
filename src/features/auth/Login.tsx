import { useEffect,useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ArrowRight,ShieldCheck,KeyRound,Mail } from 'lucide-react'
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
// The server decides who this account is and how this device is paired; local data is refreshed from
// it unless unsynced work is waiting. Runs at sign-in and after pairing the device.
export async function bootstrap(id:string,deviceId:string):Promise<Identity>{
 const {data:boot,error:b}=await supabase!.rpc('bootstrap',{device_id:deviceId});if(b)throw b
 const user:Identity={id,name:boot.name,role:boot.role,restaurantId:boot.restaurantId,primary:boot.primary,deviceId,demo:false,mode:boot.device?.mode??null};const db=databaseFor(user)
 // The device keeps the team list so staff can pick their name and type their PIN next time.
 try{if(boot.team)localStorage.setItem('takar-team',JSON.stringify(boot.team))}catch{/* private mode */}
 const pending=await db.outbox.where('state').anyOf('pending','rejected').count();if(!pending){await db.transaction('rw',db.tables,async()=>{await db.settings.put(boot.settings);await db.menu.clear();await db.menu.bulkPut(boot.menu);await db.stock.clear();await db.stock.bulkPut(boot.stock);await db.orders.bulkPut(boot.orders);await db.shifts.bulkPut(boot.shifts);await db.cash.bulkPut(boot.cash);await db.movements.clear();await db.movements.bulkPut(boot.movements);await db.counts.bulkPut(boot.counts??[]);await db.purchaseOrders.bulkPut(boot.purchaseOrders??[]);await db.suppliers.bulkPut(boot.suppliers??[]);await db.salesOrders.bulkPut(boot.salesOrders??[]);await db.transfers.bulkPut(boot.outletData?.transfers??[]);await db.meta.put({id:'outlets',value:JSON.stringify(boot.outletData?.outlets??[])});await db.meta.put({id:'costs',value:JSON.stringify(boot.costs??{})});await db.meta.put({id:'pullCursor',value:boot.now??new Date().toISOString()});await db.meta.put({id:'device',value:JSON.stringify(boot.device??{})});await db.meta.put({id:'initialized',value:'yes'})})}
 return user
}
export default function Login({onLogin}:{onLogin:(u:Identity)=>void}){
 // Tanpa ini bundel lama bisa tertahan selamanya: prompt pembaruan hanya ada di shell kasir,
 // yang baru dipasang setelah masuk. Di layar ini tidak ada yang bisa hilang saat memuat ulang.
 const {needRefresh:[needRefresh],updateServiceWorker}=useRegisterSW();useEffect(()=>{if(needRefresh)void updateServiceWorker(true)},[needRefresh])
 const [error,setError]=useState('');const [loading,setLoading]=useState(false);const [demoRole,setDemoRole]=useState<Role>('owner')
 const members=team().filter(m=>m.login)
 const [byEmail,setByEmail]=useState(members.length===0);const [who,setWho]=useState(members[0]?.id??'');const [pin,setPin]=useState('')
 const form=useForm<z.infer<typeof schema>>({resolver:zodResolver(schema)})
 const deviceId=localStorage.getItem('meja-device')||uid();localStorage.setItem('meja-device',deviceId)
 async function signIn(email:string,password:string,remember?:string){setLoading(true);setError('')
  try{if(!supabase)throw new Error('Koneksi restoran belum diatur. Gunakan demo lokal atau isi konfigurasi Supabase.')
   const {data,error:e}=await supabase.auth.signInWithPassword({email,password});if(e)throw new Error(remember?'PIN salah atau akun tidak aktif':e.message)
   const user=await bootstrap(data.user!.id,deviceId)
   // CTL-4: the PIN's hash stays on this device so the lock screen can check it offline.
   // Owners and managers never leave a PIN hash on a shared device: their lock screen signs them out instead.
   try{if(remember&&!['owner','manager'].includes(user.role))localStorage.setItem('takar-pin-hash',await pinHash(remember,user.id));else localStorage.removeItem('takar-pin-hash')}catch{/* private mode */}
   onLogin(user)}
  catch(e){setError(e instanceof Error?e.message:'Login gagal');setPin('')}finally{setLoading(false)}}
 // Each demo role has its own local data, so trying the cashier view never touches the owner's demo.
 function demo(){onLogin({id:`demo-${demoRole}`,name:`${roleLabel[demoRole]} Demo`,role:demoRole,restaurantId:'local-demo',deviceId,primary:true,demo:true})}
 const member=members.find(m=>m.id===who);const people=!byEmail&&members.length>0
 const initials=(n:string)=>n.split(/\s+/).slice(0,2).map(w=>w[0]??'').join('').toUpperCase()
 return <main className="login-page">
  <header className="login-top"><div className="login-brand"><span className="brand-mark"><Mark size={32}/></span><span>takar</span></div><small>{new Date().toLocaleDateString('id-ID',{weekday:'long',day:'numeric',month:'long'})}</small></header>
  <section className={`login-card ${people?'wide':''}`}>
   <span className="eyebrow">Setiap gram tercatat</span>
   {people?<><h1>Siapa yang bertugas hari ini?</h1><p className="muted">Ketuk nama Anda, lalu masukkan PIN.</p></>:<><h1>Siap melayani,<br/>satu pesanan lagi.</h1><p className="muted">Catat pesanan, kirim ke stasiun, dan tutup hari dengan stok yang cocok.</p></>}
   {!byEmail&&members.length>0?<form onSubmit={e=>{e.preventDefault();if(member?.login)void signIn(member.login,pin,pin)}}>
    <div className="people" role="radiogroup" aria-label="Nama">{members.map(m=><button type="button" key={m.id} role="radio" aria-checked={who===m.id} className={`person ${who===m.id?'active':''}`} onClick={()=>{setWho(m.id);setPin('')}}><span className="avatar">{initials(m.name)}</span><strong>{m.name}</strong><small>{roleLabel[m.role]}</small></button>)}</div>
    <div className="pin-panel"><div><h2>Hai {member?.name??'…'}</h2><p className="muted">{member?`${roleLabel[member.role]}. PIN Anda 6 angka.`:'Pilih nama dulu.'}</p>
     <Button className="full mt" loading={loading} disabled={!configured||!member||pin.length!==6}><KeyRound size={18}/> Masuk</Button></div>
     <PinPad label="PIN (6 angka)" value={pin} onChange={setPin} onSubmit={()=>{if(member?.login)void signIn(member.login,pin,pin)}} hint="3 kali salah mengunci masuk selama 5 menit."/></div>
    <p className="small muted"><button type="button" className="text-button" onClick={()=>setByEmail(true)}><Mail size={14}/> Masuk dengan email dan kata sandi</button></p>
   </form>
   :<form onSubmit={form.handleSubmit(v=>signIn(v.email,v.password))}>
    <label>Email staf<input autoComplete="username" type="email" {...form.register('email')}/></label>
    {form.formState.errors.email&&<p className="error">{form.formState.errors.email.message}</p>}
    <label>Kata sandi<input autoComplete="current-password" type="password" {...form.register('password')}/></label>
    {form.formState.errors.password&&<p className="error">{form.formState.errors.password.message}</p>}
    <Button className="full" loading={loading} disabled={!configured}>Masuk ke restoran <ArrowRight size={18}/></Button>
    {members.length>0&&<p className="small muted"><button type="button" className="text-button" onClick={()=>setByEmail(false)}><KeyRound size={14}/> Masuk dengan nama dan PIN</button></p>}
   </form>}
   {error&&<p role="alert" className="error">{error}</p>}
   <div className="separator"><span>Ingin mencoba terlebih dahulu?</span></div>
   <Select label="Coba sebagai" value={demoRole} onChange={v=>setDemoRole(v as Role)} options={roles.map(r=>({value:r,label:roleTitle[r]}))}/>
   <Button variant="secondary" className="full" onClick={demo}>Jelajahi demo lokal <ArrowRight size={18}/></Button>
   <p className="small muted"><ShieldCheck size={15}/> Demo tersimpan di perangkat ini. Tidak terhubung ke data restoran.</p>
   <p className="small muted">Akun dan PIN disediakan pemilik atau manajer. Lupa PIN? Minta diganti.</p>
  </section>
  <p className="login-foot">Takar · setiap gram tercatat.</p>
 </main>
}
