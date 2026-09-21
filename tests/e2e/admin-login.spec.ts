import { test,expect } from './meja'
// Pintu masuk pemilik terpisah dari layar staf: tidak ada demo, tidak ada kasir.
test('admin area has its own login, separate from the staff screen', async({page})=>{
 await page.goto('/admin')
 await expect(page.getByLabel('Email pemilik')).toBeVisible()
 await expect(page.getByRole('button',{name:/Masuk sebagai pemilik/})).toBeEnabled()
 await expect(page.getByRole('button',{name:'Jelajahi demo lokal'})).toHaveCount(0)
 await page.goto('/')
 await expect(page.getByRole('button',{name:/Masuk ke restoran/})).toBeVisible()
 await expect(page.getByLabel('Email pemilik')).toHaveCount(0)
})
