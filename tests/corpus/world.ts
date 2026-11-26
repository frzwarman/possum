import { vi } from 'vitest'
import { Commands } from '../../src/lib/commands'
import { databaseFor, type MejaDB } from '../../src/lib/db'
import { store, synchronize } from '../../src/lib/sync'
import type { ApprovalAction, DeviceMode, Identity, Operation, Settings } from '../../src/domain/types'
import { PIN, type Person } from './catalog'
import { random, type Random } from './random'
import { Server, createDatabase } from './server'
// A restaurant group on one machine: the server (PGlite), every outlet's staff and paired devices, and a clock that
// the app and the server share. Each device keeps one signed-in person at a time and a local database per person,
// as databaseFor() names them; work goes through the real Commands into the real outbox, and synchronize() sends it
// through serverTransport and serverPull to apply_operation and pull, as a till does every 10 seconds.

export interface Staff extends Person { id: string; outlet: string }
export interface Outlet { key: string; id: string; name: string; staff: Map<string, Staff> }
export interface Device { id: string; name: string; outlet: Outlet; mode: DeviceMode; online: boolean; session?: Session }
export interface Session { staff: Staff; identity: Identity; db: MejaDB; commands: Commands; device: Device }
// Something the contract does not allow: an operation the server turned down (it halts that device's outbox), one
// it can neither take nor refuse (stuck), or a command the app refused although the restaurant did nothing wrong.
export interface Finding { kind: 'rejected' | 'stuck' | 'refused' | 'mismatch'; at: string; where: string; what: string; detail: string; op?: Operation }

export class World {
  now: number
  readonly rand: Random
  readonly outlets = new Map<string, Outlet>()
  readonly devices = new Map<string, Device>()
  readonly findings: Finding[] = []
  // Every operation the server accepted, in the order it accepted them, for the idempotency replay.
  readonly accepted: Operation[] = []
  private lost = new Set<string>()
  private constructor(readonly server: Server, seed: number, start: number) { this.rand = random(seed); this.now = start }
  // client: the object the test's vi.mock hands the app as `supabase`; it is filled with the harness's client here.
  static async create(client: Record<string, unknown>, seed: number, start: number) {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(start)
    const world = new World(new Server(await createDatabase()), seed, start)
    Object.assign(client, world.server.client())
    // Ids from the seed: the same seed sends the same operations (crypto.randomUUID is what uid() uses).
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => world.rand.uuid() as `${string}-${string}-${string}-${string}-${string}`)
    Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true, writable: true })
    // Sends that commit on the server but whose answer never reaches the device: the till retries them later.
    world.server.afterRpc = (name, args) => {
      const op = args.operation as Operation | undefined
      if (name !== 'apply_operation' || !op || !world.lossRate || world.lost.has(op.id) || !world.rand.chance(world.lossRate)) return undefined
      world.lost.add(op.id)
      return { code: 'PGRST000', message: 'simulated: connection reset after commit' }
    }
    return world
  }
  lossRate = 0
  iso() { return new Date(this.now).toISOString() }
  // A sync that waited out a back-off may have moved the clock past the next planned action: that action runs late.
  at(ms: number) { this.now = Math.max(this.now, ms); vi.setSystemTime(this.now) }
  advance(ms: number) { this.at(this.now + ms) }
  note(f: Omit<Finding, 'at'>) { this.findings.push({ ...f, at: this.iso() }) }

  // Provisioning, as scripts/provision-staff.mjs does it: a restaurant row, auth users and memberships; outlets of one
  // group share a group_id (link-outlets). Owners pair the devices; approvers set their PIN.
  async outlet(key: string, settings: Settings, people: Person[], group: string | null) {
    const id = this.rand.uuid()
    await this.server.admin('insert into public.restaurants(id,settings,group_id) values($1,$2,$3)', [id, JSON.stringify(settings), group])
    const outlet: Outlet = { key, id, name: settings.name, staff: new Map() }
    for (const p of people) {
      const staff: Staff = { ...p, id: this.rand.uuid(), outlet: key }
      await this.server.admin('insert into auth.users values($1)', [staff.id])
      await this.server.admin('insert into public.memberships(restaurant_id,user_id,role,name,active,login) values($1,$2,$3,$4,true,$5)', [id, staff.id, p.role, p.name, `${p.key}@ziggy.test`])
      outlet.staff.set(p.key, staff)
    }
    this.outlets.set(key, outlet)
    for (const [k, pin] of Object.entries(PIN)) if (outlet.staff.has(k)) await this.call(outlet.staff.get(k)!, 'set_approval_pin', { pin })
    return outlet
  }
  async device(outlet: Outlet, name: string, mode: DeviceMode) {
    const d: Device = { id: this.rand.uuid(), name, outlet, mode, online: true }
    const owner = [...outlet.staff.values()].find((s) => s.role === 'owner')!
    await this.call(owner, 'enroll_device', { device_id: d.id, mode })
    this.devices.set(d.id, d)
    return d
  }
  // An RPC as one person, outside the outbox (approve, enroll_device, set_approval_pin, reports).
  async call(who: Staff, name: string, args: Record<string, unknown> = {}) {
    this.server.session = who.id
    const { data, error } = await this.server.rpc(name, args)
    if (error) throw new Error(`${name} as ${who.key}: ${error.code} ${error.message}`)
    return data
  }
  staff(outlet: string, key: string) { const s = this.outlets.get(outlet)?.staff.get(key); if (!s) throw new Error(`no staff ${outlet}/${key}`); return s }

  // Sign-in, as Login.tsx's bootstrap() does it: the server says who this is and how the device is paired, and the local
  // database is refreshed from it unless work is still waiting to be sent.
  async signIn(device: Device, key: string): Promise<Session> {
    if (device.session && device.online) await this.sync(device)
    const staff = this.staff(device.outlet.key, key)
    this.server.session = staff.id
    const { data: boot, error } = await this.server.rpc('bootstrap', { device_id: device.id })
    if (error) throw new Error(`bootstrap ${key}: ${error.message}`)
    const user: Identity = { id: staff.id, name: boot.name, role: boot.role, restaurantId: boot.restaurantId, primary: boot.primary, deviceId: device.id, demo: false, mode: boot.device?.mode ?? null }
    const db = databaseFor(user)
    const pending = await db.outbox.where('state').anyOf('pending', 'rejected').count()
    if (!pending) await store(db, boot)
    device.session = { staff, identity: user, db, commands: new Commands(db, user), device }
    return device.session
  }
  // Runs one action on a device as whoever is signed in there. The app checks navigator.onLine for actions that need
  // the server (approvals, refunds, settings), so it follows the device. undefined = the app refused it; a command that
  // returns nothing answers true when it went through.
  async act<T>(device: Device, what: string, run: (c: Commands, s: Session) => Promise<T>): Promise<T | undefined> {
    const s = device.session
    if (!s) throw new Error(`nobody signed in on ${device.name}`)
    this.server.session = s.staff.id
    ;(globalThis.navigator as { onLine: boolean }).onLine = device.online
    try {
      const r = await run(s.commands, s)
      return (r === undefined ? true : r) as T
    } catch (e) {
      if (!(e instanceof Error) || !e.message) throw e
      this.note({ kind: 'refused', where: `${device.name} · ${s.staff.key}`, what, detail: e instanceof Error ? e.message : String(e) })
      return undefined
    } finally {
      ;(globalThis.navigator as { onLine: boolean }).onLine = true
      // A person takes a moment between taps; the outbox sorts by occurredAt, so two operations never share a millisecond.
      this.advance(this.rand.int(800, 4000))
    }
  }
  // A manager types their PIN on this device for exactly this action (Commands.approve → the approve RPC).
  // The request goes out as the person signed in on that device.
  async approve(device: Device, approver: string, action: ApprovalAction, scope: { amount?: number; orderId?: string; lineId?: string } = {}) {
    const a = this.staff(device.outlet.key, approver), s = device.session!
    this.server.session = s.staff.id
    try { return await s.commands.approve(a.id, PIN[approver], action, scope) }
    catch (e) { this.note({ kind: 'refused', where: `${device.name} · ${s.staff.key}`, what: `approve ${action} by ${approver}`, detail: e instanceof Error ? e.message : String(e) }); return undefined }
  }

  // One sync tick on a device: the whole queue in time order, then a pull. A rejected operation halts the queue; it is
  // recorded and then discarded the way a manager does it in Lainnya → Sinkronisasi, so the rest of the day still runs
  // and later findings still surface.
  async sync(device: Device, rounds = 40) {
    const s = device.session
    if (!s || !device.online) return
    this.server.session = s.staff.id
    for (let i = 0; i < rounds; i++) {
      // Only what is queued is read: a till's outbox keeps every synced operation, thousands after two weeks.
      const queued = await s.db.outbox.where('state').anyOf('pending', 'rejected').primaryKeys()
      try { await synchronize(s.db, s.identity) } catch (e) { this.note({ kind: 'stuck', where: device.name, what: 'synchronize', detail: e instanceof Error ? e.message : String(e) }); return }
      const ops = (await s.db.outbox.bulkGet(queued)).filter((o): o is Operation => Boolean(o))
      for (const op of ops.filter((o) => o.state === 'synced' && !this.seen.has(o.id))) { this.seen.add(op.id); this.accepted.push(op) }
      const rejected = ops.filter((o) => o.state === 'rejected')
      for (const op of rejected) {
        this.note({ kind: 'rejected', where: `${device.name} · ${s.staff.key}`, what: op.kind, detail: op.error ?? '', op })
        await s.db.outbox.delete(op.id)
      }
      const pending = ops.filter((o) => o.state === 'pending')
      for (const op of pending) if (op.attempts >= 3 && !op.error?.startsWith('simulated') && !this.stuck.has(op.id)) { this.stuck.add(op.id); this.note({ kind: 'stuck', where: `${device.name} · ${s.staff.key}`, what: op.kind, detail: op.error ?? '', op }) }
      if (!pending.length) return
      // Backed off after a failure: the next tick comes once the clock passes it. The queue drains in time order, so
      // the oldest pending operation is the one that holds it.
      if (pending.length === queued.length && !rejected.length) {
        const first = pending.reduce((a, b) => (b.occurredAt < a.occurredAt ? b : a)), wait = first.nextAttempt - this.now
        if (wait > 0) this.advance(Math.min(wait + 1, 310_000))
        else if (this.stuck.has(first.id)) return
      }
    }
  }
  private seen = new Set<string>()
  private stuck = new Set<string>()
  async pending(device: Device) { return device.session ? device.session.db.outbox.where('state').anyOf('pending', 'rejected').count() : 0 }
}
