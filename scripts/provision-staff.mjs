// Penyediaan akun staf tepercaya: pendaftaran publik dimatikan, pemilik yang membuat akun.
// Dijalankan HANYA di terminal pemilik (`pnpm staff`) dengan service role key dari .env.admin
// (gitignored). Berkas ini ada di scripts/ sehingga Vite tidak pernah mem-bundle-nya ke web app,
// dan kunci hanya dibaca dari process.env — tidak pernah dari VITE_*, tidak pernah dicetak.
import { createClient } from '@supabase/supabase-js'
import { randomBytes } from 'node:crypto'
const ROLES=['owner','manager','cashier'],MIN=8,MAX_STAFF=10
const argv=process.argv.slice(2),pos=[],flags={}
for(let i=0;i<argv.length;i++) if(argv[i].startsWith('--')){flags[argv[i].slice(2)]=argv[i+1]&&!argv[i+1].startsWith('--')?argv[++i]:true} else pos.push(argv[i])
const cmd=pos.shift()
const usage=`Meja — penyediaan akun staf (pendaftaran publik dimatikan)

  pnpm staff list [--restaurant <uuid>]
  pnpm staff add <email> <${ROLES.join('|')}> <nama> --restaurant <uuid> [--password <sandi>] [--force]
  pnpm staff role <email> <${ROLES.join('|')}>
  pnpm staff disable <email>
  pnpm staff enable <email>
  pnpm staff reset-password <email> [--password <sandi>]

Butuh SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY dari .env.admin (salin dari .env.admin.example,
jangan pernah di-commit, jangan pernah pakai awalan VITE_ untuk kunci ini).
Sandi minimal ${MIN} karakter — sama dengan syarat form login. Tanpa --password sandi dibuat acak
dan ditampilkan SEKALI saja. Batas wajar 2-${MAX_STAFF} akun staf; melebihi itu perlu --force.`
if(!cmd){console.log(usage);process.exit(0)}
const die=m=>{console.error(m);process.exit(1)}
const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY
if(!url||url.includes('YOUR_PROJECT')) die('SUPABASE_URL belum diisi. Salin .env.admin.example ke .env.admin lalu isi nilainya, dan jalankan lewat `pnpm staff`.')
if(!key||key.includes('YOUR_')||key.length<40) die('SUPABASE_SERVICE_ROLE_KEY belum diisi atau masih nilai contoh. Isi .env.admin dengan service role key dari dasbor Supabase (server-only).')
const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}})
const ok=(e,what)=>{if(e) die(`Gagal ${what}: ${e.message}`)}
const generate=()=>randomBytes(12).toString('base64url')
const sandi=()=>{const p=typeof flags.password==='string'?flags.password:generate();if(p.length<MIN) die(`Sandi minimal ${MIN} karakter.`);return p}
async function users(){const {data,error}=await db.auth.admin.listUsers({page:1,perPage:1000});ok(error,'membaca daftar pengguna');return data.users}
async function member(email){
 const u=(await users()).find(u=>u.email?.toLowerCase()===email.toLowerCase())
 if(!u) die(`Pengguna ${email} tidak ditemukan.`)
 const {data,error}=await db.from('memberships').select('*').eq('user_id',u.id).maybeSingle();ok(error,'membaca keanggotaan')
 if(!data) die(`${email} belum terdaftar sebagai staf. Pakai perintah add.`)
 return {user:u,row:data}
}
if(cmd==='list'){
 let q=db.from('memberships').select('restaurant_id,user_id,role,name,active')
 if(typeof flags.restaurant==='string') q=q.eq('restaurant_id',flags.restaurant)
 const {data,error}=await q;ok(error,'membaca daftar staf')
 if(!data.length) die('Belum ada staf terdaftar.')
 const all=await users(),email=id=>all.find(u=>u.id===id)?.email??'(tanpa email)'
 for(const m of data) console.log(`${(m.active?'aktif':'nonaktif').padEnd(8)} ${m.role.padEnd(7)} ${m.name.padEnd(20)} ${email(m.user_id)}  ${m.restaurant_id}`)
 console.log(`\n${data.length} akun staf.`)
}else if(cmd==='add'){
 const [email,role,...rest]=pos,nama=rest.join(' ')
 if(!email||!role||!nama) die('Pakai: pnpm staff add <email> <peran> <nama> --restaurant <uuid>')
 if(!ROLES.includes(role)) die(`Peran harus salah satu dari: ${ROLES.join(', ')}`)
 if(typeof flags.restaurant!=='string') die('--restaurant <uuid> wajib diisi. Lihat id restoran dengan: pnpm staff list')
 const pw=sandi()
 const {count,error:ce}=await db.from('memberships').select('user_id',{count:'exact',head:true}).eq('restaurant_id',flags.restaurant);ok(ce,'menghitung staf')
 if(count>=MAX_STAFF&&!flags.force) die(`Sudah ada ${count} staf (batas wajar ${MAX_STAFF}). Tambahkan --force bila memang diperlukan.`)
 const {data:created,error}=await db.auth.admin.createUser({email,password:pw,email_confirm:true});ok(error,'membuat akun auth')
 const {error:me}=await db.from('memberships').insert({restaurant_id:flags.restaurant,user_id:created.user.id,role,name:nama,active:true})
 // Keanggotaan gagal berarti akun auth yatim: batalkan supaya email bisa dipakai ulang.
 if(me){await db.auth.admin.deleteUser(created.user.id);die(`Gagal menyimpan keanggotaan: ${me.message} — akun auth dibatalkan.`)}
 console.log(`Staf dibuat: ${nama} (${role}) ${email}`)
 console.log(`Sandi awal : ${pw}`)
 console.log('Catat sekarang — sandi ini tidak ditampilkan lagi. Serahkan langsung, minta diganti setelah login pertama.')
}else if(cmd==='role'){
 const [email,role]=pos
 if(!email||!role) die('Pakai: pnpm staff role <email> <peran>')
 if(!ROLES.includes(role)) die(`Peran harus salah satu dari: ${ROLES.join(', ')}`)
 const {row}=await member(email)
 const {error}=await db.from('memberships').update({role}).eq('user_id',row.user_id);ok(error,'mengubah peran')
 console.log(`Peran ${email}: ${row.role} → ${role}`)
}else if(cmd==='disable'||cmd==='enable'){
 const [email]=pos;if(!email) die(`Pakai: pnpm staff ${cmd} <email>`)
 const active=cmd==='enable',{row}=await member(email)
 const {error}=await db.from('memberships').update({active}).eq('user_id',row.user_id);ok(error,'mengubah status')
 console.log(`${email} sekarang ${active?'aktif':'nonaktif'}.${active?'':' Operasi dan bootstrap berikutnya akan ditolak server.'}`)
}else if(cmd==='reset-password'){
 const [email]=pos;if(!email) die('Pakai: pnpm staff reset-password <email> [--password <sandi>]')
 const pw=sandi(),{user}=await member(email)
 const {error}=await db.auth.admin.updateUserById(user.id,{password:pw});ok(error,'mengganti sandi')
 console.log(`Sandi baru ${email}: ${pw}`)
 console.log('Ditampilkan SEKALI. Serahkan langsung ke staf, jangan lewat chat atau email.')
}else die(`Perintah tidak dikenal: ${cmd}\n\n${usage}`)
