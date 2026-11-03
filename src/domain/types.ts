export type Role = "owner" | "manager" | "cashier";
// A manager's or the owner's PIN entered at the till, checked by the server; good for one action.
export type ApprovalAction = "discount" | "void" | "refund" | "cashout";
export interface Approval {
  id: string;
  by: string;
  action: ApprovalAction;
  amount?: number;
  orderId?: string;
  at: number;
}
export interface Identity {
  id: string;
  name: string;
  role: Role;
  restaurantId: string;
  deviceId: string;
  primary: boolean;
  demo: boolean;
}
export interface Ingredient {
  stockId: string;
  qty: number;
}
export interface Modifier {
  id: string;
  name: string;
  price: number;
  recipe: Ingredient[];
}
export interface MenuItem {
  id: string;
  name: string;
  category: string;
  price: number;
  active: boolean;
  soldOut: boolean;
  favorite: boolean;
  photo?: string;
  recipe: Ingredient[];
  modifiers: Modifier[];
  version: number;
}
export interface Settings {
  id: string;
  appName: string;
  name: string;
  address: string;
  phone: string;
  footer: string;
  timezone: string;
  cutoff: number;
  taxBps: number;
  serviceBps: number;
  receiptWidth: 58 | 80;
  printableWidth: number;
  goLive: string;
  packaging: Ingredient[];
}
export interface StockItem {
  id: string;
  name: string;
  unit: "g" | "ml" | "pcs";
  threshold: number;
  // Made in-house: what one batch uses and how much it yields, in thousandths of the base unit.
  production?: { inputs: Ingredient[]; output: number };
}
// A line is what was ordered or received: quantity in thousandths of the base unit, cost = line total.
export interface PurchaseLine {
  stockId: string;
  qty: number;
  cost: number;
}
// Money that changed hands: from the till's cash drawer, or outside it (transfer, owner's cash).
// Negative = given back.
export interface Payment {
  at: string;
  amount: number;
  from: "drawer" | "outside";
}
export interface Supplier {
  id: string;
  name: string;
  phone: string;
  address: string;
  note: string;
  active: boolean;
}
// lines = what was ordered; receipts = each delivery as it arrived. Owed = received − paid.
export interface PurchaseOrder {
  id: string;
  number: string;
  supplierId?: string;
  supplier: string;
  note: string;
  lines: PurchaseLine[];
  total: number;
  receipts: { at: string; lines: PurchaseLine[] }[];
  payments: Payment[];
  status: "ordered" | "partial" | "received" | "cancelled";
  revision: number;
  createdAt: string;
  updatedAt: string;
  closeReason?: string;
  cancelReason?: string;
}
export interface SalesLine {
  id: string;
  itemId: string;
  name: string;
  qty: number;
  price: number;
  catalogVersion: number;
}
// Catering / B2B: delivered later, at a negotiated price, paid with a down payment and the rest later.
export interface SalesOrder {
  id: string;
  number: string;
  customer: { name: string; phone: string; address: string };
  deliverAt: string;
  lines: SalesLine[];
  discount: number;
  note: string;
  totals: Totals;
  payments: Payment[];
  status: "confirmed" | "delivered" | "cancelled";
  revision: number;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
  cancelReason?: string;
}
export interface Outlet {
  id: string;
  name: string;
}
export interface Transfer {
  id: string;
  number: string;
  from: string;
  fromName: string;
  to: string;
  toName: string;
  lines: { stockId: string; name: string; unit: StockItem["unit"]; qty: number; value: number }[];
  note: string;
  status: "sent" | "received" | "cancelled";
  sentAt: string;
  received?: { stockId: string; target: string; qty: number }[];
  receivedAt?: string;
  cancelReason?: string;
}
export interface Line {
  id: string;
  itemId: string;
  name: string;
  price: number;
  qty: number;
  modifiers: Modifier[];
  note: string;
  recipe: Ingredient[];
  catalogVersion: number;
  prepared: boolean;
  cancelled: boolean;
}
export interface Totals {
  subtotal: number;
  discount: number;
  service: number;
  tax: number;
  total: number;
}
export interface Order {
  id: string;
  restaurantId: string;
  shiftId: string;
  actor: string;
  cashier: string;
  revision: number;
  receiptId: string;
  label: string;
  mode: "dinein" | "takeaway";
  lines: Line[];
  status: "open" | "paid" | "void" | "refunded";
  prep: "new" | "preparing" | "ready";
  discount: number;
  discountReason: string;
  settings: Settings;
  totals: Totals;
  createdAt: string;
  updatedAt: string;
  payment?: {
    method: "cash" | "qris" | "card";
    tendered: number;
    change: number;
    verified: boolean;
    at: string;
  };
  refund?: { reason: string; at: string; actor: string; approvedBy?: string };
  voidReason?: string;
  voidApprovedBy?: string;
  discountApprovedBy?: string;
}
export interface Shift {
  id: string;
  actor: string;
  cashier: string;
  openedAt: string;
  expiresAt: string;
  opening: number;
  status: "open" | "closed";
  closedAt?: string;
  counted?: number;
  expected?: number;
  variance?: number;
}
export interface Movement {
  id: string;
  stockId: string;
  qty: number;
  kind:
    | "opening"
    | "purchase"
    | "waste"
    | "count"
    | "adjustment"
    | "preparation"
    | "production"
    | "transfer";
  reason: string;
  actor: string;
  at: string;
  recordId: string;
  cost: number;
}
export interface CashMovement {
  id: string;
  shiftId: string;
  amount: number;
  reason: string;
  at: string;
  actor: string;
  recordId?: string;
  approvedBy?: string;
}
export type OpKind =
  | "shift.open"
  | "shift.close"
  | "shift.cash"
  | "order.save"
  | "order.prepare"
  | "order.ready"
  | "order.void"
  | "payment.record"
  | "refund.record"
  | "stock.record"
  | "catalog.publish"
  | "settings.update"
  | "purchase.save"
  | "purchase.receive"
  | "purchase.cancel"
  | "purchase.pay"
  | "production.record"
  | "supplier.save"
  | "salesorder.save"
  | "salesorder.pay"
  | "salesorder.deliver"
  | "salesorder.cancel"
  | "transfer.send"
  | "transfer.receive"
  | "transfer.cancel";
export interface Operation {
  id: string;
  kind: OpKind;
  actor: string;
  restaurantId: string;
  deviceId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  state: "pending" | "synced" | "rejected";
  attempts: number;
  nextAttempt: number;
  error?: string;
  receivedAt?: string;
}
export interface PrintAttempt {
  id: string;
  orderId: string;
  kind: "receipt" | "kitchen" | "test";
  at: string;
  status: "requested" | "confirmed";
  reprint: boolean;
  lineIds: string[];
}
export interface Draft {
  id: string;
  orderId?: string;
  revision: number;
  label: string;
  mode: "dinein" | "takeaway";
  lines: Line[];
  discount: number;
  discountReason: string;
  discountApproval?: Approval;
}
