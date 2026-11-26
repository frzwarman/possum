// QA 2026-11-25, cluster till: what a screen offers or prints. ORD-2 (Pesanan offers only what this device can do) and TILL-14/15
// (the receipt after a void adds up; a fractional rate reads with the decimal comma).
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AppProvider } from '../../src/app/context'
import Orders from '../../src/features/orders/Orders'
import { Receipt } from '../../src/features/orders/Receipt'
import { databaseFor } from '../../src/lib/db'
import { orderTotals } from '../../src/domain/calculate'
import { defaultSettings } from '../../src/domain/sample'
import type { Identity, Line, Order } from '../../src/domain/types'

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => () => {}, Link: ({ children }: { children?: unknown }) => children, Navigate: () => null }))
const lines: Line[] = [{ id: 'l1', itemId: 'nasi-goreng', name: 'Nasi goreng kampung', price: 25000, qty: 1, modifiers: [], note: '', recipe: [], catalogVersion: 1, prepared: true, cancelled: false }]
const order = (user: Identity, over: Partial<Order> = {}): Order => {
  const settings = { ...defaultSettings, taxBps: 1050 }
  return { id: 'o1', restaurantId: user.restaurantId, shiftId: 's1', actor: 'x', cashier: 'Siti', revision: 2, receiptId: 'MJ-TEST-0001', label: 'Pager 4', mode: 'dinein', lines, status: 'open', prep: 'preparing', discount: 0, discountReason: '', settings, totals: orderTotals({ lines, discount: 0, mode: 'dinein' }, settings), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over }
}

describe('QA till ORD-2: Pesanan on a device that is not the till', () => {
  it('offers no correction that Commands refuses there, and says where to make it', async () => {
    const user: Identity = { id: 'laptop-ord2', name: 'Manajer', role: 'manager', restaurantId: `resto-ord2-${Date.now()}`, deviceId: 'dev-ord2', primary: false, demo: true, mode: 'office' }
    const db = databaseFor(user)
    await db.settings.put(defaultSettings); await db.meta.put({ id: 'initialized', value: 'yes' }); await db.orders.put(order(user))
    render(<AppProvider user={user}><Orders /></AppProvider>)
    const row = await screen.findByText(/Pager 4/); row.click()
    await screen.findByText(/Cetak tiket dapur/)
    for (const name of [/Batalkan pesanan/, /Buka pesanan/, /Batalkan item/, /Kembalikan dana/]) expect(screen.queryByRole('button', { name })).toBeNull()
    expect(screen.getByText(/hanya di perangkat kasir utama/)).toBeInTheDocument()
  })
  it('the till itself still offers them', async () => {
    const user: Identity = { id: 'till-ord2', name: 'Manajer', role: 'manager', restaurantId: `resto-ord2b-${Date.now()}`, deviceId: 'dev-ord2b', primary: true, demo: true }
    const db = databaseFor(user)
    await db.settings.put(defaultSettings); await db.meta.put({ id: 'initialized', value: 'yes' }); await db.orders.put(order(user))
    render(<AppProvider user={user}><Orders /></AppProvider>)
    const row = await screen.findByText(/Pager 4/); row.click()
    expect(await screen.findByRole('button', { name: /Batalkan pesanan/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Buka pesanan/ })).toBeInTheDocument()
  })
})

describe('QA till TILL-14, TILL-15: the receipt', () => {
  const user: Identity = { id: 'kasir-rcp', name: 'Siti', role: 'manager', restaurantId: `resto-rcp-${Date.now()}`, deviceId: 'dev-rcp', primary: true, demo: true }
  it('prints the change as tender minus the total as it stands, and a 10,5% rate with a comma', async () => {
    const paid = order(user, { status: 'paid', payment: { method: 'cash', tendered: 50000, change: 14000, verified: true, at: new Date().toISOString() } })
    // The order was Rp36.000 when paid; a line voided since brings it to the total shown here.
    const after = { ...paid, totals: { ...paid.totals, total: 30000 } }
    render(<AppProvider user={user}><Receipt order={after} onClose={() => {}} /></AppProvider>)
    const change = (await screen.findByText('Kembalian')).parentElement!
    expect(change).toHaveTextContent('Rp20.000')
    expect(screen.getByText(/Pajak 10,5%/)).toBeInTheDocument()
  })
})
