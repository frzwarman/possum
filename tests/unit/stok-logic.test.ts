import { describe, expect, it } from 'vitest'
import { lookup, normalizeCode } from '../../src/stok/barcode'
import { ALL_AREAS, areas, countJob, setCounted, startCount } from '../../src/stok/count'
import { deliveryJobs, flag, lineCost, lineQty, suggestedPrice, units } from '../../src/stok/delivery'
import type { Delivery, PhoneStock } from '../../src/stok/types'

const milk: PhoneStock = { id: 'milk', name: 'Susu UHT', unit: 'ml', area: 'Kulkas bar', packs: [{ name: 'karton', qty: 12_000_000 }], cost: 0.018, usual: [36_000_000, 36_000_000, 36_000_000] }
const syrup: PhoneStock = { id: 'syrup', name: 'Sirup vanila', unit: 'pcs', area: 'Rak bar', usual: [6000, 6000, 6000] }
const rice: PhoneStock = { id: 'rice', name: 'Beras', unit: 'g', area: 'Dry store' }
const stock = [syrup, rice, milk]
const now = '2026-11-17T03:00:00.000Z'

describe('barcode', () => {
  it('trims, and gives a 12-digit code its leading zero', () => {
    expect(normalizeCode(' 8991002101234\n')).toBe('8991002101234')
    expect(normalizeCode('036000291452')).toBe('0036000291452')
  })
  it('refuses a code that is too short, too long or has a space inside', () => {
    expect(normalizeCode('12')).toBeUndefined()
    expect(normalizeCode('8991 002')).toBeUndefined()
    expect(normalizeCode('x'.repeat(65))).toBeUndefined()
  })
  it('finds the bahan and its pack, and falls back to the base unit when the pack is gone', () => {
    expect(lookup('1', {}, stock)).toBeUndefined()
    expect(lookup('1', { '1': { stockId: 'milk', pack: 'karton' } }, stock)).toEqual({ item: milk, pack: milk.packs![0] })
    expect(lookup('1', { '1': { stockId: 'milk', pack: 'dus' } }, stock)).toEqual({ item: milk, pack: undefined })
    expect(lookup('1', { '1': { stockId: 'gone', pack: '' } }, stock)).toBeUndefined()
  })
})

describe('count', () => {
  it('lists areas and walks a count by area, then name', () => {
    expect(areas(stock)).toEqual(['Dry store', 'Kulkas bar', 'Rak bar'])
    const all = startCount(stock, '', 'u1', 'c1', now)
    expect([all.area, all.status, all.startedBy, all.startedAt]).toEqual([ALL_AREAS, 'draft', 'u1', now])
    expect(all.lines.map((l) => l.stockId)).toEqual(['rice', 'milk', 'syrup'])
    expect(startCount(stock, 'Rak bar', 'u1', 'c2', now).lines).toEqual([{ stockId: 'syrup' }])
    expect(() => startCount(stock, 'Gudang', 'u1', 'c3', now)).toThrow('Tidak ada bahan di area ini')
  })
  it('sets, clears and adds a line', () => {
    const c = startCount(stock, 'Rak bar', 'u1', 'c2', now)
    expect(setCounted(c, 'syrup', 6000).lines).toEqual([{ stockId: 'syrup', counted: 6000 }])
    expect(setCounted(setCounted(c, 'syrup', 6000), 'syrup', undefined).lines).toEqual([{ stockId: 'syrup', counted: undefined }])
    expect(setCounted(c, 'milk', 0).lines).toEqual([{ stockId: 'syrup' }, { stockId: 'milk', counted: 0 }])
  })
  it('sends only what was counted, and drops a bahan that no longer exists', () => {
    let c = startCount(stock, '', 'u1', 'c1', now)
    expect(() => countJob(c, stock, 'u1', 'j1', now)).toThrow('Belum ada bahan yang dihitung')
    c = setCounted(setCounted(c, 'milk', 29_000_000), 'rice', 0)
    expect(countJob(c, [milk, syrup], 'u1', 'j1', now)).toEqual({
      id: 'j1', actor: 'u1', occurredAt: now, state: 'pending', type: 'op', kind: 'count.submit', label: 'Hitung Semua area · 1 bahan',
      payload: { id: 'c1', area: ALL_AREAS, lines: [{ stockId: 'milk', counted: 29_000_000, reason: '' }] },
    })
  })
})

describe('delivery', () => {
  const line = (p: Partial<Delivery['lines'][number]> = {}) => ({ id: 'l1', stockId: 'milk', unit: 'karton', amount: '3', price: '216000', ...p })
  it('offers packs, then kg or L, then the base unit', () => {
    expect(units(milk)).toEqual([{ name: 'karton', per: 12_000_000 }, { name: 'l', per: 1_000_000 }, { name: 'ml', per: 1000 }])
    expect(units(syrup)).toEqual([{ name: 'pcs', per: 1000 }])
  })
  it('turns an amount into base units and a cost', () => {
    expect(lineQty(milk, line())).toBe(36_000_000)
    expect(lineQty(milk, line({ unit: 'l', amount: '2,5' }))).toBe(2_500_000)
    expect(lineQty(milk, line({ amount: '' }))).toBe(0)
    expect(() => lineQty(milk, line({ amount: '3 karton' }))).toThrow('Gunakan angka positif')
    expect(lineCost(milk, line())).toBe(648_000)
    expect(lineCost(milk, line({ price: '' }))).toBe(0)
    expect(suggestedPrice(milk, 'karton')).toBe('216000')
    expect(suggestedPrice(rice, 'kg')).toBe('')
  })
  it('flags an unusual amount until it is confirmed', () => {
    const big = { id: 'l2', stockId: 'syrup', unit: 'pcs', amount: '60', price: '' }
    expect(flag(syrup, big)).toBe('high')
    expect(flag(syrup, { ...big, checked: '60' })).toBeUndefined()
    expect(flag(syrup, { ...big, amount: '6' })).toBeUndefined()
    expect(flag(rice, { ...big, stockId: 'rice', unit: 'kg' })).toBeUndefined()
  })
  it('builds one stock entry per line, reusing the line id, with the photo on the first', () => {
    const d: Delivery = { id: 'd1', note: ' CV Susu Jaya, nota 1203 ', photo: 'data:image/webp;base64,AAAA', lines: [line(), { id: 'l2', stockId: 'syrup', unit: 'pcs', amount: '6', price: '85000' }] }
    const jobs = deliveryJobs(d, stock, 'u1', now)
    expect(jobs.map((j) => j.id)).toEqual(['l1', 'l2'])
    expect(jobs[0]).toMatchObject({ actor: 'u1', occurredAt: now, state: 'pending', type: 'op', kind: 'stock.record', payload: { stockId: 'milk', kind: 'purchase', qty: 36_000_000, reason: 'CV Susu Jaya, nota 1203', cost: 648_000, fromDrawer: false, photo: 'data:image/webp;base64,AAAA' } })
    expect(jobs[1].type === 'op' && jobs[1].payload).toEqual({ stockId: 'syrup', kind: 'purchase', qty: 6000, reason: 'CV Susu Jaya, nota 1203', cost: 510_000, fromDrawer: false })
  })
  it('refuses a delivery with no note, no lines, or an unconfirmed flag', () => {
    expect(() => deliveryJobs({ id: 'd', note: ' ', lines: [line()] }, stock, 'u1', now)).toThrow('Isi pemasok atau nomor nota')
    expect(() => deliveryJobs({ id: 'd', note: 'x', lines: [] }, stock, 'u1', now)).toThrow('Tambahkan bahan yang datang')
    expect(() => deliveryJobs({ id: 'd', note: 'x', lines: [{ id: 'l2', stockId: 'syrup', unit: 'pcs', amount: '60', price: '' }] }, stock, 'u1', now)).toThrow('Cek jumlah yang ditandai')
  })
})
