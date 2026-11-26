// A seeded generator (mulberry32): the same seed builds the same restaurant and the same days of trading.
export type Random = ReturnType<typeof random>
export function random(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1))
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]
  const chance = (p: number) => next() < p
  // Weights need not add up to 1.
  const weighted = <T>(pairs: readonly (readonly [T, number])[]): T => {
    let r = next() * pairs.reduce((n, [, w]) => n + w, 0)
    for (const [v, w] of pairs) if ((r -= w) < 0) return v
    return pairs[pairs.length - 1][0]
  }
  const sample = <T>(xs: readonly T[], n: number): T[] => {
    const copy = [...xs]
    for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]] }
    return copy.slice(0, n)
  }
  // RFC 4122 v4 layout, so ids pass the server's ::uuid casts.
  const uuid = () => {
    const b = Array.from({ length: 16 }, () => Math.floor(next() * 256))
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const h = b.map((x) => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }
  return { next, int, pick, chance, weighted, sample, uuid }
}
