import { createClient } from '@supabase/supabase-js'
const url=import.meta.env.VITE_SUPABASE_URL
const key=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
export const configured=Boolean(url&&key&&!url.includes('YOUR_PROJECT')&&!key.includes('YOUR_'))
// The Telegram bot's username; empty hides every Telegram button (demo, or a project without the bot).
export const telegramBot:string=configured?import.meta.env.VITE_TELEGRAM_BOT||'':''
export const supabase=configured?createClient(url,key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}}):null
