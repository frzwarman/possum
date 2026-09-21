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
 await expect(page.getByText('Sif terbuka')).toBeVisible()
}
export async function addItem(page:Page,name:string,{eggs=false,note=''}={}){
 await page.getByRole('button',{name:new RegExp(name)}).first().click()
 const dialog=page.getByRole('dialog')
 if(eggs)await dialog.getByRole('checkbox',{name:/Tambah telur/}).check()
 if(note)await dialog.getByLabel(/Catatan persiapan/).fill(note)
 await dialog.getByRole('button',{name:/Tambah ke pesanan/}).click()
 await expect(dialog).toBeHidden()
}
export const cart=(page:Page)=>page.locator('.desktop-cart')
// Full cash sale on an already-open shift; leaves the receipt dialog on screen.
export async function sell(page:Page,{tendered}:{tendered?:string}={}){
 await cart(page).getByRole('button',{name:/Ke dapur/}).click()
 await expect(cart(page).getByText(/Dikirim ke dapur/)).toBeVisible()
 await cart(page).getByRole('button',{name:/Lanjut pembayaran/}).click()
 const pay=page.getByRole('dialog',{name:'Terima pembayaran'})
 if(tendered)await pay.getByLabel(/Uang diterima/).fill(tendered)
 await pay.getByRole('button',{name:/Catat pembayaran/}).click()
 await expect(page.getByRole('dialog',{name:'Pembayaran tercatat'})).toBeVisible()
}
