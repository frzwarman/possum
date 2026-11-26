// Signing in on a shared device: what a failed sign-in really was, and the pause after three wrong PINs.
// A failed sign-in says what happened, in Indonesian (AUTH-11). supabase-js names a request that got no answer (or a
// 502-504) AuthRetryableFetchError, and PostgREST leaves `code` empty for one. The error's name tells the caller what it
// was: 'Network' = nothing was checked; 'Wrong' = the server refused the PIN or password itself (`wrong` is what the
// screen says then), and only that one counts as a wrong try.
export const UNREACHABLE='Server tidak terjangkau. Periksa internet, lalu coba lagi.'
export function signInError(e:{name?:string;status?:number;code?:string;message?:string},wrong:string){
 const as=(message:string,name='Error')=>{const x=new Error(message);x.name=name;return x}
 if(e.name==='AuthRetryableFetchError'||e.code==='')return as(UNREACHABLE,'Network')
 if(e.code==='invalid_credentials'||e.message==='Invalid login credentials')return as(wrong,'Wrong')
 if(e.status===429)return as('Terlalu banyak percobaan masuk. Tunggu beberapa menit, lalu coba lagi.')
 if(e.code==='user_banned'||/No active staff membership/.test(e.message??''))return as('Akun ini tidak aktif. Hubungi pemilik restoran.')
 return as(`Masuk gagal: ${e.message||'coba lagi'}`)
}
// CTL-4: three wrong PINs in a row for one person pause that person on this device for five minutes, at sign-in and at
// the idle lock, across reloads ('takar-pin-tries' keeps the count and the time of the last wrong one; a wrong try more
// than five minutes after the one before starts the count again). A brake for the shared tablet only: the server has
// no limit per account.
const PAUSE=300000
const tries=():Record<string,{n:number;at:number}>=>{try{return JSON.parse(localStorage.getItem('takar-pin-tries')||'{}')||{}}catch{return {}}}
// Milliseconds this person still waits; 0 = may try.
export const pinPause=(who:string)=>{const t=tries()[who];return t&&t.n>=3?Math.max(0,t.at+PAUSE-Date.now())||0:0}
export function pinTried(who:string,ok:boolean){const all=tries(),t=all[who];if(ok)delete all[who];else all[who]={n:(t&&Date.now()-t.at<PAUSE?t.n:0)+1,at:Date.now()};try{localStorage.setItem('takar-pin-tries',JSON.stringify(all))}catch{/* private mode */}}
export const pauseNote=(ms:number)=>`Terlalu banyak PIN salah. Coba lagi dalam ${Math.ceil(ms/60000)} menit.`
