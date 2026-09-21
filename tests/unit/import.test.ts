import { describe, expect, it } from 'vitest'
import { menuImportSchema, parseCSV, stockImportSchema } from '../../src/lib/import'
import { csv } from '../../src/lib/db'
import { convert } from '../../src/domain/calculate'

const menuRow=(p:Record<string,string>={})=>({name:'Nasi kuning',category:'Makanan',price:'18000',...p})
const stockRow=(p:Record<string,string>={})=>({name:'Beras',unit:'g',quantity:'10.5',threshold:'2',...p})
const bulk=(n:number)=>'name,category,price\n'+Array.from({length:n},(_,i)=>`Item ${i},Makanan,1000`).join('\n')

describe('parseCSV() against what spreadsheets actually emit',()=>{
 it('reads a plain header and rows into trimmed records',()=>{
  expect(parseCSV('name,category,price\nNasi kuning, Makanan ,18000\n')).toEqual([menuRow({category:'Makanan'})])
 })
 it('keeps a comma inside a quoted field',()=>{
  expect(parseCSV('name,category\n"Nasi, goreng",Makanan')).toEqual([{name:'Nasi, goreng',category:'Makanan'}])
 })
 it('unescapes a doubled quote inside a quoted field',()=>{
  expect(parseCSV('name\n"say ""hi"""')).toEqual([{name:'say "hi"'}])
 })
 it('accepts CRLF line endings — Excel emits these',()=>{
  expect(parseCSV('name,category\r\nNasi,Makanan\r\n')).toEqual([{name:'Nasi',category:'Makanan'}])
 })
 it('strips a leading UTF-8 BOM so the first header key is usable',()=>{
  expect(Object.keys(parseCSV('﻿name,category\nNasi,Makanan')[0])).toEqual(['name','category'])
 })
 it('ignores trailing blank lines',()=>{
  expect(parseCSV('name,category\nNasi,Makanan\n\n\r\n\n')).toHaveLength(1)
 })
 it('rejects duplicate header names — a silently dropped column loses data',()=>{
  expect(()=>parseCSV('name,name\nNasi,Makanan')).toThrow('Kolom CSV duplikat')
 })
 it('rejects a ragged row and names the spreadsheet line number',()=>{
  expect(()=>parseCSV('name,category,price\nNasi,Makanan')).toThrow('Baris 2: jumlah kolom berbeda')
  expect(()=>parseCSV('name,category,price\nNasi,Makanan,1000\nMie,Makanan')).toThrow('Baris 3: jumlah kolom berbeda')
 })
 it('rejects an unterminated quote instead of guessing where the field ends',()=>{
  expect(()=>parseCSV('name\n"belum ditutup\n')).toThrow('Tanda kutip CSV belum ditutup')
 })
 it('rejects an empty file',()=>{
  expect(()=>parseCSV('')).toThrow('CSV kosong')
  expect(()=>parseCSV('\n\n')).toThrow('CSV kosong')
 })
 it('caps the import at 500 data rows',()=>{
  expect(parseCSV(bulk(500))).toHaveLength(500)
  expect(()=>parseCSV(bulk(501))).toThrow('Maksimal 500 baris per impor')
 })
 it('reads a BOM file that also uses quoted fields — this is every file csv() writes',()=>{
  expect(parseCSV('﻿name,category\n"Nasi, goreng",Makanan')).toEqual([{name:'Nasi, goreng',category:'Makanan'}])
 })
})

describe('menuImportSchema',()=>{
 it('coerces the price column to an integer rupiah value',()=>{
  const parsed=menuImportSchema.parse(menuRow())
  expect(parsed).toEqual({name:'Nasi kuning',category:'Makanan',price:18_000})
  expect(Number.isInteger(parsed.price)).toBe(true)
 })
 it('rejects a negative price',()=>{
  expect(menuImportSchema.safeParse(menuRow({price:'-1'})).error?.issues[0].path).toEqual(['price'])
 })
 it('rejects a fractional price — rupiah has no cents',()=>{
  expect(menuImportSchema.safeParse(menuRow({price:'18500.5'})).success).toBe(false)
 })
 it('rejects a non-numeric price rather than importing NaN',()=>{
  expect(menuImportSchema.safeParse(menuRow({price:'delapan belas ribu'})).success).toBe(false)
 })
 it('rejects a price above the money ceiling',()=>{
  expect(menuImportSchema.safeParse(menuRow({price:'1000000001'})).success).toBe(false)
  expect(menuImportSchema.safeParse(menuRow({price:'1000000000'})).success).toBe(true)
 })
 it('rejects a missing required column and an empty name or category',()=>{
  const {price:_,...noPrice}=menuRow();void _
  expect(menuImportSchema.safeParse(noPrice).success).toBe(false)
  expect(menuImportSchema.safeParse(menuRow({name:''})).success).toBe(false)
  expect(menuImportSchema.safeParse(menuRow({category:''})).success).toBe(false)
 })
 it('rejects names and categories past the column limits',()=>{
  expect(menuImportSchema.safeParse(menuRow({name:'a'.repeat(101)})).success).toBe(false)
  expect(menuImportSchema.safeParse(menuRow({category:'a'.repeat(51)})).success).toBe(false)
 })
})

describe('stockImportSchema',()=>{
 it('keeps quantities as decimal strings that convert() scales to thousandths',()=>{
  const parsed=stockImportSchema.parse(stockRow())
  expect(parsed).toEqual({name:'Beras',unit:'g',quantity:'10.5',threshold:'2'})
  expect(convert(parsed.quantity,parsed.unit,parsed.unit)).toBe(10_500) // 1 g = 1_000
 })
 it('rejects a unit outside the base units — kg must be entered as g',()=>{
  expect(stockImportSchema.safeParse(stockRow({unit:'kg'})).error?.issues[0].path).toEqual(['unit'])
  for(const unit of ['g','ml','pcs'])expect(stockImportSchema.safeParse(stockRow({unit})).success).toBe(true)
 })
 it('rejects negative, non-numeric and over-precise quantities',()=>{
  for(const quantity of ['-1','','1.2345','1e3','10,5'])expect(stockImportSchema.safeParse(stockRow({quantity})).success).toBe(false)
  expect(stockImportSchema.safeParse(stockRow({quantity:'0'})).success).toBe(true) // an opening balance of zero is legitimate
 })
 it('applies the same rule to the threshold column',()=>{
  expect(stockImportSchema.safeParse(stockRow({threshold:'-2'})).success).toBe(false)
 })
 it('rejects a missing required column',()=>{
  const {threshold:_,...noThreshold}=stockRow();void _
  expect(stockImportSchema.safeParse(noThreshold).success).toBe(false)
 })
})

describe('csv()',()=>{
 it('leads with a BOM so Excel reads UTF-8 instead of mojibake',()=>{
  expect(csv([['name']]).startsWith('﻿')).toBe(true)
 })
 it('quotes every field and separates rows with CRLF',()=>{
  expect(csv([['name','price'],['Nasi',18000]])).toBe('﻿"name","price"\r\n"Nasi","18000"')
 })
 it('escapes embedded quotes by doubling them and leaves commas inside the quotes',()=>{
  expect(csv([['Nasi, goreng','say "hi"']])).toBe('﻿"Nasi, goreng","say ""hi"""')
 })
 it('defuses =, +, @ and - so a spreadsheet cannot execute an exported value as a formula',()=>{
  for(const payload of ['=1+1','+1','@SUM(A1)','-2+3'])
   expect(csv([[payload]])).toBe(`﻿"'${payload}"`)
  expect(csv([['=HYPERLINK("http://jahat","klik")']])).toBe('﻿"\'=HYPERLINK(""http://jahat"",""klik"")"')
 })
 it('leaves an ordinary value untouched',()=>{
  expect(csv([['Nasi goreng']])).toBe('﻿"Nasi goreng"')
 })
 it('round-trips through parseCSV — an export must be re-importable',()=>{
  expect(parseCSV(csv([['name','category','price'],['Nasi, goreng','Makanan',18000]]))).toEqual([{name:'Nasi, goreng',category:'Makanan',price:'18000'}])
 })
})
