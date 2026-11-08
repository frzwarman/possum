// Penyediaan akun staf tepercaya: pendaftaran publik dimatikan, pemilik yang membuat akun.
// Dijalankan HANYA di terminal pemilik (`pnpm staff`) dengan service role key dari .env.admin
// (gitignored). Berkas ini ada di scripts/ sehingga Vite tidak pernah mem-bundle-nya ke web app,
// dan kunci hanya dibaca dari process.env — tidak pernah dari VITE_*, tidak pernah dicetak.
import { createClient } from '@supabase/supabase-js'
import { randomBytes,randomUUID } from 'node:crypto'
const ROLES=['owner','manager','admin','chef','cashier','barista','kitchen'],MIN=8,MAX_STAFF=20
const argv=process.argv.slice(2),pos=[],flags={}
for(let i=0;i<argv.length;i++) if(argv[i].startsWith('--')){flags[argv[i].slice(2)]=argv[i+1]&&!argv[i+1].startsWith('--')?argv[++i]:true} else pos.push(argv[i])
const cmd=pos.shift()
const usage=`Takar — penyediaan akun staf (pendaftaran publik dimatikan)

  pnpm staff init <email-pemilik> [nama] [--restoran <nama restoran>]
  pnpm staff list [--restaurant <uuid>]
  pnpm staff add <email> <${ROLES.join('|')}> <nama> --restaurant <uuid> [--pin <6 angka>|--password <sandi>] [--force]
  pnpm staff role <email> <${ROLES.join('|')}>
  pnpm staff disable <email>
  pnpm staff enable <email>
  pnpm staff reset-password <email> [--pin <6 angka>|--password <sandi>]
  pnpm staff link-outlets <uuid-restoran> <uuid-restoran-lain>   (outlet baru: init --force)

Butuh SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY dari .env.admin (salin dari .env.admin.example,
jangan pernah di-commit, jangan pernah pakai awalan VITE_ untuk kunci ini).
Staf masuk di perangkat bersama dengan PIN 6 angka (--pin); PIN itu adalah sandi akunnya. Tanpa --pin
atau --password, sandi dibuat acak dan ditampilkan SEKALI saja. Sandi minimal ${MIN} karakter.
Batas wajar 2-${MAX_STAFF} akun staf; melebihi itu perlu --force.`
if(!cmd){console.log(usage);process.exit(0)}
const die=m=>{console.error(m);process.exit(1)}
const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY
if(!url||url.includes('YOUR_PROJECT')) die('SUPABASE_URL belum diisi. Salin .env.admin.example ke .env.admin lalu isi nilainya, dan jalankan lewat `pnpm staff`.')
if(!key||key.includes('YOUR_')||key.length<40) die('SUPABASE_SERVICE_ROLE_KEY belum diisi atau masih nilai contoh. Isi .env.admin dengan service role key dari dasbor Supabase (server-only).')
const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}})
const ok=(e,what)=>{if(e) die(`Gagal ${what}: ${e.message}`)}
const generate=()=>randomBytes(12).toString('base64url')
// A PIN is the account's password. For owners and managers it also opens the back office, so warn.
const sandi=(role)=>{if(typeof flags.pin==='string'){if(!/^\d{6}$/.test(flags.pin)) die('PIN harus 6 angka.');if(['owner','manager'].includes(role)) console.warn('Peringatan: PIN 6 angka ini juga membuka back office; pertimbangkan --password untuk akun ini.');return flags.pin}const p=typeof flags.password==='string'?flags.password:generate();if(p.length<MIN) die(`Sandi minimal ${MIN} karakter.`);return p}
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
}else if(cmd==='init'){
 const [email,...rest]=pos,nama=rest.join(' ')||'Pemilik'
 if(!email) die('Pakai: pnpm staff init <email-pemilik> [nama] [--restoran "Nama Warung"]')
 const {count,error:ce}=await db.from('restaurants').select('id',{count:'exact',head:true});ok(ce,'menghitung restoran')
 if(count&&!flags.force) die(`Sudah ada ${count} restoran. init hanya untuk penyiapan pertama; tambah staf dengan add, atau --force bila memang perlu restoran baru.`)
 const pw=sandi('owner')
 // Sama dengan defaultSettings di src/domain/sample.ts. id:'settings' wajib: itu kunci tabel settings di perangkat.
 const settings={id:'settings',appName:'Takar',name:typeof flags.restoran==='string'?flags.restoran:'Restoran Anda',address:'',phone:'',footer:'Terima kasih. Sampai jumpa lagi!',timezone:'Asia/Jakarta',cutoff:4,taxBps:0,serviceBps:0,receiptWidth:80,printableWidth:72,goLive:new Date().toISOString().slice(0,10),packaging:[],stations:{kitchen:15,bar:8},varianceLimit:10000,lowAt:5,stationTablets:false}
 const {data:restaurant,error:re}=await db.from('restaurants').insert({settings}).select('id').single();ok(re,'membuat restoran')
 const {data:created,error}=await db.auth.admin.createUser({email,password:pw,email_confirm:true});ok(error,'membuat akun auth')
 const {error:me}=await db.from('memberships').insert({restaurant_id:restaurant.id,user_id:created.user.id,role:'owner',name:nama,active:true,login:email})
 // Keanggotaan gagal berarti restoran dan akun auth yatim: batalkan keduanya supaya init bisa diulang.
 if(me){await db.auth.admin.deleteUser(created.user.id);await db.from('restaurants').delete().eq('id',restaurant.id);die(`Gagal menyimpan keanggotaan: ${me.message} — akun auth dan restoran dibatalkan.`)}
 console.log(`Restoran dibuat: ${settings.name}`)
 console.log(`ID restoran    : ${restaurant.id}`)
 console.log(`Pemilik        : ${nama} ${email}`)
 console.log(`Sandi awal     : ${pw}`)
 console.log(`Catat sekarang — sandi ini tidak ditampilkan lagi. Tambah staf berikutnya dengan:\n  pnpm staff add <email> <peran> <nama> --restaurant ${restaurant.id}`)
}else if(cmd==='add'){
 const [email,role,...rest]=pos,nama=rest.join(' ')
 if(!email||!role||!nama) die('Pakai: pnpm staff add <email> <peran> <nama> --restaurant <uuid>')
 if(!ROLES.includes(role)) die(`Peran harus salah satu dari: ${ROLES.join(', ')}`)
 if(typeof flags.restaurant!=='string') die('--restaurant <uuid> wajib diisi. Lihat id restoran dengan: pnpm staff list')
 const pw=sandi(role)
 const {count,error:ce}=await db.from('memberships').select('user_id',{count:'exact',head:true}).eq('restaurant_id',flags.restaurant);ok(ce,'menghitung staf')
 if(count>=MAX_STAFF&&!flags.force) die(`Sudah ada ${count} staf (batas wajar ${MAX_STAFF}). Tambahkan --force bila memang diperlukan.`)
 const {data:created,error}=await db.auth.admin.createUser({email,password:pw,email_confirm:true});ok(error,'membuat akun auth')
 const {error:me}=await db.from('memberships').insert({restaurant_id:flags.restaurant,user_id:created.user.id,role,name:nama,active:true,login:email})
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
 const {user,row}=await member(email),pw=sandi(row.role)
 const {error}=await db.auth.admin.updateUserById(user.id,{password:pw});ok(error,'mengganti sandi')
 console.log(`Sandi baru ${email}: ${pw}`)
 console.log('Ditampilkan SEKALI. Serahkan langsung ke staf, jangan lewat chat atau email.')
}else if(cmd==='link-outlets'){
 // Outlet = restoran sendiri (staf, kasir utama, stok). Outlet dalam satu grup boleh saling transfer stok.
 const ids=pos;if(ids.length<2) die('Pakai: pnpm staff link-outlets <uuid-restoran> <uuid-restoran-lain> [...]')
 const {data,error}=await db.from('restaurants').select('id,group_id,settings').in('id',ids);ok(error,'membaca restoran')
 if(data.length!==new Set(ids).size) die('Ada id restoran yang tidak ditemukan. Lihat id dengan: pnpm staff list')
 const group=data.find(r=>r.group_id)?.group_id??randomUUID()
 const {error:ue}=await db.from('restaurants').update({group_id:group}).in('id',ids);ok(ue,'menghubungkan outlet')
 console.log(`Terhubung dalam satu grup (${group}):\n${data.map(r=>`  ${r.settings?.name} ${r.id}`).join('\n')}`)
}else die(`Perintah tidak dikenal: ${cmd}\n\n${usage}`)
