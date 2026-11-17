import { test,expect } from './meja'
import { demo, go } from './meja'
// Dropdown sendiri menggantikan <select>: buka, pindah, pilih, tutup — semuanya dari papan ketik.
test('dropdown opens, moves and commits with the keyboard', async({page})=>{
 await demo(page)
 await page.getByRole('link',{name:'Lainnya'}).click()
 await page.getByRole('button',{name:'Restoran'}).click()
 const trigger=page.getByRole('combobox',{name:/Kertas struk/})
 await expect(trigger).toHaveText(/80 mm/)
 await trigger.focus()
 await page.keyboard.press('Enter')
 await expect(page.getByRole('listbox')).toBeVisible()
 await page.keyboard.press('ArrowUp')
 await page.keyboard.press('Enter')
 await expect(trigger).toHaveText(/58 mm/)
 await expect(page.getByRole('listbox')).toHaveCount(0)
 await trigger.press('Enter')
 await page.keyboard.press('Escape')
 await expect(page.getByRole('listbox')).toHaveCount(0)
})

// A long list (bahan on a purchase order) opens with a search field: typing narrows it, Enter picks it, and focus goes
// back to the dropdown so the form carries on from the keyboard.
test('a long dropdown is searched and picked from the keyboard', async({page})=>{
 await demo(page)
 await go(page,'Pembelian')
 await page.getByRole('button',{name:'Buat PO'}).click()
 const po=page.getByRole('dialog',{name:'PO baru'})
 const trigger=po.getByRole('combobox',{name:/^Bahan/})
 await trigger.click()
 const search=page.getByRole('textbox',{name:'Cari bahan'})
 await expect(search).toBeFocused()
 await search.fill('bawang m')
 await expect(page.getByRole('option')).toHaveCount(1)
 await search.press('Enter')
 await expect(trigger).toHaveText(/Bawang merah/)
 await expect(trigger).toBeFocused()
 await expect(page.getByRole('listbox')).toHaveCount(0)
})
