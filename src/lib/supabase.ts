import { createClient } from '@supabase/supabase-js'
const url=import.meta.env.VITE_SUPABASE_URL
const key=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
export const configured=Boolean(url&&key&&!url.includes('YOUR_PROJECT')&&!key.includes('YOUR_'))
// The Telegram bot's username; empty hides every Telegram button (demo, or a project without the bot).
export const telegramBot:string=configured?import.meta.env.VITE_TELEGRAM_BOT||'':''
// SYNC-06: a request that never answers must not hold the sync lock (and with it the queue) for ever. It is aborted after
// REQUEST_MS, together with any signal the caller passed; the operation stays queued and is sent again (it has an id).
export const REQUEST_MS=30000
export const withTimeout=(input:RequestInfo|URL,init?:RequestInit)=>{
 const c=new AbortController(),t=setTimeout(()=>c.abort(new DOMException('Server tidak menjawab','TimeoutError')),REQUEST_MS),s=init?.signal
 if(s){if(s.aborted)c.abort(s.reason);else s.addEventListener('abort',()=>c.abort(s.reason),{once:true})}
 // The timer is left to fire after the headers came: it also ends a body that stalls, and does nothing once it is read.
 return fetch(input,{...init,signal:c.signal}).catch(e=>{clearTimeout(t);throw e})
}
export const supabase=configured?createClient(url,key,{global:{fetch:withTimeout},auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}}):null
