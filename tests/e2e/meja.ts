import { test as base,expect,type Page } from '@playwright/test'
// window.print must never open a real dialog in CI; count the calls instead.
export const test=base.extend({page:async({page},use)=>{await page.addInitScript(()=>{Object.assign(window,{__prints:0});window.print=()=>{(window as unknown as {__prints:number}).__prints++}});await use(page)}})
export { expect }
export const prints=(page:Page)=>page.evaluate(()=>(window as unknown as {__prints:number}).__prints)
export async function demo(page:Page){
 await page.goto('/')
 await page.getByRole('button',{name:'Jelajahi demo lokal'}).click()
 await expect(page.getByRole('heading',{name:'Kasir',level:1})).toBeVisible()
 await expect(page.getByRole('button',{name:/Nasi goreng kampung/})).toBeVisible()
}
export async function openShift(page:Page,opening='200000'){
 await page.getByRole('button',{name:/Buka sif untuk melayani/}).click()
 await page.getByLabel(/Modal kas awal/).fill(opening)
 await page.getByRole('button',{name:'Buka sif sekarang'}).click()
 await expect(page.getByText('Sif terbuka',{exact:true})).toBeVisible()
}
export async function addItem(page:Page,name:string,{eggs=false,note=''}={}){
 await page.getByRole('button',{name:new RegExp(name)}).first().click()
 const dialog=page.getByRole('dialog')
 // An item with no add-ons skips the dialog and lands in the cart on one tap.
 if(!await dialog.waitFor({state:'visible',timeout:1500}).then(()=>true,()=>false))return
 if(eggs)await dialog.getByRole('checkbox',{name:/Tambah telur/}).check()
 // The prep note opens from the dialog footer (Figma C3 has no note field).
 if(note){await dialog.getByRole('button',{name:'Tambah catatan'}).click();await dialog.getByLabel(/Catatan persiapan/).fill(note)}
 await dialog.getByRole('button',{name:/Tambah ke pesanan/}).click()
 await expect(dialog).toBeHidden()
}
export const cart=(page:Page)=>page.locator('.desktop-cart')
// Full cash sale on an already-open shift; leaves the receipt dialog on screen.
export async function sell(page:Page,{tendered}:{tendered?:string}={}){
 await cart(page).getByRole('button',{name:/Ke stasiun/}).click()
 await expect(cart(page).getByText(/Dikirim/)).toBeVisible()
 await cart(page).getByRole('button',{name:/^Bayar Rp/}).click()
 const pay=page.getByRole('dialog',{name:'Terima pembayaran'})
 if(tendered)await pay.getByLabel(/Uang diterima/).fill(tendered)
 await pay.getByRole('button',{name:/Catat pembayaran/}).click()
 await expect(page.getByRole('dialog',{name:'Pembayaran tercatat'})).toBeVisible()
}
// Sidebar navigation; only rendered above 700px, so mobile specs must not use it.
// 'Stok' also matches 'Hitung stok' and 'Kasir' carries a shortcut badge: take the first link whose text starts with the label.
// On the till the rail holds only Sif, Kasir, Pesanan and Stok: Produksi and Hitung stok open from the Stok page.
export async function go(page:Page,label:string){
 const name=new RegExp('^'+label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),link=page.locator('.sidebar').getByRole('link',{name}).first()
 if(await link.waitFor({timeout:3000}).then(()=>true,()=>false)){await link.click();return}
 await page.locator('.sidebar').getByRole('link',{name:/^Stok/}).first().click()
 await page.locator('main').getByRole('link',{name}).first().click()
}
export const drawer=(page:Page)=>page.locator('.panel').filter({hasText:'Laci kas'}).locator('.bill-total')
export const balance=(page:Page,name:string)=>page.locator('.stock-row').filter({hasText:name}).locator('.stock-quantity strong')

// A manual discount from the cart's discount button (Figma Cashier 2, Manual tab): a rupiah amount with a reason of
// its own. A cashier's ends at the manager's PIN; an owner or manager applies it directly.
export async function manualDiscount(page:Page,amount:string,reason:string){
 await cart(page).getByRole('button',{name:'Diskon',exact:true}).click()
 const dialog=page.getByRole('dialog',{name:'Diskon'})
 await dialog.getByRole('button',{name:'Manual'}).click()
 await dialog.getByRole('button',{name:/^Rupiah/}).click()
 await dialog.getByLabel('Potongan').fill(amount)
 await dialog.getByRole('button',{name:'Lainnya'}).click()
 await dialog.getByLabel('Alasan lain').fill(reason)
 await dialog.getByRole('button',{name:/^(Terapkan diskon|Minta persetujuan manajer)$/}).click()
}
