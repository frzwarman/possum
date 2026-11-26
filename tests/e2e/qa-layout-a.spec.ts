import { test,expect,demo,openShift,addItem } from './meja'
import type { Page } from '@playwright/test'
// QA layout-a. LF-1/SYNC-11: the update prompt is a strip above the page, never over a control, and can be put off.
const updateWaiting=(page:Page)=>page.route(/virtual:pwa-register\/react/,r=>r.fulfill({status:200,contentType:'text/javascript',body:'export function useRegisterSW(){return {needRefresh:[true,()=>{}],offlineReady:[false,()=>{}],updateServiceWorker:async()=>{window.__reloaded=true}}}'}))
const covered=(page:Page,sel:string)=>page.locator(sel).first().evaluate(el=>{const b=el.getBoundingClientRect();const hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return hit?.closest('.update-prompt')?'prompt':hit&&el.contains(hit)?'ok':'other:'+hit?.className})
for(const [w,h,touch] of [[1280,800,true],[800,1280,true],[393,852,true],[1440,900,false]] as const)
 test(`LF-1: the update prompt leaves the till reachable at ${w}x${h}`,async({page})=>{
  await page.setViewportSize({width:1280,height:800})
  await updateWaiting(page);await demo(page);await openShift(page);await addItem(page,'Es teh')
  await page.setViewportSize({width:w,height:h})
  await expect(page.locator('.update-prompt')).toBeVisible()
  const pay=w>=1000?'.checkout-btn':'.mobile-cart-summary'
  await expect(page.locator(pay).first()).toBeVisible()
  expect(await covered(page,pay)).toBe('ok')
  // Put off: the strip goes and nothing was reloaded.
  await page.evaluate(()=>{delete (window as unknown as {__reloaded?:boolean}).__reloaded})
  await page.getByRole('button',{name:'Nanti'}).click()
  await expect(page.locator('.update-prompt')).toBeHidden()
  expect(await page.evaluate(()=>(window as unknown as {__reloaded?:boolean}).__reloaded)).toBeUndefined()
 })
// LB-01: Escape that closes an open dropdown must not also close the dialog (the form would be lost).
async function poWithOneLine(page:Page){
 await demo(page);await page.goto('/purchases')
 await page.getByRole('button',{name:'Buat PO'}).click()
 const po=page.getByRole('dialog',{name:'PO baru'})
 await po.getByLabel('Pemasok').fill('CV Beras Makmur')
 await po.getByRole('combobox',{name:/^Bahan/}).click()
 await page.getByRole('textbox',{name:'Cari bahan'}).fill('telur');await page.getByRole('option').first().click()
 await po.getByLabel('Jumlah').fill('10');await po.getByLabel('Harga total baris').fill('20000')
 await po.getByRole('button',{name:/Tambah ke PO/}).click()
 await expect(po.locator('.bill-row')).toContainText('Rp20.000')
 return po
}
for(const list of [/^Bahan/,/^Satuan/])
 test(`LB-01: Escape on the open ${list} dropdown keeps the PO dialog`,async({page})=>{
  const po=await poWithOneLine(page)
  await po.getByRole('combobox',{name:list}).click()
  await expect(page.getByRole('listbox')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expect(po).toBeVisible();await expect(po.getByLabel('Pemasok')).toHaveValue('CV Beras Makmur');await expect(po.locator('.bill-row')).toContainText('Rp20.000')
  // With no list open, Escape still closes the dialog.
  await po.getByLabel('Jumlah').focus();await page.keyboard.press('Escape');await expect(po).toBeHidden()
 })
// LB-02: a tap on the error message's X (it lives in the shell, outside the modal) closes the message, not the dialog.
test('LB-02: closing the error message leaves the dialog and its entry',async({page})=>{
 const po=await poWithOneLine(page)
 await page.evaluate(()=>document.querySelector('.app-shell')!.insertAdjacentHTML('beforeend','<div class="error-toast"><div><strong>Tindakan belum selesai</strong><p>x</p></div><button aria-label="Tutup pesan kesalahan" onclick="this.closest(\'.error-toast\').remove()">X</button></div>'))
 await page.getByRole('button',{name:'Tutup pesan kesalahan'}).click()
 await expect(page.locator('.error-toast')).toHaveCount(0)
 await expect(po).toBeVisible();await expect(po.getByLabel('Pemasok')).toHaveValue('CV Beras Makmur')
})
// LB-04/05/06 and LF-4 on a phone.
test.describe('phone',()=>{
 test.use({viewport:{width:360,height:640},hasTouch:true})
 test('LB-04: one cost entry does not widen the Akuntansi page',async({page})=>{
  await demo(page);await page.goto('/accounting');await page.getByRole('button',{name:'Biaya & kas',exact:true}).click()
  await page.getByRole('button',{name:'Catat biaya'}).click()
  const dlg=page.getByRole('dialog',{name:'Catat biaya'})
  await dlg.getByLabel('Jumlah').fill('500000');await dlg.getByLabel('Catatan').fill('Sewa ruko November dan Desember, dibayar ke Pak Hendra (55)')
  await dlg.getByRole('button',{name:'Simpan catatan'}).click();await expect(dlg).toBeHidden()
  await expect(page.locator('.books-table')).toContainText('Sewa ruko')
  expect(await page.evaluate(()=>[innerWidth,document.documentElement.scrollWidth])).toEqual([360,360])
 })
 test('LB-05: the Kode akun sheet scrolls and its save button stays reachable',async({page})=>{
  await demo(page);await page.goto('/accounting');await page.getByRole('button',{name:'Jurnal',exact:true}).click();await page.getByRole('button',{name:'Kode akun'}).click()
  const dlg=page.getByRole('dialog',{name:'Kode akun'}),save=dlg.getByRole('button',{name:'Simpan kode akun'})
  await expect(save).toBeVisible()
  const b=(await save.boundingBox())!;expect(b.y+b.height).toBeLessThanOrEqual(640);expect(b.x).toBeGreaterThanOrEqual(0);expect(b.x+b.width).toBeLessThanOrEqual(360)
  expect(await dlg.locator('.account-grid').evaluate(g=>g.scrollHeight>g.clientHeight&&getComputedStyle(g).overflowY==='auto')).toBe(true)
  await dlg.locator('.account-grid').evaluate(g=>{g.scrollTop=g.scrollHeight})
  await expect(dlg.getByLabel('Nama '+(await dlg.locator('.account-row input').last().getAttribute('aria-label'))!.slice(5))).toBeInViewport()
 })
 for(const path of ['/accounting','/sales'])
  test(`LB-06: metric figures on ${path} get a full-width card`,async({page})=>{
   await demo(page);await page.goto(path);await page.locator('.metric>strong').first().waitFor()
   const w=await page.locator('.metrics').first().evaluate(m=>[m.getBoundingClientRect().width,...[...m.querySelectorAll('.metric')].map(c=>c.getBoundingClientRect().width)])
   for(const c of w.slice(1))expect(c).toBeGreaterThan(w[0]-2)
  })
 test('LF-4: the Menu button of the bottom bar is as wide as its neighbours',async({page})=>{
  await demo(page)
  const ws=await page.locator('.bottom-nav>a,.bottom-nav>button').evaluateAll(e=>e.map(x=>x.getBoundingClientRect().width))
  for(const w of ws)expect(w).toBeGreaterThanOrEqual(44)
 })
})
test('LF-4: till controls are at least 44 px',async({page})=>{
 await page.setViewportSize({width:1280,height:800})
 await demo(page);await openShift(page);await addItem(page,'Nasi goreng kampung')
 const small=await page.evaluate(()=>[...document.querySelectorAll('.desktop-cart .quantity-control>button,.menu-area .category-tabs>button,.mode-switch.segmented>button,.cart-more>.cart-glyph,.cart-discount')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&(r.width<44||r.height<44)}).map(e=>e.className+':'+Math.round(e.getBoundingClientRect().width)+'x'+Math.round(e.getBoundingClientRect().height)))
 expect(small).toEqual([])
})
