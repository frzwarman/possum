// Shared types of the Takar Stok phone app (mobile/). Everything in src/stok is plain TypeScript: no React Native,
// Expo, DOM or Node imports, so the web app's tests and type-check cover it and the phone bundles the same files.
import type { CountSession, Pack, Role, StockItem } from '../domain/types'
export type { CountSession, Pack, Role }

export interface TeamMember { id: string; name: string; role: Role; login?: string | null }
// A bahan as the phone knows it. cost (rupiah per thousandth of the base unit) and usual (the last five deliveries,
// oldest first) only arrive for the roles that record deliveries. There is no balance: a count stays blind.
export interface PhoneStock { id: string; name: string; unit: StockItem['unit']; area?: string; packs?: Pack[]; aliases?: string[]; cost?: number; usual?: number[] }
// pack names one of the bahan's packs, or '' for a single unit.
export interface BarcodeLink { stockId: string; pack: string }
// What stock_app(device_id) returns.
export interface Snapshot {
  restaurantId: string; name: string; role: Role; store: string; timezone: string; now: string
  device: { mode: string | null; enrolled: boolean; primary: boolean }
  team: TeamMember[]; stock: PhoneStock[]; barcodes: ({ code: string } & BarcodeLink)[]
}
export interface Identity { id: string; name: string; role: Role; restaurantId: string; store: string; timezone: string; deviceId: string; paired: boolean; demo: boolean }
// One line of a delivery as typed: amount and price are text in `unit` (a pack name, kg, l or the base unit).
// checked holds what the person confirmed after the "is this usual" warning: the quantity itself, in thousandths
// of the base unit, so "300" confirmed as pcs says nothing about 300 dus. The app up to 1.0.3 kept the typed text
// here; a delivery it left on the phone never equals a quantity, so such a line simply asks once more.
export interface DeliveryLine { id: string; stockId: string; unit: string; amount: string; price: string; checked?: number }
export interface Delivery { id: string; note: string; photo?: string; lines: DeliveryLine[] }
// Unsent work. An op goes through apply_operation; a link or unlink through its own server function.
export type Job = { id: string; actor: string; occurredAt: string; label: string; state: 'pending' | 'rejected'; error?: string } & (
  | { type: 'op'; kind: 'count.submit' | 'stock.record'; payload: Record<string, unknown> }
  | { type: 'link'; code: string; stockId: string; pack: string }
  | { type: 'unlink'; code: string }
)
export interface Operation { id: string; kind: string; actor: string; restaurantId: string; deviceId: string; occurredAt: string; payload: Record<string, unknown> }
export interface Server {
  snapshot(deviceId: string): Promise<Snapshot>
  apply(operation: Operation): Promise<void>
  link(deviceId: string, code: string, stockId: string, pack: string): Promise<void>
  unlink(deviceId: string, code: string): Promise<void>
  pair(deviceId: string): Promise<void>
}
// The slice of localStorage the phone needs; on the device it is backed by SQLite.
export interface KV { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
