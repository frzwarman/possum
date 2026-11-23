import { describe,expect,it,vi } from 'vitest'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { AppProvider } from '../../src/app/context'
import Today from '../../src/features/today/Today'
import { databaseFor } from '../../src/lib/db'
import { businessDay } from '../../src/domain/calculate'
import { defaultSettings } from '../../src/domain/sample'
import type { Identity,Order } from '../../src/domain/types'
// Hari ini links to other pages; the budget panel under test needs no router.
vi.mock('@tanstack/react-router',()=>({Link:({children}:{children?:ReactNode})=>children,Navigate:()=>null}))
describe('compliment budget on Hari ini',()=>{
 it('counts every compliment this month, not only those among the 500 orders the app keeps in memory',async()=>{
  const user:Identity={id:'owner-budget',name:'Pemilik',role:'owner',restaurantId:`resto-budget-${Date.now()}`,deviceId:'dev-budget',primary:false,demo:true,mode:'office'}
  const db=databaseFor(user),settings={...defaultSettings,complimentBudget:3_000_000}
  await db.settings.put(settings);await db.meta.put({id:'initialized',value:'yes'})
  // The owner's family dinner on the 1st, then 600 sales the same business day: all of them this month.
  const month=businessDay(new Date().toISOString(),settings.timezone,settings.cutoff).slice(0,7),start=Date.parse(`${month}-01T12:00:00+07:00`)
  const order=(i:number,family:boolean):Order=>{const at=new Date(start+i*60000).toISOString(),total=family?0:50000
   return {id:`o${i}`,restaurantId:user.restaurantId,shiftId:'s1',actor:user.id,cashier:'Siti',revision:3,receiptId:`MJ-${i}`,label:'Pager 1',mode:family?'compliment':'dinein',...(family&&{compliment:{kind:'family' as const,who:'Rino'}}),lines:[],status:'paid',prep:'ready',discount:family?1_500_000:0,discountReason:'',settings,totals:{subtotal:family?1_500_000:total,discount:family?1_500_000:0,service:0,tax:0,total},payment:{method:family?'none':'card',tendered:total,change:0,verified:true,at},createdAt:at,updatedAt:at}}
  await db.orders.bulkPut([order(0,true),...Array.from({length:600},(_,i)=>order(i+1,false))])
  const {container}=render(<AppProvider user={user}><Today/></AppProvider>)
  await vi.waitFor(()=>expect(container.querySelector('.budget-used')).toHaveTextContent('Rp1.500.000'),{timeout:5000})
  expect(container.querySelector('.budget-panel')).toHaveTextContent(/Keluarga pemilik1 pesanan/)
 },15000)
})
