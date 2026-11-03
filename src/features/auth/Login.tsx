import { useEffect,useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ArrowRight,Utensils,ShieldCheck } from 'lucide-react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { Button } from '../../components/ui/button'
import { Select } from '../../components/ui/select'
import { roleLabel,roleTitle } from '../../domain/permissions'
import { configured,supabase } from '../../lib/supabase'
import { databaseFor,uid } from '../../lib/db'
import type { Identity,Role } from '../../domain/types'
const schema=z.object({email:z.email('Masukkan email yang valid'),password:z.string().min(8,'Minimal 8 karakter')})
// The server decides who this account is and whether this device is the primary till; local data is
// refreshed from it unless unsynced work is waiting. Runs at sign-in and after moving the till here.
export async function bootstrap(id:string,deviceId:string):Promise<Identity>{
 const {data:boot,error:b}=await supabase!.rpc('bootstrap',{device_id:deviceId});if(b)throw b
 const user:Identity={id,name:boot.name,role:boot.role,restaurantId:boot.restaurantId,primary:boot.primary,deviceId,demo:false};const db=databaseFor(user)
 const pending=await db.outbox.where('state').anyOf('pending','rejected').count();if(!pending){await db.transaction('rw',db.tables,async()=>{await db.settings.put(boot.settings);await db.menu.clear();await db.menu.bulkPut(boot.menu);await db.stock.bulkPut(boot.stock);await db.orders.bulkPut(boot.orders);await db.shifts.bulkPut(boot.shifts);await db.cash.bulkPut(boot.cash);await db.movements.clear();await db.movements.bulkPut(boot.movements);await db.purchaseOrders.bulkPut(boot.purchaseOrders??[]);await db.suppliers.bulkPut(boot.suppliers??[]);await db.salesOrders.bulkPut(boot.salesOrders??[]);await db.transfers.bulkPut(boot.outletData?.transfers??[]);await db.meta.put({id:'outlets',value:JSON.stringify(boot.outletData?.outlets??[])});await db.meta.put({id:'costs',value:JSON.stringify(boot.costs??{})});await db.meta.put({id:'initialized',value:'yes'})})}
 return user
}
export default function Login({onLogin}:{onLogin:(u:Identity)=>void}){
 // Tanpa ini bundel lama bisa tertahan selamanya: prompt pembaruan hanya ada di shell kasir,
 // yang baru dipasang setelah masuk. Di layar ini tidak ada yang bisa hilang saat memuat ulang.
 const {needRefresh:[needRefresh],updateServiceWorker}=useRegisterSW();useEffect(()=>{if(needRefresh)void updateServiceWorker(true)},[needRefresh])
 const [error,setError]=useState('');const [loading,setLoading]=useState(false);const [demoRole,setDemoRole]=useState<Role>('owner');const form=useForm<z.infer<typeof schema>>({resolver:zodResolver(schema)});
 const deviceId=localStorage.getItem('meja-device')||uid();localStorage.setItem('meja-device',deviceId)
 async function login(values:z.infer<typeof schema>){setLoading(true);setError('');try{if(!supabase)throw new Error('Koneksi restoran belum diatur. Gunakan demo lokal atau isi konfigurasi Supabase.');const {data,error:e}=await supabase.auth.signInWithPassword(values);if(e)throw e;onLogin(await bootstrap(data.user!.id,deviceId))}catch(e){setError(e instanceof Error?e.message:'Login gagal')}finally{setLoading(false)}}
 // Each demo role has its own local data, so trying the cashier view never touches the owner's demo.
 function demo(){onLogin({id:`demo-${demoRole}`,name:`${roleLabel[demoRole]} Demo`,role:demoRole,restaurantId:'local-demo',deviceId,primary:true,demo:true})}
 return <main className="login-page"><div className="login-brand"><span className="brand-mark"><Utensils size={28}/></span><span>meja<span className="brand-dot">.</span></span></div><section className="login-card"><span className="eyebrow">Selamat datang di meja</span><h1>Siap melayani,<br/>satu pesanan lagi.</h1><p className="muted">Catat pesanan, layani pelanggan, dan tutup hari dengan tenang.</p><form onSubmit={form.handleSubmit(login)}><label>Email staf<input autoComplete="username" type="email" {...form.register('email')}/></label>{form.formState.errors.email&&<p className="error">{form.formState.errors.email.message}</p>}<label>Kata sandi<input autoComplete="current-password" type="password" {...form.register('password')}/></label>{form.formState.errors.password&&<p className="error">{form.formState.errors.password.message}</p>}<Button className="full" loading={loading} disabled={!configured}>Masuk ke restoran <ArrowRight size={18}/></Button></form>{error&&<p role="alert" className="error">{error}</p>}<div className="separator"><span>Ingin mencoba terlebih dahulu?</span></div><Select label="Coba sebagai" value={demoRole} onChange={v=>setDemoRole(v as Role)} options={(['owner','manager','cashier'] as Role[]).map(r=>({value:r,label:roleTitle[r]}))}/><Button variant="secondary" className="full" onClick={demo}>Jelajahi demo lokal <ArrowRight size={18}/></Button><p className="small muted"><ShieldCheck size={15}/> Demo tersimpan di perangkat ini. Tidak terhubung ke data restoran.</p><p className="small muted">Akun disediakan pemilik restoran. Lupa kata sandi? Hubungi pemilik.</p></section><p className="login-foot">Dibuat untuk ritme warung Anda.</p></main>
}
