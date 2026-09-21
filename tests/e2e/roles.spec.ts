import { test,expect } from './meja'
import { demo } from './meja'
// Penyimpanan perangkat terbuka untuk semua peran (persistensi penyimpanan penting di kasir);
// hanya bagian pemindahan kasir utama yang khusus pemilik.
const identity=(role:string)=>JSON.stringify({id:'demo-user',name:'Demo',role,restaurantId:'local-demo',deviceId:'11111111-1111-1111-1111-111111111111',primary:false,demo:true})
test('owner sees the device panel and can move the till device', async({page})=>{
 await demo(page)
 await page.getByRole('link',{name:'Lainnya'}).click()
 await page.getByRole('button',{name:'Printer & perangkat'}).click()
 await expect(page.getByRole('heading',{name:'Penyimpanan perangkat'})).toBeVisible()
 await expect(page.getByText(/Pemilik dapat memindahkan kasir utama/)).toBeVisible()
})
for(const role of ['manager','cashier'])
 test(`${role} sees storage but cannot move the till device`, async({page})=>{
  await page.addInitScript(value=>localStorage.setItem('meja-identity',value as string),identity(role))
  await page.goto('/settings')
  await page.getByRole('button',{name:'Printer & perangkat'}).click()
  await expect(page.getByRole('heading',{name:'Penyimpanan perangkat'})).toBeVisible()
  await expect(page.getByRole('button',{name:/Minta penyimpanan persisten/})).toBeVisible()
  await expect(page.getByRole('button',{name:/kasir utama/})).toHaveCount(0)
  await expect(page.getByText(/ditentukan pemilik restoran/)).toBeVisible()
 })
