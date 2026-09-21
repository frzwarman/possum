// Bundle budget gate. Spec allows 250-300 KiB of compressed initial JavaScript; exits 1 above 300 KiB.
import { readFile,readdir,stat } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
const TARGET=250*1024,BUDGET=300*1024,skip=process.argv.includes('--skip-build')
// gzip di level default zlib (6) — sama dengan angka build Vite dan default nginx/Cloudflare.
const kib=b=>(b/1024).toFixed(1).padStart(8)+' KiB'
const mtime=p=>stat(p).then(s=>s.mtimeMs,()=>0)
const newest=async d=>{let t=0;for(const e of await readdir(d,{recursive:true,withFileTypes:true}).catch(()=>[])) if(e.isFile()) t=Math.max(t,await mtime(`${e.parentPath}/${e.name}`));return t}
const built=await mtime('dist/index.html')
const source=Math.max(await newest('src'),...await Promise.all(['index.html','vite.config.ts','package.json'].map(mtime)))
if(!built&&skip){console.error('dist/ tidak ada. Jalankan tanpa --skip-build, atau `pnpm build` dulu.');process.exit(1)}
if(!skip&&source>built){
 console.log(built?'dist/ usang — build produksi ulang...':'dist/ tidak ada — build produksi...')
 const r=spawnSync('pnpm',['build'],{stdio:'inherit'})
 if(r.status!==0){console.error('Build gagal.');process.exit(1)}
}else console.log(skip?'Melewati build (--skip-build): mengukur dist/ yang ada.':'dist/ masih baru — build dilewati.')
const assets=new Map()
for(const f of await readdir('dist/assets')){const b=await readFile(`dist/assets/${f}`);assets.set(f,{raw:b.length,gz:gzipSync(b).length})}
// Vite emits a modulepreload link for every chunk statically imported by the entry, so what
// index.html references IS the initial graph. Anything else in assets/ arrives via dynamic import.
const html=await readFile('dist/index.html','utf8')
const referenced=[...html.matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)].map(m=>m[1])
const initial=new Set(referenced.filter(f=>f.endsWith('.js')))
const css=referenced.filter(f=>f.endsWith('.css'))
const rows=[...assets].sort((a,b)=>b[1].gz-a[1].gz)
console.log(`\n  ${'mentah'.padStart(8)}  ${'gzip'.padStart(8)}  chunk`)
for(const [f,s] of rows) console.log(`  ${kib(s.raw)}  ${kib(s.gz)}  ${initial.has(f)?'* ':'  '}${f}`)
console.log('\n  * = dimuat di awal (dirujuk index.html: <script type=module> + <link rel=modulepreload>)')
const total=[...initial].reduce((n,f)=>n+assets.get(f).gz,0)
const cssTotal=css.reduce((n,f)=>n+assets.get(f).gz,0)
const lazy=rows.filter(([f])=>f.endsWith('.js')&&!initial.has(f)).reduce((n,[,s])=>n+s.gz,0)
console.log(`\n  JS awal (gzip)   ${kib(total)}  dari ${initial.size} chunk`)
console.log(`  CSS awal (gzip)  ${kib(cssTotal)}`)
console.log(`  JS lazy (gzip)   ${kib(lazy)}  tidak dihitung terhadap budget`)
const sw=await readFile('dist/sw.js','utf8').catch(()=>'')
if(sw){
 const urls=[...new Set([...sw.matchAll(/url:"([^"]+)"/g)].map(m=>m[1]))]
 let raw=0,gz=0
 for(const u of urls){const b=await readFile(`dist/${u}`).catch(()=>null);if(b){raw+=b.length;gz+=gzipSync(b).length}}
 console.log(`  Precache PWA     ${kib(raw)} mentah / ${kib(gz)} gzip, ${urls.length} berkas unik`)
}else console.log('  Precache PWA     dist/sw.js tidak ada')
const verdict=total>BUDGET?'MELEBIHI BUDGET':total>TARGET?'di atas target 250 KiB, masih dalam batas 300 KiB':'di dalam target'
console.log(`\n  Budget 250-300 KiB → ${kib(total)} : ${verdict}`)
if(total>BUDGET) process.exit(1)
