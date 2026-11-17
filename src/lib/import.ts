import { z } from 'zod'
import { menuType } from '../domain/calculate'
import { csvRows } from './sheet'
export function parseCSV(input:string):Record<string,string>[] {
 const rows=csvRows(input)
 const headers=rows.shift();if(!headers)throw new Error('CSV kosong')
 if(new Set(headers).size!==headers.length)throw new Error('Kolom CSV duplikat')
 if(rows.length>500)throw new Error('Maksimal 500 baris per impor')
 return rows.map((r,i)=>{if(r.length!==headers.length)throw new Error(`Baris ${i+2}: jumlah kolom berbeda`);return Object.fromEntries(headers.map((h,j)=>[h.trim(),r[j].trim()]))})
}
const blank=<T extends z.ZodTypeAny>(inner:T)=>z.preprocess(v=>v===''?undefined:v,inner.optional())
// Price is digits only: "25.000" is how Indonesians write twenty-five thousand, and Number() reads it as 25.
// Takar rows carry a type (food, beverage, snack); an older "category" column is mapped to one.
export const menuImportSchema=z.object({name:z.string().min(1).max(100),category:blank(z.string().max(50)),type:blank(z.enum(['food','beverage','snack'])),price:z.string().regex(/^\d+$/,'Tulis harga tanpa titik atau koma, misalnya 18000').transform(Number).pipe(z.number().int().max(1000000000))})
 .transform(r=>({...r,category:r.category??'',type:menuType({type:r.type,category:r.category??''})}))
const amount=/^\d+([.,]\d{1,3})?$/
export const stockImportSchema=z.object({name:z.string().min(1).max(100),unit:z.enum(['g','ml','pcs']),quantity:z.string().regex(amount),threshold:z.string().regex(amount),area:blank(z.string().max(50)),pack_name:blank(z.string().max(30)),pack_qty:blank(z.string().regex(amount))})
 .transform(r=>({...r,area:r.area??''})).refine(r=>!r.pack_name||Boolean(r.pack_qty),{message:'pack_qty wajib diisi bila pack_name diisi',path:['pack_qty']})
