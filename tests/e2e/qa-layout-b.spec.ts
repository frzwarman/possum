import AxeBuilder from '@axe-core/playwright'
import { test,expect,demo } from './meja'
import type { Page } from '@playwright/test'
// QA layout-b: dropdown placement (LB-08, LB-10), Hari ini zeros (LB-09), the phone's Menu sheet (LB-12), contrast and targets (LB-11, LB-13), long names (LB-14).
const sheet=async(page:Page)=>{await page.waitForTimeout(450);return page.locator('.select-menu').evaluate(m=>{const b=m.getBoundingClientRect(),s=m.querySelector('input')?.getBoundingClientRect(),d=m.closest('.dialog-content')?.getBoundingClientRect();return {left:Math.round(b.left),width:Math.round(b.width),top:Math.round(b.top),bottom:Math.round(b.bottom),searchTop:s?Math.round(s.top):null,dialogTop:d?Math.round(d.top):null}})}
test('LB-08: on a phone a dropdown inside a dialog is the same full-width sheet at the bottom of the screen',async({page})=>{
 await page.setViewportSize({width:393,height:852});await demo(page)
 await page.goto('/accounting');await page.getByRole('combobox',{name:'Periode'}).click();const outside=await sheet(page);await page.getByRole('option',{name:'Bulan ini'}).click()
 await page.goto('/catering');await page.getByRole('button',{name:/Pesanan baru/}).click()
 const dlg=page.getByRole('dialog',{name:'Pesanan katering baru'}),menu=dlg.getByRole('combobox',{name:/^Menu/})
 await menu.click();const inDialog=await sheet(page)
 const ok=(s:typeof outside)=>s.left===0&&s.width===393&&Math.abs(s.bottom-852)<=1&&s.top>=0
 expect({outside:ok(outside),inDialog:ok(inDialog)}).toEqual({outside:true,inDialog:true})
 // Scrolled dialog: the Menu trigger near the top of the dialog's box, the sheet still on the screen with its search field.
 for(const item of ['Iced Americano','Hot Americano','Ziggy Fried Rice']){if(!(await page.getByRole('listbox').isVisible()))await menu.click();await page.getByRole('textbox',{name:'Cari menu'}).fill(item);await page.getByRole('option',{name:new RegExp(item)}).first().click();await dlg.getByLabel('Jumlah porsi').fill('10');await dlg.getByRole('button',{name:/Tambah menu/}).click()}
 await menu.evaluate(t=>{const d=t.closest('.dialog-content')!;d.scrollTop=t.getBoundingClientRect().top-d.getBoundingClientRect().top+d.scrollTop-70})
 const box=(await menu.boundingBox())!;await page.mouse.click(box.x+box.width/2,box.y+box.height/2)
 expect(ok(await sheet(page))).toBe(true)
})
test('LB-10: a dropdown low on the page opens where its options can be seen',async({page})=>{
 await page.setViewportSize({width:1280,height:720});await demo(page);await page.goto('/menu')
 await page.getByRole('button',{name:'Hapus Ziggy Fried Rice'}).locator('xpath=..').getByRole('button',{name:'Edit'}).click()
 const last=page.getByRole('combobox',{name:'Jenis grup'}).last();await expect(last).toBeVisible()
 await last.evaluate(t=>t.scrollIntoView({block:'end'}));const box=(await last.boundingBox())!;await page.mouse.click(box.x+box.width/2,box.y+box.height/2)
 const seen=await page.getByRole('listbox').evaluate(l=>[...l.querySelectorAll('[role=option]')].map(o=>{const r=o.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight}))
 expect(seen.every(Boolean)).toBe(true)
})
test('LB-09: Hari ini on a quiet day shows Rp0, never -Rp0',async({page})=>{
 await demo(page);await page.goto('/today')
 const waste=page.locator('.metric').filter({hasText:'Terbuang'}),cost=page.locator('.metric').filter({hasText:'Food cost'})
 await expect(waste.locator('strong')).toHaveText('Rp0');await expect(cost.locator('small')).toHaveText('bahan terpakai Rp0')
})
test('LB-12: the phone Menu sheet takes focus, closes on Escape and its button is as wide as the others',async({page})=>{
 await page.setViewportSize({width:360,height:640});await demo(page)
 const button=page.locator('.bottom-nav').getByRole('button',{name:'Menu'}),width=async(l:ReturnType<Page['locator']>)=>(await l.boundingBox())!.width
 expect(await width(button)).toBeGreaterThanOrEqual(44)
 await button.click();const sheet=page.getByRole('dialog',{name:'Menu'});await expect(sheet).toBeVisible()
 expect(await sheet.evaluate(s=>s.contains(document.activeElement))).toBe(true)
 await page.keyboard.press('Escape');await expect(sheet).toBeHidden();await expect(button).toBeFocused()
})
test('LB-11, LB-13: info chips pass contrast, the logo link and the report scroller are reachable, small buttons are 44px',async({page})=>{
 await page.setViewportSize({width:800,height:1280});await demo(page)
 await page.goto('/team');await expect(page.locator('.dot-chip.info').first()).toBeVisible()
 const run=async(rule:string)=>(await new AxeBuilder({page}).withRules([rule]).analyze()).violations.flatMap(v=>v.nodes.map(n=>n.target.join(' ')))
 expect(await run('color-contrast')).toEqual([]);expect(await run('link-name')).toEqual([])
 await page.setViewportSize({width:393,height:852});await page.goto('/reports');await expect(page.getByRole('heading',{name:'Laporan',exact:true})).toBeVisible();await page.waitForTimeout(600)
 expect(await run('scrollable-region-focusable')).toEqual([])
 await page.goto('/accounting');const print=(await page.getByRole('button',{name:'Cetak / PDF'}).boundingBox())!;expect(print.width).toBeGreaterThanOrEqual(44)
 await page.goto('/catering');await page.getByRole('button',{name:/Pesanan baru/}).click()
 const dlg=page.getByRole('dialog',{name:'Pesanan katering baru'});await dlg.getByRole('combobox',{name:/^Menu/}).click();await page.getByRole('textbox',{name:'Cari menu'}).fill('Iced Americano');await page.getByRole('option',{name:/Iced Americano/}).first().click()
 await dlg.getByLabel('Jumlah porsi').fill('10');await dlg.getByRole('button',{name:/Tambah menu/}).click()
 const rm=(await dlg.getByRole('button',{name:'Hapus Iced Americano'}).boundingBox())!;expect(Math.min(rm.width,rm.height)).toBeGreaterThanOrEqual(44)
})
test('LB-14: a very long restaurant name is clamped inside the phone top bar',async({page})=>{
 await page.setViewportSize({width:360,height:640});await demo(page)
 const name='Ziggy Lounge & Kitchen — Cabang Kemang Raya, Jakarta Selatan'
 await page.goto('/settings');await page.getByRole('button',{name:'Restoran',exact:true}).click()
 await page.getByRole('textbox',{name:'Nama restoran',exact:true}).fill(name);await page.getByRole('button',{name:'Simpan pengaturan'}).click();await page.waitForTimeout(800)
 await page.goto('/today');await expect(page.locator('.topbar-breadcrumb')).toContainText(name.slice(0,10))
 const m=await page.locator('.topbar-breadcrumb').evaluate(c=>{const bar=c.closest('.topbar')!.getBoundingClientRect(),b=c.getBoundingClientRect();return {inside:b.top>=bar.top&&b.bottom<=bar.bottom,wide:document.documentElement.scrollWidth>innerWidth}})
 expect(m).toEqual({inside:true,wide:false})
})
