import { test,expect } from './meja'
import { demo } from './meja'
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
