import { describe, expect, it } from 'vitest'
import { blank, measure } from '../../src/domain/measure'
const milk = { unit: 'ml' as const, packs: [{ name: 'karton', qty: 12_000_000 }] }
describe('measure', () => {
  it('adds full packs and the open one', () => expect(measure(milk, { packs: { karton: '2' }, loose: '5', big: true })).toBe(29_000_000))
  it('reads a blank entry as not counted and 0 as a count of nothing', () => {
    expect(measure(milk, blank)).toBeUndefined()
    expect(measure(milk, { ...blank, loose: '0' })).toBe(0)
  })
  it('accepts a comma and a trailing comma, refuses anything else', () => {
    expect(measure({ unit: 'g' }, { ...blank, loose: '2,5', big: true })).toBe(2_500_000)
    expect(measure({ unit: 'g' }, { ...blank, loose: '2,' })).toBe(2000)
    expect(() => measure({ unit: 'g' }, { ...blank, loose: 'abc' })).toThrow('Gunakan angka positif')
  })
})
