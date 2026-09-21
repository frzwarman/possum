import type { Identity,Operation } from '../domain/types'
import type { MejaDB } from './db'
import { supabase } from './supabase'
export type Transport=(op:Operation)=>Promise<{receivedAt:string}>
export const serverTransport:Transport=async op=>{if(!supabase)throw new Error('Supabase belum dikonfigurasi');const {data,error}=await supabase.rpc('apply_operation',{operation:op});if(error){const e=new Error(error.message);e.name=['P0001','23514','42501','23503','23505','22P02'].includes(error.code)?'Rejected':'Network';throw e}return {receivedAt:data.receivedAt}}
export async function synchronize(db:MejaDB,user:Identity,transport:Transport=serverTransport){
 if(user.demo)return
 if(!navigator.locks)throw new Error('Browser perlu mendukung Web Locks untuk kasir utama')
 return navigator.locks.request(`meja-sync-${user.restaurantId}-${user.deviceId}`,{ifAvailable:true},async lock=>{
 if(!lock)return
 const ops=(await db.outbox.where('state').equals('pending').sortBy('occurredAt')).slice(0,25)
 for(const op of ops){if(op.actor!==user.id)throw new Error('Operasi milik akun lain dikunci');if(op.nextAttempt>Date.now())break
 // Never skip a rejected dependency or reorder later operations.
 if(await db.outbox.where('state').equals('rejected').count())break
 try{const receipt=await transport(op);await db.transaction('rw',db.outbox,db.meta,async()=>{await db.outbox.update(op.id,{state:'synced',receivedAt:receipt.receivedAt,error:undefined});await db.meta.put({id:'lastSync',value:receipt.receivedAt})})}
 catch(error){const e=error instanceof Error?error:new Error(String(error));const attempts=op.attempts+1;await db.outbox.update(op.id,{attempts,state:e.name==='Rejected'?'rejected':'pending',error:e.message,nextAttempt:Date.now()+Math.min(300000,1000*2**Math.min(attempts,8))*(0.75+Math.random()*0.5)});break}
 }
 })
}
