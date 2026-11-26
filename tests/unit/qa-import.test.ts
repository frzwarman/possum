import { describe, expect, it } from 'vitest'
import { decodeCSV, importAmount, parseCSV, stockImportSchema } from '../../src/lib/import'
import { csvRows, sheetNumber } from '../../src/lib/sheet'
import { convert, menuType } from '../../src/domain/calculate'

const stock=(p:Record<string,string>={})=>({name:'Beras',unit:'g',quantity:'0',threshold:'0',...p})

describe('QA import F3: thousands dot in a bahan file',()=>{
 it('reads digits, a dot and three digits as thousands; a comma is the decimal',()=>{
  expect(importAmount('1.500')).toBe('1500')
  expect(importAmount('25.000')).toBe('25000')
  expect(importAmount('1.250.000,5')).toBe('1250000.5')
  expect(importAmount('1,5')).toBe('1.5')
  expect(importAmount('1500')).toBe('1500')
  expect(convert(importAmount('1.500')!,'g','g')).toBe(1_500_000)
 })
 it('F18: 0.125 is a decimal, not thousands',()=>{
  expect(importAmount('0.125')).toBe('0.125')
  expect(sheetNumber('0.125')).toBe(0.125)
  expect(sheetNumber('1.250')).toBe(1250)
  expect(sheetNumber('Rp25.000')).toBe(25000)
  expect(sheetNumber('1.5')).toBe(1.5)
 })
 it('refuses what is neither',()=>{
  for(const v of ['1.2345','1e3','10,5,0','-1','','1.500.5','2000000000'])expect(importAmount(v),v).toBeUndefined()
  expect(stockImportSchema.safeParse(stock({quantity:'1.500'})).success).toBe(true)
 })
})

describe('QA import F15: pack_qty must be above 0',()=>{
 it('names the column and the rule',()=>{
  const r=stockImportSchema.safeParse(stock({pack_name:'karung',pack_qty:'0'}))
  expect(r.success).toBe(false)
  expect(r.error?.issues.map(i=>i.path.join('.')+' '+i.message)).toEqual(['pack_qty harus lebih dari 0'])
  expect(stockImportSchema.safeParse(stock({pack_name:'karung',pack_qty:'25.000'})).success).toBe(true)
 })
})

describe('QA import F12-F14: what Excel really writes',()=>{
 it('F12: falls back to Windows-1252 when the bytes are not UTF-8',()=>{
  const w=new Uint8Array([...'Caf'].map(c=>c.charCodeAt(0)).concat([0xe9]))
  expect(decodeCSV(w.buffer)).toBe('Café')
  expect(decodeCSV(new TextEncoder().encode('Café').buffer as ArrayBuffer)).toBe('Café')
 })
 it('F13: header case and Indonesian names',()=>{
  expect(parseCSV('Name,Type,Price\nA,food,1')).toEqual([{name:'A',type:'food',price:'1'}])
  expect(parseCSV('Nama;Jenis;Harga\nA;food;1')).toEqual([{name:'A',type:'food',price:'1'}])
  expect(()=>parseCSV('foo,bar\n1,2')).toThrow('Kolom name tidak ditemukan')
 })
 it('F14: trailing empty columns, CR-only lines, a line break inside a name',()=>{
  expect(parseCSV('name,type,price,,\nA,food,1,,\nB,food,2,,')).toHaveLength(2)
  expect(csvRows('name,price\rA,1\rB,2')).toEqual([['name','price'],['A','1'],['B','2']])
  expect(parseCSV('name,price\r\n"Nasi Goreng\r\nSpesial",1')[0].name).toBe('Nasi Goreng Spesial')
  expect(()=>parseCSV('name,price\nA,1,x')).toThrow('Baris 2: jumlah kolom berbeda')
 })
})

describe('QA import F17: menu type keywords are whole words',()=>{
 it('STEAK is food; real drink categories still are drinks',()=>{
  expect(menuType({category:'STEAK'})).toBe('food')
  expect(menuType({category:'STEAK & GRILL'})).toBe('food')
  for(const c of ['Minuman','Drinks','Non-Coffee','Es Teh','Kopi','Juice','Jus Buah'])expect(menuType({category:c}),c).toBe('beverage')
 })
})
