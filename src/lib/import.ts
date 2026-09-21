import { z } from 'zod'
export function parseCSV(input:string):Record<string,string>[] {
 const text=input.replace(/^\uFEFF/,'');const rows:string[][]=[];let row:string[]=[];let cell='';let quoted=false
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++}else quoted=!quoted}else if(c===','&&!quoted){row.push(cell);cell=''}else if(c==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));if(row.some(Boolean))rows.push(row);row=[];cell=''}else cell+=c}
 if(quoted)throw new Error('Tanda kutip CSV belum ditutup');row.push(cell.replace(/\r$/,''));if(row.some(Boolean))rows.push(row);const headers=rows.shift();if(!headers)throw new Error('CSV kosong');if(new Set(headers).size!==headers.length)throw new Error('Kolom CSV duplikat');if(rows.length>500)throw new Error('Maksimal 500 baris per impor');return rows.map((r,i)=>{if(r.length!==headers.length)throw new Error(`Baris ${i+2}: jumlah kolom berbeda`);return Object.fromEntries(headers.map((h,j)=>[h.trim(),r[j].trim()]))})
}
export const menuImportSchema=z.object({name:z.string().min(1).max(100),category:z.string().min(1).max(50),price:z.coerce.number().int().min(0).max(1000000000)})
export const stockImportSchema=z.object({name:z.string().min(1).max(100),unit:z.enum(['g','ml','pcs']),quantity:z.string().regex(/^\d+(\.\d{1,3})?$/),threshold:z.string().regex(/^\d+(\.\d{1,3})?$/)})
