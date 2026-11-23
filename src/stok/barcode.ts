import type { BarcodeLink, Pack, PhoneStock } from './types'

// What the scanner reads: retail codes, the two common logistics codes, and QR.
export const BARCODE_TYPES = ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'itf14', 'qr'] as const

// A code as it is stored: trimmed, 4 to 64 printable ASCII characters, no spaces (the server checks the same).
// An iPhone reports a 12-digit UPC-A with a leading zero and Android without, so 12 digits always get the zero
// and both phones find the same link.
export function normalizeCode(raw: string): string | undefined {
  const code = raw.trim()
  if (!/^[\x21-\x7e]{4,64}$/.test(code)) return undefined
  return /^\d{12}$/.test(code) ? `0${code}` : code
}

// The camera reports a code many times a second, and it still sees the same code when the list comes back after
// an entry. A code counts as a new scan only when it is a different code, or when it has been out of the frame
// for `quiet` milliseconds. Every sighting moves seenAt, so a code that stays in view never fires twice.
export interface ScanGate { code: string; seenAt: number }
export const START: ScanGate = { code: '', seenAt: 0 }
export function admit(gate: ScanGate, code: string, now: number, quiet = 1500): { fire: boolean; gate: ScanGate } {
  return { fire: code !== gate.code || now - gate.seenAt >= quiet, gate: { code, seenAt: now } }
}
// The camera was off for a while (an entry or a sheet was open). Whatever it read last counts as still in view,
// so the bahan just saved is not opened again the moment the list returns.
export const rearm = (gate: ScanGate, now: number): ScanGate => ({ ...gate, seenAt: now })

// The unit a scanned code stands for: the pack it is printed on, or the bahan's base unit when it was taught as
// "satuan" (or its pack is gone). Never the bahan's first pack: a bottle's code must not open a delivery in dus.
export const unitOf = (hit: { item: PhoneStock; pack?: Pack }): string => hit.pack?.name ?? hit.item.unit

// The bahan a code belongs to and, when the code is printed on a pack that still exists, that pack.
// A pack renamed or removed in Takar leaves the code pointing at the bahan in its base unit.
export function lookup(code: string, links: Record<string, BarcodeLink>, stock: PhoneStock[]): { item: PhoneStock; pack?: Pack } | undefined {
  const link = Object.prototype.hasOwnProperty.call(links, code) ? links[code] : undefined
  const item = link && stock.find((s) => s.id === link.stockId)
  return item ? { item, pack: item.packs?.find((p) => p.name === link.pack) } : undefined
}
