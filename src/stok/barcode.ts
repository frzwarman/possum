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

// The bahan a code belongs to and, when the code is printed on a pack that still exists, that pack.
// A pack renamed or removed in Takar leaves the code pointing at the bahan in its base unit.
export function lookup(code: string, links: Record<string, BarcodeLink>, stock: PhoneStock[]): { item: PhoneStock; pack?: Pack } | undefined {
  const link = Object.prototype.hasOwnProperty.call(links, code) ? links[code] : undefined
  const item = link && stock.find((s) => s.id === link.stockId)
  return item ? { item, pack: item.packs?.find((p) => p.name === link.pack) } : undefined
}
