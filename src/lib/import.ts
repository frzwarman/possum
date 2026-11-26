import { z } from 'zod'
import { menuType } from '../domain/calculate'
import { csvRows } from './sheet'
// Excel saves CSV as Windows-1252 unless asked for UTF-8: bytes that are not valid UTF-8 are read that way.
export function decodeCSV(bytes:ArrayBuffer){try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{return new TextDecoder('windows-1252').decode(bytes)}}
// Headers are matched in lowercase, with the Indonesian names an owner may type.
const heads:Record<string,string>={nama:'name',jenis:'type',tipe:'type',harga:'price',satuan:'unit',jumlah:'quantity',batas:'threshold',kemasan:'pack_name',nama_kemasan:'pack_name',isi_kemasan:'pack_qty'}
export function parseCSV(input:string):Record<string,string>[] {
 const rows=csvRows(input)
 const headers=rows.shift()?.map(h=>{const k=h.trim().toLowerCase().replace(/[\s-]+/g,'_');return heads[k]??k});if(!headers)throw new Error('CSV kosong')
 // Excel's used range leaves empty columns at the end.
 while(headers.length&&headers[headers.length-1]==='')headers.pop()
 if(!headers.includes('name'))throw new Error('Kolom name tidak ditemukan. Menu: name, type, price. Bahan: name, unit, quantity, threshold.')
 if(new Set(headers).size!==headers.length)throw new Error('Kolom CSV duplikat')
 if(rows.length>500)throw new Error('Maksimal 500 baris per impor')
 return rows.map((r,i)=>{if(r.length>headers.length&&r.slice(headers.length).every(c=>!c.trim()))r=r.slice(0,headers.length)
  if(r.length!==headers.length)throw new Error(`Baris ${i+2}: jumlah kolom berbeda`)
  // A line break inside a cell (Alt+Enter) must not reach a receipt.
  return Object.fromEntries(headers.map((h,j)=>[h,r[j].replace(/\s+/g,' ').trim()]))})
}
const blank=<T extends z.ZodTypeAny>(inner:T)=>z.preprocess(v=>v===''?undefined:v,inner.optional())
// Price is digits only: "25.000" is how Indonesians write twenty-five thousand, and Number() reads it as 25.
// Takar rows carry a type (food, beverage, snack); an older "category" column is mapped to one.
export const menuImportSchema=z.object({name:z.string().min(1).max(100),category:blank(z.string().max(50)),type:blank(z.enum(['food','beverage','snack'])),price:z.string().regex(/^\d+$/,'Tulis harga tanpa titik atau koma, misalnya 18000').transform(Number).pipe(z.number().int().max(1000000000))})
 .transform(r=>({...r,category:r.category??'',type:menuType({type:r.type,category:r.category??''})}))
// A number in an import file: digits, a dot and exactly three digits are thousands ("1.500" is 1500, as the owner's sheets
// write it); a decimal uses a comma ("1,5"), up to three places. "0.125" is a decimal. Gives the plain number convert() reads.
export function importAmount(v:string){
 const n=/^[1-9]\d{0,2}(\.\d{3})+(,\d{1,3})?$/.test(v)?v.replace(/\./g,'').replace(',','.'):/^\d+([.,]\d{1,3})?$/.test(v)?v.replace(',','.'):undefined
 return n!==undefined&&Number(n)<=1e9?n:undefined
}
const bad='Tulis angka, misalnya 1500, 1.500 atau 1,5 (titik untuk ribuan, koma untuk desimal)'
const amount=z.string().superRefine((v,ctx)=>{if(importAmount(v)===undefined)ctx.addIssue({code:'custom',message:bad})})
const pack=z.string().superRefine((v,ctx)=>{const n=importAmount(v);if(n===undefined||!(Number(n)>0))ctx.addIssue({code:'custom',message:n===undefined?bad:'harus lebih dari 0'})})
export const stockImportSchema=z.object({name:z.string().min(1).max(100),unit:z.enum(['g','ml','pcs']),quantity:amount,threshold:amount,area:blank(z.string().max(50)),pack_name:blank(z.string().max(30)),pack_qty:blank(pack)})
 .transform(r=>({...r,area:r.area??''})).refine(r=>!r.pack_name||Boolean(r.pack_qty),{message:'pack_qty wajib diisi bila pack_name diisi',path:['pack_qty']})
