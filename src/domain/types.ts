export type Role = "owner" | "manager" | "cashier";
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
  refund?: { reason: string; at: string; actor: string };
  voidReason?: string;
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
    "opening" | "purchase" | "waste" | "count" | "adjustment" | "preparation";
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
  | "settings.update";
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
}
