// Takar roles: the owner is the brand account, the manager runs the lounge, the admin keeps stock,
// the chef writes recipes, cashiers sell, baristas and kitchen crew work the station tablets.
export type Role = 'owner' | 'manager' | 'admin' | 'chef' | 'cashier' | 'barista' | 'kitchen'
export type Station = 'kitchen' | 'bar'
// A paired device: the one till (pos), a station tablet, or a back-office laptop. null = not paired.
export type DeviceMode = 'pos' | 'station' | 'office'
// A manager's or the owner's PIN entered at the till, checked by the server; good for one action.
export type ApprovalAction = 'discount' | 'void' | 'refund' | 'cashout' | 'count' | 'variance' | 'publish'
export interface Approval { id: string; by: string; action: ApprovalAction; amount?: number; orderId?: string; at: number }
export interface Identity { id: string; name: string; role: Role; restaurantId: string; deviceId: string; primary: boolean; demo: boolean; mode?: DeviceMode | null }
export interface Ingredient { stockId: string; qty: number }
// An option changes the recipe: an add-on adds lines, a swap or a level carries negative deltas
// (oat milk = −195 ml fresh milk, +195 ml oat milk). Consumption clamps each ingredient at zero.
export interface Modifier { id: string; name: string; price: number; recipe: Ingredient[]; group?: string; default?: boolean }
export interface OptionGroup { id: string; name: string; kind: 'add' | 'swap' | 'level' | 'size'; required?: boolean }
export type MenuType = 'food' | 'beverage' | 'snack'
export interface MenuItem {
 id: string; name: string; category: string; price: number; active: boolean; soldOut: boolean; favorite: boolean; photo?: string
 recipe: Ingredient[]; modifiers: Modifier[]; version: number
 // Takar fields; older catalog versions lack them, so readers use menuType()/itemStation() defaults.
 type?: MenuType; tags?: string[]; aliases?: string[]; station?: Station; lowAt?: number; ignoreStock?: boolean; groups?: OptionGroup[]
}
export interface Settings {
 id: string; appName: string; name: string; address: string; phone: string; footer: string; timezone: string; cutoff: number
 taxBps: number; serviceBps: number; receiptWidth: 58 | 80; printableWidth: number; goLive: string; packaging: Ingredient[]
 // Target minutes per station, the cash gap a cashier may close without a PIN, the default "running low" portions.
 stations?: { kitchen: number; bar: number }; varianceLimit?: number; lowAt?: number
 // Pilot: no bar or kitchen tablets yet, the cashier tells them and stock moves at payment. Switch on for a bigger outlet.
 stationTablets?: boolean
 // Ziggy is cashless: card or QRIS on one of these EDC machines, no float, the close matches each EDC's settlement slip.
 cashless?: boolean; edcs?: string[]
 // Staff meals and the owner's family: what they may take free each month, in rupiah. 0 or unset = no budget.
 complimentBudget?: number
}
// A pack is how an ingredient is bought: "karton = 12 × 1 L" is {name:'karton', qty:12_000_000} in thousandths of ml.
export interface Pack { name: string; qty: number }
export interface StockItem {
 id: string; name: string; unit: 'g' | 'ml' | 'pcs'; threshold: number
 // Made in-house: what one batch uses and how much it yields, in thousandths of the base unit.
 production?: { inputs: Ingredient[]; output: number }
 aliases?: string[]; area?: string; packs?: Pack[]; shelfLife?: number; station?: Station; photo?: string
}
// A line is what was ordered or received: quantity in thousandths of the base unit, cost = line total.
export interface PurchaseLine { stockId: string; qty: number; cost: number }
// Money that changed hands: from the till's cash drawer, or outside it (transfer, owner's cash).
// Negative = given back.
export interface Payment { at: string; amount: number; from: 'drawer' | 'outside' }
export interface Supplier { id: string; name: string; phone: string; address: string; note: string; active: boolean }
// lines = what was ordered; receipts = each delivery as it arrived. Owed = received − paid.
export interface PurchaseOrder {
 id: string; number: string; supplierId?: string; supplier: string; note: string; lines: PurchaseLine[]; total: number
 receipts: { at: string; lines: PurchaseLine[]; photo?: string }[]; payments: Payment[]
 status: 'ordered' | 'partial' | 'received' | 'cancelled'; revision: number; createdAt: string; updatedAt: string; closeReason?: string; cancelReason?: string
}
export interface SalesLine { id: string; itemId: string; name: string; qty: number; price: number; catalogVersion: number }
// Catering / B2B: delivered later, at a negotiated price, paid with a down payment and the rest later.
export interface SalesOrder {
 id: string; number: string; customer: { name: string; phone: string; address: string }; deliverAt: string; lines: SalesLine[]; discount: number; note: string
 totals: Totals; payments: Payment[]; status: 'confirmed' | 'delivered' | 'cancelled'; revision: number; createdAt: string; updatedAt: string; deliveredAt?: string; cancelReason?: string
}
export interface Outlet { id: string; name: string }
export interface Transfer {
 id: string; number: string; from: string; fromName: string; to: string; toName: string
 lines: { stockId: string; name: string; unit: StockItem['unit']; qty: number; value: number }[]; note: string
 status: 'sent' | 'received' | 'cancelled'; sentAt: string; received?: { stockId: string; target: string; qty: number }[]; receivedAt?: string; cancelReason?: string
}
export interface Line {
 id: string; itemId: string; name: string; price: number; qty: number; modifiers: Modifier[]; note: string; recipe: Ingredient[]; catalogVersion: number
 prepared: boolean; cancelled: boolean
 // A made line taken off the bill later needs a manager's PIN; it stays on the order, cancelled, with why and who approved.
 voidReason?: string; voidApprovedBy?: string
 // Where the ticket goes, when it was sent, and when that station marked it ready.
 station?: Station; preparedAt?: string; readyAt?: string
}
export interface Totals { subtotal: number; discount: number; service: number; tax: number; total: number }
// Compliment: a staff meal (drinks free, food half price, the staff member pays the food part) or the owner's family
// (everything free). It still takes stock, is not a sale, and counts against the monthly compliment budget.
export type OrderMode = 'dinein' | 'takeaway' | 'compliment'
export interface Compliment { kind: 'staff' | 'family'; who: string }
export interface OrderPayment { method: 'cash' | 'qris' | 'card' | 'none'; tendered: number; change: number; verified: boolean; at: string; edc?: string; approvalCode?: string }
export interface Order {
 id: string; restaurantId: string; shiftId: string; actor: string; cashier: string; revision: number; receiptId: string; label: string; mode: OrderMode; compliment?: Compliment
 lines: Line[]; status: 'open' | 'paid' | 'void' | 'refunded'; prep: 'new' | 'preparing' | 'ready'; discount: number; discountReason: string; settings: Settings; totals: Totals
 createdAt: string; updatedAt: string
 payment?: OrderPayment
 refund?: { reason: string; at: string; actor: string; approvedBy?: string }; voidReason?: string; voidApprovedBy?: string; discountApprovedBy?: string
}
export interface Shift { id: string; actor: string; cashier: string; openedAt: string; expiresAt: string; opening: number; status: 'open' | 'closed'; closedAt?: string; counted?: number; expected?: number; variance?: number; varianceApprovedBy?: string
 // Cashless close: what Takar recorded on each EDC against the total on that EDC's settlement slip.
 settlements?: Settlement[] }
export interface Settlement { edc: string; expected: number; slip: number }
export interface Movement {
 id: string; stockId: string; qty: number; kind: 'opening' | 'purchase' | 'waste' | 'count' | 'adjustment' | 'preparation' | 'production' | 'transfer'
 reason: string; actor: string; at: string; recordId: string; cost: number; photo?: string
}
export interface CashMovement { id: string; shiftId: string; amount: number; reason: string; at: string; actor: string; recordId?: string; approvedBy?: string }
// A stock count: started on a tablet for one storage area, paused and resumed locally, then
// submitted for review and approved into one count.record operation.
export interface CountSession {
 id: string; area: string; status: 'draft' | 'submitted' | 'approved'; lines: { stockId: string; counted?: number; expected?: number; reason?: string }[]
 startedBy: string; startedAt: string; submittedAt?: string; approvedAt?: string; approvedBy?: string
}
export type OpKind =
 | 'shift.open' | 'shift.close' | 'shift.cash' | 'order.save' | 'order.prepare' | 'order.ready' | 'order.void' | 'order.voidline' | 'payment.record' | 'refund.record'
 | 'stock.record' | 'catalog.publish' | 'settings.update' | 'purchase.save' | 'purchase.receive' | 'purchase.cancel' | 'purchase.pay' | 'production.record' | 'supplier.save'
 | 'salesorder.save' | 'salesorder.pay' | 'salesorder.deliver' | 'salesorder.cancel' | 'transfer.send' | 'transfer.receive' | 'transfer.cancel' | 'count.record' | 'count.submit'
export interface Operation { id: string; kind: OpKind; actor: string; restaurantId: string; deviceId: string; occurredAt: string; payload: Record<string, unknown>; state: 'pending' | 'synced' | 'rejected'; attempts: number; nextAttempt: number; error?: string; receivedAt?: string }
export interface PrintAttempt { id: string; orderId: string; kind: 'receipt' | 'kitchen' | 'test'; at: string; status: 'requested' | 'confirmed'; reprint: boolean; lineIds: string[] }
export interface Draft { id: string; orderId?: string; revision: number; label: string; mode: OrderMode; compliment?: Compliment; lines: Line[]; discount: number; discountReason: string; discountApproval?: Approval }
