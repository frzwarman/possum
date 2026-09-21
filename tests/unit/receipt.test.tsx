import { describe,expect,it,vi } from 'vitest'
import { fireEvent,render,screen } from '@testing-library/react'
import { AppProvider } from '../../src/app/context'
import { Receipt } from '../../src/features/orders/Receipt'
import { databaseFor } from '../../src/lib/db'
import { totals } from '../../src/domain/calculate'
import { defaultSettings } from '../../src/domain/sample'
import type { Identity,Line,Order } from '../../src/domain/types'
const user:Identity={id:'kasir-cetak',name:'Siti',role:'manager',restaurantId:`resto-cetak-${Date.now()}`,deviceId:'dev-cetak',primary:true,demo:true}
const lines:Line[]=[{id:'l1',itemId:'nasi-goreng',name:'Nasi goreng kampung',price:25000,qty:2,modifiers:[],note:'',recipe:[],catalogVersion:1,prepared:true,cancelled:false}]
const order:Order={id:'order-cetak',restaurantId:user.restaurantId,shiftId:'shift-1',actor:user.id,cashier:'Siti',revision:3,receiptId:'MJ-TEST-0001',label:'Meja 4',mode:'dinein',lines,status:'paid',prep:'ready',discount:0,discountReason:'',settings:defaultSettings,totals:totals(lines,0,defaultSettings),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),payment:{method:'cash',tendered:100000,change:50000,verified:true,at:new Date().toISOString()}}
describe('receipt preview is honest about printing',()=>{
 it('says a print was only requested and leaves confirmation to the operator',async()=>{
  vi.stubGlobal('print',vi.fn()) // jsdom has no real print dialog
  render(<AppProvider user={user}><Receipt order={order} onClose={()=>{}}/></AppProvider>)
  // The wording before anyone presses anything already refuses to promise paper.
  expect(await screen.findByText('Pratinjau cetak. Hasil kertas perlu diperiksa oleh operator.')).toBeInTheDocument()
  expect(screen.getByText(/MJ-TEST-0001/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:/Cetak struk/i}))
  expect(await screen.findByText(/Cetak diminta, belum berarti kertas tercetak/i)).toBeInTheDocument()
  // Confirmation is a separate human action, never inferred from the print call.
  const confirm=screen.getByRole('button',{name:/Saya sudah melihat hasil cetak/i})
  const db=databaseFor(user)
  const attempt=(await db.prints.where('orderId').equals(order.id).toArray())[0]
  expect(attempt.status).toBe('requested')
  expect(attempt.kind).toBe('receipt')
  fireEvent.click(confirm)
  await vi.waitFor(async()=>expect((await db.prints.get(attempt.id))!.status).toBe('confirmed'))
 })
})
