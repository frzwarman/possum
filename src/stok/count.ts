import type { CountSession, Job, PhoneStock } from './types'

// The area label of a count over every storage area. Takar's review screen shows the same words.
export const ALL_AREAS = 'Semua area'

export const areas = (stock: PhoneStock[]): string[] => [...new Set(stock.flatMap((s) => (s.area ? [s.area] : [])))].sort()

// A new count for one area ('' = every area), walked by area and then by name, with nothing counted yet.
// It carries no expected amounts: the person counting never sees what the system thinks is there.
export function startCount(stock: PhoneStock[], area: string, userId: string, id: string, now: string): CountSession {
  const lines = stock
    .filter((s) => !area || s.area === area)
    .sort((a, b) => (a.area ?? '').localeCompare(b.area ?? '') || a.name.localeCompare(b.name))
    .map((s) => ({ stockId: s.id }))
  if (!lines.length) throw new Error('Tidak ada bahan di area ini')
  return { id, area: area || ALL_AREAS, status: 'draft', lines, startedBy: userId, startedAt: now }
}

// The amount for one bahan (undefined = not counted). A bahan scanned from another area joins the count.
export function setCounted(session: CountSession, stockId: string, counted: number | undefined): CountSession {
  const known = session.lines.some((l) => l.stockId === stockId)
  return { ...session, lines: known ? session.lines.map((l) => (l.stockId === stockId ? { ...l, counted } : l)) : [...session.lines, { stockId, counted }] }
}

// The count as Takar's own submitCount sends it: only what was counted. A bahan removed from Takar while the count
// was paused is left out, so one deleted item cannot make the server refuse the whole count.
export function countJob(session: CountSession, stock: PhoneStock[], actor: string, id: string, now: string): Job {
  const lines = session.lines.flatMap((l) => (l.counted === undefined || !stock.some((s) => s.id === l.stockId) ? [] : [{ stockId: l.stockId, counted: l.counted, reason: '' }]))
  if (!lines.length) throw new Error('Belum ada bahan yang dihitung')
  return {
    id, actor, occurredAt: now, label: `Hitung ${session.area} · ${lines.length} bahan`, state: 'pending', type: 'op', kind: 'count.submit',
    payload: { id: session.id, area: session.area, lines },
  }
}
