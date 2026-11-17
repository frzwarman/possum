import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { guessUnit, readSheet, sheetNumber } from '../../src/lib/sheet'
import { menuImportSchema, stockImportSchema } from '../../src/lib/import'

// Cut-down copies of Ziggy's own tabs, laid out as Google Sheets downloads them (File → Download → CSV).
const sample = (name: string) => readFileSync(`docs/samples/sheet-import/${name}`, 'utf8')

describe('sheetNumber() reads numbers the way an Indonesian sheet shows them', () => {
 it('takes dots as thousands and a comma as the decimal mark', () => {
  expect(['Rp25.000', 'Rp1.420.000', '1000', '1,5', '0,3', '1.000,5'].map(sheetNumber)).toEqual([25000, 1420000, 1000, 1.5, 0.3, 1000.5])
 })
 it('reads the number in front of a unit, a lone decimal dot, and gives nothing for text', () => {
  expect(['6pcs', '6 pcs', '1.5', '', '-', 'Qty'].map(sheetNumber)).toEqual([6, 6, 1.5, undefined, undefined, undefined])
 })
})

describe('readSheet() on a market list', () => {
 const sheet = readSheet(sample('market-list-bar.csv'))
 const rows = sheet?.kind === 'stock' ? sheet.rows : []
 it('makes one bahan per priced row; category rows and unpriced items are left out', () => {
  expect(sheet?.kind).toBe('stock')
  expect(rows.map((r) => r.name)).toEqual(['Fresh Milk Diary 1L', 'Oat Milk 1L', 'SKM', 'Palm Sugar', 'Custome Blend Selective', 'Chocolate', 'Pain Au Chocolate', 'Hot Cup', 'HydroCoco', 'Lychee Can'])
  expect(sheet?.kind === 'stock' && sheet.skipped).toBe(8)
 })
 it('guesses each unit from the category row above and the name; a pack of one is pieces', () => {
  expect(Object.fromEntries(rows.map((r) => [r.name, r.unit]))).toMatchObject({ 'Fresh Milk Diary 1L': 'ml', SKM: 'ml', 'Palm Sugar': 'g', 'Custome Blend Selective': 'g', Chocolate: 'g', 'Pain Au Chocolate': 'pcs', 'Hot Cup': 'pcs', 'Lychee Can': 'pcs' })
  // The name comes first: the row above may be an unpriced item ("Tuna Can") rather than a category.
  expect(guessUnit('Oyster Sauce Saori', 'Tuna Can', 1000)).toBe('ml')
  expect(guessUnit('Earl Grey', 'Artisan Tea', 40)).toBe('g')
 })
 it("reads the kitchen's list too, where the pack size column is \"UOM (gr)\"", () => {
  const kitchen = readSheet('MARKET LIST KITCHEN,,,,\n,ITEM DESCRIPTION,Price,UOM (gr),Price / Gr\n,Vegetables,,,\n,Garlic,Rp40.000,1000,Rp40\n,Eggs,Rp30.000,16,Rp1.875')
  expect(kitchen?.kind === 'stock' && kitchen.rows.map((r) => [r.name, r.unit, r.pack_qty])).toEqual([['Garlic', 'g', '1000'], ['Eggs', 'pcs', '16']])
 })
 it('keeps the pack size as a "pak", and every row passes the bahan template check', () => {
  expect(rows.find((r) => r.name === 'Hot Cup')).toMatchObject({ pack_name: 'pak', pack_qty: '2000', quantity: '0' })
  expect(rows.find((r) => r.name === 'Pain Au Chocolate')).toMatchObject({ pack_name: '', pack_qty: '' })
  expect(rows.every((r) => stockImportSchema.safeParse(r).success)).toBe(true)
 })
})

describe('readSheet() on a COGS tab', () => {
 it('makes drinks with their recipes; "Others" is not an ingredient and a menu with no price is skipped', () => {
  const sheet = readSheet(sample('cogs-beverage.csv'))
  expect(sheet?.kind).toBe('menu')
  if (sheet?.kind !== 'menu') return
  expect(sheet.menus.map((m) => [m.name, m.category, m.type, m.price])).toEqual([
   ['Americano', 'COFFEE', 'beverage', 30000],
   ['Vegan Latte', 'COFFEE', 'beverage', 40000],
   ['Chocolate', 'NON COFFEE', 'beverage', 35000],
   ['Chocolate (Milkshake)', 'Milkshake', 'beverage', 40000],
  ])
  expect(sheet.menus[0].lines).toEqual([{ name: 'Espresso Blend', qty: 40 }])
  expect(sheet.menus[3].lines).toEqual([{ name: 'Chocolate Powder', qty: 30 }, { name: 'Milk', qty: 112.5 }, { name: 'Steam Milk', qty: 20 }])
  expect(sheet.skipped).toEqual(['Cold Brew Bottle'])
  expect(sheet.menus.every((m) => menuImportSchema.safeParse({ ...m, price: String(m.price) }).success)).toBe(true)
 })
 it('takes the category from the header row and tells food from snack when the tab is not about drinks', () => {
  const sheet = readSheet(sample('cogs-food.csv'), 'COGS Ziggy Lounge - COGS FOOD.csv')
  if (sheet?.kind !== 'menu') throw new Error('not a COGS sheet')
  expect(sheet.menus.map((m) => [m.name, m.category, m.type, m.price, m.lines])).toEqual([
   ['Carbonara', 'PASTA', 'food', 58000, [{ name: 'Spaghetti', qty: 80 }, { name: 'parsley dry', qty: 0.3 }]],
   ['French Fries', 'SAVORY SNACK', 'snack', 30000, [{ name: 'Kentang beku', qty: 150 }, { name: 'Saus sambal', qty: 6 }]],
  ])
 })
 it('leaves a template CSV to the template reader', () => {
  expect(readSheet('name,unit,quantity,threshold\nBeras,g,1,1')).toBeUndefined()
  expect(readSheet('name,type,price\nNasi kuning,food,18000')).toBeUndefined()
 })
})
