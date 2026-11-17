import type { Job, KV } from './types'

// Storage holds JSON. A missing or damaged value reads as the fallback: the phone must still open after a bad write.
export function load<T>(kv: KV, key: string, fallback: T): T {
  try {
    const raw = kv.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}
export const save = (kv: KV, key: string, value: unknown): void => kv.setItem(key, JSON.stringify(value))

// One person's unsent work on this phone. Every change is written at once, so a closed or killed app loses nothing.
export class Queue {
  private readonly kv: KV
  private readonly key: string
  constructor(kv: KV, userId: string) {
    this.kv = kv
    this.key = `stok-queue-${userId}`
  }
  // Oldest first: work is sent in the order it happened.
  all(): Job[] {
    const jobs = load<Job[]>(this.kv, this.key, [])
    return Array.isArray(jobs) ? [...jobs].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)) : []
  }
  // A job that is already queued is not queued again: a second tap on "save" must not double the work.
  add(jobs: Job[]): void {
    const queued = this.all()
    const ids = new Set(queued.map((j) => j.id))
    save(this.kv, this.key, [...queued, ...jobs.filter((j) => !ids.has(j.id) && Boolean(ids.add(j.id)))])
  }
  // The server took it.
  done(id: string): void {
    this.remove(id)
  }
  // The server refused it for good. It stays, with the server's words, until the person decides.
  reject(id: string, error: string): void {
    save(this.kv, this.key, this.all().map((j) => (j.id === id ? { ...j, state: 'rejected', error } : j)))
  }
  // Send a refused job again as new work: a new id and time, because the server remembers the old id.
  renew(id: string, newId: string, now: string): void {
    save(this.kv, this.key, this.all().map((j) => (j.id === id ? { ...j, id: newId, occurredAt: now, state: 'pending', error: undefined } : j)))
  }
  remove(id: string): void {
    save(this.kv, this.key, this.all().filter((j) => j.id !== id))
  }
}
