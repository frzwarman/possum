import type { MenuType } from '../domain/types'
import { menuType } from '../domain/calculate'

// Every row of a CSV that has something in it, cells as written. Indonesian Excel saves CSV with
// semicolons: whichever separator the first line uses more wins.
export function csvRows(input:string):string[][] {
 const text=input.replace(/^﻿/,'');const rows:string[][]=[];let row:string[]=[];let cell='';let quoted=false
 const head=text.slice(0,text.indexOf('\n')<0?text.length:text.indexOf('\n')),sep=head.split(';').length>head.split(',').length?';':','
 for(let i=0;i<text.length;i++){const c=text[i]
  if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++}else quoted=!quoted}
  else if(c===sep&&!quoted){row.push(cell);cell=''}
  else if(c==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));if(row.some(Boolean))rows.push(row);row=[];cell=''}
  else cell+=c}
 if(quoted)throw new Error('Tanda kutip CSV belum ditutup')
 row.push(cell.replace(/\r$/,''));if(row.some(Boolean))rows.push(row)
 return rows
}

const clean=(v:string|undefined)=>(v??'').trim().replace(/\s+/g,' ')
// Numbers as an Indonesian sheet shows them: "Rp25.000" is twenty-five thousand, "1,5" one and a half,
// "6 pcs" six. Empty or text gives undefined.
export function sheetNumber(v:string|undefined){
 const m=clean(v).replace(/^Rp\s*/i,'').match(/^\d{1,3}(?:\.\d{3})+(?:,\d+)?|^\d+(?:[.,]\d+)?/)
 if(!m)return undefined
 return Number(/^\d{1,3}(\.\d{3})+/.test(m[0])?m[0].replace(/\./g,'').replace(',','.'):m[0].replace(',','.'))
}

type Unit='g'|'ml'|'pcs'
const unitWords:[RegExp,Unit][]=[
 [/\b(tea|teh|powder|bubuk|sugar|gula|beans?|blend|coffee|kopi)\b/i,'g'],
 [/\b(cups?|lids?|straws?|box|bags?|holder|fork|spoons?|spork|cutlery|tissue|napkin|filter|rolls?|cans?|bottles?|botol|kaleng|pcs|biji|buah|butir|telur|eggs?|wrap|spray|take away)\b/i,'pcs'],
 [/\b(milk|susu|syrup|sirup|juice|jus|water|air|extract|cream|creamer|whip|madu|honey|tonic|coco|pulp|sauce|saus|oil|minyak|kecap|detergen|sanitizer|dishwash|cleaner|liquid|soda)\b/i,'ml'],
]
// A market list has no unit column. A pack of 1 is counted in pieces; then the item's own name decides, then
// the name-only row above it (a category such as "Flavour Syrup", but just as often an item with no price yet,
// like "Tuna Can", so it only fills in); a small pack (12 bottles, 40 sachets) is pieces, anything else grams.
// It is a guess: the preview lets the owner change it, since a bahan's unit is fixed once saved.
export function guessUnit(name:string,group:string,pack:number):Unit{
 if(pack===1)return 'pcs'
 for(const text of [name,group])for(const [words,unit] of unitWords)if(words.test(text))return unit
 return pack<100?'pcs':'g'
}

// The pack size column: "Unit" on the bar's list, "UOM (gr)" on the kitchen's.
const packSize=/^(unit|uom)\b/i
export interface SheetMenu { name:string; category:string; type:MenuType; price:number; lines:{name:string;qty:number}[] }
export type Sheet={kind:'stock';rows:Record<string,string>[];skipped:number}|{kind:'menu';menus:SheetMenu[];skipped:string[]}

// The owner's own spreadsheet downloaded as CSV (Google Sheets: File → Download → CSV), read as laid out:
// a market list (ITEM DESCRIPTION · Price · Unit · Price / Unit) gives bahan, a COGS tab (Nama Menu ·
// Ingredients · Qty · … · Selling Price) gives menus with their recipes. Any other file: undefined.
export function readSheet(input:string,hint=''):Sheet|undefined{
 const rows=csvRows(input),at=(...heads:RegExp[])=>rows.findIndex(r=>heads.every(h=>r.some(c=>h.test(clean(c)))))
 const cogs=at(/^nama menu$/i,/^ingredients?$/i)
 if(cogs>=0)return readCogs(rows,cogs,hint)
 const list=at(/^item( description)?$/i,packSize)
 return list>=0?readMarketList(rows,list):undefined
}

function readMarketList(rows:string[][],h:number):Sheet{
 const head=rows[h].map(clean),name=head.findIndex(c=>/^item( description)?$/i.test(c)),size=head.findIndex(c=>packSize.test(c))
 const out:Record<string,string>[]=[];let group='',skipped=0
 for(const r of rows.slice(h+1)){
  const n=clean(r[name]),pack=sheetNumber(r[size])
  if(!n)continue
  // No pack size: a category row ("Milk", "Take Away") or an item not priced yet. Neither is imported;
  // a category still hints the unit of the items under it.
  if(!pack){group=n;skipped++;continue}
  out.push({name:n,unit:guessUnit(n,group,pack),quantity:'0',threshold:'0',area:'',pack_name:pack>1?'pak':'',pack_qty:pack>1?String(pack):''})
 }
 return {kind:'stock',rows:out,skipped}
}

function readCogs(rows:string[][],h:number,hint:string):Sheet{
 const head=rows[h].map(clean),col=(re:RegExp)=>head.findIndex(c=>re.test(c))
 const name=col(/^nama menu$/i),ingredient=col(/^ingredients?$/i),qty=col(/^qty$/i),price=col(/selling price|harga jual/i)
 // A drinks tab says so in its title ("Cost of Goods Sold Beverage Menu") or its file name; otherwise the
 // category tells food from snack.
 const drinks=/beverage|minuman|drink/i.test(hint+' '+rows.slice(0,h).flat().join(' '))
 const menus:SheetMenu[]=[],skipped:string[]=[];let group='',menu:SheetMenu|undefined
 for(const r of rows.slice(h)){
  const cell=(i:number)=>i<0?'':clean(r[i])
  // The category sits left of the menu name, on a menu's first row or on the header row above it.
  if(cell(name-1)&&!/^kategori$/i.test(cell(name-1)))group=cell(name-1)
  if(/^nama menu$/i.test(cell(name))){menu=undefined;continue}
  if(cell(name)){
   menu={name:cell(name),category:group,type:drinks?'beverage':menuType({category:group}),price:Math.round(sheetNumber(cell(price))??0),lines:[]}
   if(menu.price>0)menus.push(menu);else skipped.push(menu.name)
  }
  const amount=sheetNumber(cell(qty))
  // "Others" is the sheet's allowance for garnish and waste, not something on a shelf.
  if(menu&&cell(ingredient)&&amount&&!/^others?$/i.test(cell(ingredient)))menu.lines.push({name:cell(ingredient),qty:amount})
 }
 // One name under two categories (a Chocolate drink and a Chocolate milkshake): the later one says which.
 const seen=new Set<string>()
 for(const m of menus){if(seen.has(m.name.toLowerCase())&&m.category)m.name=`${m.name} (${m.category})`;seen.add(m.name.toLowerCase())}
 return {kind:'menu',menus,skipped}
}
