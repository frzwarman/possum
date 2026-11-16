import { test,expect } from './meja'
import { demo } from './meja'
// iPhone 14 Pro. Dua kolom tanggal pernah berdempetan dengan ikon kalendernya di lebar ini.
test.use({viewport:{width:393,height:852}})
test('date filters stack on a phone and nothing overflows sideways', async({page})=>{
 await demo(page)
 // A phone bar holds five items; the owner's other pages sit in the Menu sheet.
 await page.locator('.bottom-nav').getByRole('button',{name:'Menu'}).click()
 await page.getByRole('dialog',{name:'Menu'}).getByRole('link',{name:'Laporan'}).click()
 await page.getByRole('heading',{name:'Laporan',exact:true}).waitFor()
 // The dates show once the period is "Rentang lain" (Figma M4: a period select in the heading).
 await page.getByRole('combobox',{name:'Periode'}).click()
 await page.getByRole('option',{name:'Rentang lain'}).click()
 const from=(await page.getByLabel(/Dari tanggal/).boundingBox())!
 const to=(await page.getByLabel(/Sampai tanggal/).boundingBox())!
 expect(from.y+from.height).toBeLessThanOrEqual(to.y+1)
 expect(from.width).toBeGreaterThan(300)
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(393)
})
