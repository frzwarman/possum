import { test,expect } from './meja'
import { demo } from './meja'
// iPhone 14 Pro. Dua kolom tanggal pernah berdempetan dengan ikon kalendernya di lebar ini.
test.use({viewport:{width:393,height:852}})
test('date filters stack on a phone and nothing overflows sideways', async({page})=>{
 await demo(page)
 await page.getByRole('link',{name:'Laporan'}).click()
 await page.getByRole('heading',{name:/Laporan & kas/}).waitFor()
 const from=(await page.getByLabel(/Dari tanggal/).boundingBox())!
 const to=(await page.getByLabel(/Sampai tanggal/).boundingBox())!
 expect(from.y+from.height).toBeLessThanOrEqual(to.y+1)
 expect(from.width).toBeGreaterThan(300)
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(393)
})
