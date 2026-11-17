// How amounts are shown. The arithmetic itself is Takar's (src/domain); this is only wording.
import { quantity } from '../../../src/domain/calculate';

export const unitName = (unit: string) => (unit === 'l' ? 'L' : unit);
export const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const BIG: Record<string, string> = { g: 'kg', ml: 'L' };
// Amounts as people say them: 13 L and 2,35 kg instead of 13.000 ml and 2.350 g. v is thousandths of the base unit.
export const nice = (v: number, unit: string) => (Math.abs(v) >= 1e6 && BIG[unit] ? `${quantity(v / 1000)} ${BIG[unit]}` : `${quantity(v)} ${unit}`);
