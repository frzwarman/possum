import { stock } from '../domain/sample'
import type { BarcodeLink, Identity, PhoneStock, Server, Snapshot } from './types'

// "Coba demo": Takar's sample bahan, no server. For showing the app and checking screens without live data.
const STORE = 'Ziggy Lounge (demo)'
export const demoIdentity = (deviceId: string): Identity => ({
  id: 'demo-admin', name: 'Admin Demo', role: 'admin', restaurantId: 'local-demo', store: STORE, timezone: 'Asia/Jakarta', deviceId, paired: true, demo: true,
})

// Codes to type or scan in the demo. The first two are printed on a pack, the third on a single item.
const sampleLinks: Record<string, BarcodeLink> = {
  '8991002101234': { stockId: 'water', pack: 'dus' },
  '8992753102207': { stockId: 'coffee', pack: 'bungkus' },
  '8998866200301': { stockId: 'egg', pack: '' },
}
// A last price and a usual delivery for four bahan, so the delivery screen can prefill and warn.
// cost = rupiah per thousandth of the base unit; usual = thousandths of the base unit.
const prices: Record<string, { cost: number; usual: number[] }> = {
  water: { cost: 2, usual: [48_000, 48_000, 48_000] },
  coffee: { cost: 0.25, usual: [2_000_000, 2_000_000, 2_000_000] },
  egg: { cost: 1.8, usual: [60_000, 60_000, 60_000] },
  rice: { cost: 0.014, usual: [25_000_000, 25_000_000, 25_000_000] },
}
const sampleStock: PhoneStock[] = stock.map((s) => ({ id: s.id, name: s.name, unit: s.unit, area: s.area, packs: s.packs, aliases: s.aliases, ...prices[s.id] }))

export function demoSnapshot(now: string, links: Record<string, BarcodeLink> = sampleLinks): Snapshot {
  return {
    restaurantId: 'local-demo', name: 'Admin Demo', role: 'admin', store: STORE, timezone: 'Asia/Jakarta', now,
    device: { mode: 'phone', enrolled: true, primary: false }, team: [], stock: sampleStock,
    barcodes: Object.entries(links).map(([code, link]) => ({ code, ...link })),
  }
}

// A server that lives in memory: it accepts every job and remembers barcode links until the app is closed.
export function demoServer(now: () => string): Server {
  const links = { ...sampleLinks }
  return {
    snapshot: async () => demoSnapshot(now(), links),
    apply: async () => {},
    link: async (_device, code, stockId, pack) => {
      links[code] = { stockId, pack }
    },
    unlink: async (_device, code) => {
      delete links[code]
    },
    pair: async () => {},
  }
}
