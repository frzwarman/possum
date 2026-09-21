import { useEffect,useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ArrowRight,Utensils,ShieldCheck } from 'lucide-react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { Button } from '../../components/ui/button'
import { configured,supabase } from '../../lib/supabase'
import { databaseFor,uid } from '../../lib/db'
import type { Identity } from '../../domain/types'
const schema=z.object({email:z.email('Masukkan email yang valid'),password:z.string().min(8,'Minimal 8 karakter')})
export default function Login({onLogin}:{onLogin:(u:Identity)=>void}){
 // Tanpa ini bundel lama bisa tertahan selamanya: prompt pembaruan hanya ada di shell kasir,
 // yang baru dipasang setelah masuk. Di layar ini tidak ada yang bisa hilang saat memuat ulang.
 const {needRefresh:[needRefresh],updateServiceWorker}=useRegisterSW();useEffect(()=>{if(needRefresh)void updateServiceWorker(true)},[needRefresh])
 const [error,setError]=useState('');const [loading,setLoading]=useState(false);const form=useForm<z.infer<typeof schema>>({resolver:zodResolver(schema)});
 const deviceId=localStorage.getItem('meja-device')||uid();localStorage.setItem('meja-device',deviceId)
 async function login(values:z.infer<typeof schema>){setLoading(true);setError('');try{if(!supabase)throw new Error('Koneksi restoran belum diatur. Gunakan demo lokal atau isi konfigurasi Supabase.');const {data,error:e}=await supabase.auth.signInWithPassword(values);if(e)throw e;const {data:boot,error:b}=await supabase.rpc('bootstrap',{device_id:deviceId});if(b)throw b;const user:Identity={id:data.user!.id,name:boot.name,role:boot.role,restaurantId:boot.restaurantId,primary:boot.primary,deviceId,demo:false};const db=databaseFor(user);const pending=await db.outbox.where('state').anyOf('pending','rejected').count();if(!pending){await db.transaction('rw',db.tables,async()=>{await db.settings.put(boot.settings);await db.menu.clear();await db.menu.bulkPut(boot.menu);await db.stock.bulkPut(boot.stock);await db.orders.bulkPut(boot.orders);await db.shifts.bulkPut(boot.shifts);await db.cash.bulkPut(boot.cash);await db.movements.clear();await db.movements.bulkPut(boot.movements);await db.meta.put({id:'initialized',value:'yes'})})}onLogin(user)}catch(e){setError(e instanceof Error?e.message:'Login gagal')}finally{setLoading(false)}}
 function demo(){onLogin({id:'demo-owner',name:'Pemilik Demo',role:'owner',restaurantId:'local-demo',deviceId,primary:true,demo:true})}
 return <main className="login-page"><div className="login-brand"><span className="brand-mark"><Utensils size={28}/></span><span>meja<span className="brand-dot">.</span></span></div><section className="login-card"><span className="eyebrow">Selamat datang di meja</span><h1>Siap melayani,<br/>satu pesanan lagi.</h1><p className="muted">Catat pesanan, layani pelanggan, dan tutup hari dengan tenang.</p><form onSubmit={form.handleSubmit(login)}><label>Email staf<input autoComplete="username" type="email" {...form.register('email')}/></label>{form.formState.errors.email&&<p className="error">{form.formState.errors.email.message}</p>}<label>Kata sandi<input autoComplete="current-password" type="password" {...form.register('password')}/></label>{form.formState.errors.password&&<p className="error">{form.formState.errors.password.message}</p>}<Button className="full" loading={loading} disabled={!configured}>Masuk ke restoran <ArrowRight size={18}/></Button></form>{error&&<p role="alert" className="error">{error}</p>}<div className="separator"><span>Ingin mencoba terlebih dahulu?</span></div><Button variant="secondary" className="full" onClick={demo}>Jelajahi demo lokal <ArrowRight size={18}/></Button><p className="small muted"><ShieldCheck size={15}/> Demo tersimpan di perangkat ini. Tidak terhubung ke data restoran.</p><p className="small muted">Akun disediakan pemilik restoran. Lupa kata sandi? Hubungi pemilik.</p></section><p className="login-foot">Dibuat untuk ritme warung Anda.</p></main>
}
