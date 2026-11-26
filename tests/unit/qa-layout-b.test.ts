import { describe,expect,it } from 'vitest'
import { rupiah } from '../../src/domain/calculate'
// QA 2026-11-25, cluster layout-b.
describe('LB-09: a zero never shows a minus sign',()=>{
 it('negated empty sums and rounded-away fractions print Rp0',()=>{
  expect(rupiah(-0)).toBe('Rp0');expect(rupiah(0)).toBe('Rp0');expect(rupiah(-0.4)).toBe('Rp0');expect(rupiah(-(0))).toBe('Rp0')
 })
 it('real negatives keep their sign',()=>{expect(rupiah(-1500)).toBe('-Rp1.500');expect(rupiah(25000)).toBe('Rp25.000')})
})
