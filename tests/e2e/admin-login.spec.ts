import { test,expect } from './meja'
import { defaultSettings,sampleMenu,stock } from '../../src/domain/sample'
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
// A till left signed in as the owner (behind its idle lock) opens no staff editor at /admin, and signing out
// there ends only /admin's own session.
test('/admin asks for the password although the device is signed in as the owner, and its sign-out leaves the till signed in', async({page})=>{
 const owner='33333333-3333-3333-3333-333333333333',restaurant='44444444-4444-4444-4444-444444444444',logouts:string[]=[]
 const b64=(o:object)=>Buffer.from(JSON.stringify(o)).toString('base64url'),token=`${b64({alg:'HS256',typ:'JWT'})}.${b64({sub:owner,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})}.sig`
 await page.route('**/auth/v1/token**',route=>route.fulfill({json:{access_token:token,token_type:'bearer',expires_in:3600,refresh_token:'refresh',user:{id:owner,aud:'authenticated',role:'authenticated',email:'pemilik@example.com',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}}}))
 await page.route('**/auth/v1/logout**',route=>{logouts.push(new URL(route.request().url()).searchParams.get('scope')??'');return route.fulfill({status:204})})
 await page.route('**/rest/v1/memberships**',route=>route.fulfill({json:[{user_id:owner,restaurant_id:restaurant,name:'Pemilik',role:'owner',active:true}]}))
 await page.route('**/rest/v1/rpc/*',route=>new URL(route.request().url()).pathname.endsWith('/bootstrap')?route.fulfill({json:{restaurantId:restaurant,name:'Pemilik',role:'owner',primary:false,settings:defaultSettings,menu:sampleMenu,stock,orders:[],shifts:[],cash:[],movements:[]}}):route.fulfill({json:{id:'op',receivedAt:new Date().toISOString()}}))
 await page.goto('/')
 await page.getByLabel('Email staf').fill('pemilik@example.com')
 await page.getByLabel('Kata sandi').fill('rahasia-uji')
 await page.getByRole('button',{name:/Masuk ke restoran/}).click()
 await expect(page.getByText(/Perangkat belum dipasangkan/)).toBeVisible()
 await page.goto('/admin')
 // The button stops loading once /admin has looked for a session of its own: it still asks for the password.
 await expect(page.getByRole('button',{name:/Masuk sebagai pemilik/})).toBeEnabled()
 await expect(page.getByRole('heading',{name:'Akun staf'})).toHaveCount(0)
 await page.getByLabel('Email pemilik').fill('pemilik@example.com')
 await page.getByLabel('Kata sandi').fill('rahasia-uji')
 await page.getByRole('button',{name:/Masuk sebagai pemilik/}).click()
 await expect(page.getByRole('heading',{name:'Akun staf'})).toBeVisible()
 await page.getByRole('button',{name:'Keluar'}).click()
 await expect(page.getByLabel('Email pemilik')).toBeVisible()
 expect(logouts).toEqual(['local'])
 expect(await page.evaluate(()=>Object.keys(localStorage).some(k=>k.endsWith('-auth-token')))).toBe(true)
})
