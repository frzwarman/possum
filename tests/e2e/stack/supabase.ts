// A Supabase stand-in for the browser tests: PGlite running every migration, behind the GoTrue and PostgREST subset
// this app calls. One Stack is one database. ./index.ts wires it into Playwright and documents the usage.
// Faithful where the app can tell the difference: status codes and error bodies, JWT expiry and refresh, RLS and
// EXECUTE rights as `authenticated` (with the hosted project's default grants), named RPC arguments typed by pg_proc.
// Not emulated: table writes over REST, realtime, storage, e-mail flows, rate limits.
import { PGlite, type Transaction } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, BrowserContextOptions, Page } from '@playwright/test'
import { defaultSettings, sampleMenu, stock as sampleStock } from '../../../src/domain/sample.ts'
import type { MenuItem, Role, Settings, StockItem } from '../../../src/domain/types.ts'

export const SUPABASE_URL = 'http://127.0.0.1:54321' // the e2e build's VITE_SUPABASE_URL (playwright.config.ts)
export const ANON_KEY = 'e2e-placeholder-key' // and its VITE_SUPABASE_PUBLISHABLE_KEY
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url))

// What a hosted project has before the first migration: the API roles, Supabase's default grants on public (every new
// table and function is granted to anon and authenticated until a migration revokes it), and auth.uid() reading the
// claims PostgREST sets. auth.users keeps only what sign-in needs.
const PLATFORM = `
create schema auth; create schema extensions;
create role anon nologin noinherit; create role authenticated nologin noinherit; create role service_role nologin noinherit bypassrls;
grant usage on schema public, auth, extensions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
create table auth.users(id uuid primary key, email text unique, encrypted_password text, created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(), last_sign_in_at timestamptz, banned_until timestamptz);
create function auth.uid() returns uuid language sql stable as $$
 select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
grant execute on function auth.uid() to anon, authenticated, service_role;`

export interface Person { id: string; restaurantId: string; role: Role; name: string; email: string; password: string; approvalPin?: string }
export interface Seeded { restaurantId: string; settings: Settings; users: Record<Role, Person>; office: string; extra: Person[] }
export interface SeedOptions {
  name?: string // restaurant name, also the e-mail domain: owner@ziggy-lounge.test
  settings?: Partial<Settings>
  menu?: MenuItem[] // default: the demo's sample menu
  stock?: StockItem[] // default: the demo's ingredients
  opening?: false | Record<string, number> // opening stock per stock id (thousandths); default 10 kg / 10 l / 50 pcs each
  people?: Partial<Record<Role, Partial<Pick<Person, 'name' | 'email' | 'password' | 'approvalPin'>> | false>> // false leaves a role out
  extra?: Omit<Person, 'id' | 'restaurantId'>[] // more staff (a second cashier...), returned in Seeded.extra
}
// One person per role. The password is the 6-digit PIN staff type on the shared tablet; the approval PIN is separate.
const PEOPLE: [Role, string, string, string?][] = [
  ['owner', 'Sari Pemilik', '135790', '975310'], ['manager', 'Dedi Manajer', '246802', '864213'], ['admin', 'Rani Admin', '314159', '531864'],
  ['chef', 'Yudi Chef', '271828'], ['cashier', 'Budi Kasir', '482915'], ['barista', 'Dewi Barista', '161803'], ['kitchen', 'Agus Dapur', '141421'],
  ['accountant', 'Lina Akuntan', '173205'],
]
export type Failure = 'network' | 'offline' | { status?: number; code?: string; message: string; details?: string | null; hint?: string | null }
export interface Call { key: string; method: string; url: string; user: string | null; args?: unknown; status: number; error?: string; at: number; ms?: number }
export interface Req { method: string; url: string; headers: Record<string, string>; body?: string | null }
export type Reply = { status: number; headers: Record<string, string>; body: string } | { abort: 'failed' | 'internetdisconnected' }
type Who = { role: 'anon' | 'authenticated' | 'service_role'; sub: string | null; claims: Record<string, unknown> }
type Proc = { names: string[]; types: string[]; nargs: number; ndefaults: number; set: boolean; void: boolean }

export class StackError extends Error {
  status: number; code: string; details: string | null; hint: string | null
  constructor(status: number, code: string, message: string, details: string | null = null, hint: string | null = null) {
    super(message); this.status = status; this.code = code; this.details = details; this.hint = hint
  }
}
// PostgREST's SQLSTATE → HTTP table (docs, "Errors").
export function httpStatus(code: string, anon: boolean) {
  if (code === '42501') return anon ? 401 : 403
  if (/^PT\d{3}$/.test(code)) return Number(code.slice(2))
  const exact: Record<string, number> = { '23503': 409, '23505': 409, '25006': 405, P0001: 400, '42883': 404, '42P01': 404, '42P17': 500 }
  if (exact[code]) return exact[code]
  if (/^(08|53)/.test(code)) return 503
  if (/^(0L|0P|28)/.test(code)) return 403
  if (/^54/.test(code)) return 413
  if (/^(09|25|2D|38|39|3B|40|55|57|58|F0|HV|P0|XX)/.test(code)) return 500
  return 400
}
const EXPOSE = { 'access-control-expose-headers': 'Content-Range, Range-Unit, X-Supabase-Api-Version, Content-Location, Location' }
const reply = (status: number, body?: unknown, headers: Record<string, string> = {}): Reply => ({
  status, headers: { ...EXPOSE, ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }), ...headers },
  body: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body),
})
const pgrst = (e: StackError) => reply(e.status, { code: e.code, details: e.details, hint: e.hint, message: e.message })
const gotrue = (status: number, code: string, message: string, extra: object = {}) => reply(status, { code, message, ...extra }, { 'x-supabase-api-version': '2024-01-01' })
const q = (id: string) => '"' + id.replaceAll('"', '""') + '"'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const b64 = (s: string) => Buffer.from(s).toString('base64url')

export class Stack {
  readonly db: PGlite
  // The default seed (fixture) or the first stack.seed(): the restaurant everything else refers to.
  restaurantId!: string; settings!: Settings; users!: Record<Role, Person>; office!: string; extra!: Person[]
  ttl = 3600 // seconds an access token issued from now on lives
  readonly log: Call[] = []
  readonly telegram: { user: string | null; body: unknown; reply: unknown }[] = []
  browser?: Browser // set by the fixture; newPage() needs it
  private secret = randomBytes(32)
  private sessions = new Map<string, { user: string; revoked: boolean }>()
  private refresh = new Map<string, { session: string; usedAt?: number }>()
  private expired = new Set<string>()
  private issued: string[] = []
  private rules: { match: string | ((c: Call) => boolean); failure: Failure; times: number }[] = []
  private latency = new Map<string, number>()
  private down = false
  private closed = false
  private inflight = new Set<Promise<unknown>>()
  private contexts: BrowserContext[] = []

  private constructor(db: PGlite) { this.db = db }
  // A database with the platform stub and every migration, as a dump to clone from.
  static async template(): Promise<Blob> {
    const db = await PGlite.create({ extensions: { pgcrypto } })
    await db.exec(PLATFORM)
    for (const file of (await readdir(MIGRATIONS)).filter(f => f.endsWith('.sql')).sort()) {
      try { await db.exec(await readFile(MIGRATIONS + file, 'utf8')) } catch (e) { throw new Error(`Migration ${file} failed: ${(e as Error).message}`) }
    }
    const dump = await db.dumpDataDir('none'); await db.close(); return dump
  }
  static async create(dump?: Blob) { return new Stack(await PGlite.create({ loadDataDir: dump ?? await Stack.template(), extensions: { pgcrypto } })) }
  dump() { return this.db.dumpDataDir('none') }

  // ---- test controls -------------------------------------------------------------------------------------------
  /** Superuser SQL (no RLS). */
  async sql<T = Record<string, any>>(text: string, params: unknown[] = []) { return (await this.db.query<T>(text, params)).rows }
  /** SQL as this person through PostgREST's role and claims: RLS and grants apply. */
  async sqlAs<T = Record<string, any>>(who: Person, text: string, params: unknown[] = []) {
    return this.as(this.member(who), 'POST', '/sql', async tx => (await tx.query<T>(text, params)).rows).catch(e => { throw this.pgError(e, 'authenticated') })
  }
  /** Calls an RPC as this person (null = anon) in-process, as PostgREST would; returns the parsed result or throws StackError. */
  async rpc<T = any>(who: Person | null, fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const body = await this.call(who ? this.member(who) : ANON, fn, args)
    return body === undefined ? (undefined as T) : JSON.parse(body)
  }
  /** apply_operation as this person from this device; occurredAt defaults to now. */
  apply(who: Person, deviceId: string, kind: string, payload: Record<string, unknown>, occurredAt = new Date()) {
    return this.rpc(who, 'apply_operation', { operation: { id: randomUUID(), kind, payload, actor: who.id, restaurantId: who.restaurantId, deviceId, occurredAt: occurredAt.toISOString() } })
  }
  /** Supabase requests fail as if the internet were down (the browser itself stays online). */
  offline(on = true) { this.down = on }
  /** Adds latency to every Supabase request, or to one key (see calls()). 0 clears it. */
  delay(ms: number, key = '*') { if (ms) this.latency.set(key, ms); else this.latency.delete(key) }
  /** The next `times` requests matching key (an RPC name, 'table:x', 'auth:password', 'auth:refresh_token', 'auth:user',
   *  'auth:logout', 'fn:telegram') or predicate get this failure instead of reaching the database. */
  fail(match: string | ((c: Call) => boolean), failure: Failure, { times = 1 } = {}) { this.rules.push({ match, failure, times }) }
  /** Clears fail(), delay() and offline(). */
  heal() { this.rules = []; this.latency.clear(); this.down = false }
  /** Requests the browser made, oldest first; a key filters them. */
  calls(key?: string) { return this.log.filter(c => !key || c.key === key) }
  /** Every access token issued so far is answered 401 "JWT expired" by PostgREST and GoTrue (a till clock running ahead). */
  expireTokens() { for (const t of this.issued) this.expired.add(t) }
  /** Revokes refresh tokens (all, or one person's), as signing out everywhere or deleting the session does. */
  endSessions(who?: Person) { for (const s of this.sessions.values()) if (!who || s.user === who.id) s.revoked = true }
  /** A signed access token for this person, without a session (for fetch() from a page). */
  token(who: Person, ttl = this.ttl) { return this.sign(this.claims(who.id, who.email, randomUUID(), ttl)) }
  /** Adds a person to a restaurant with a password (and an approval PIN for owner, manager, admin). */
  async addPerson(restaurantId: string, p: Omit<Person, 'id' | 'restaurantId'> & { id?: string }): Promise<Person> {
    const person: Person = { ...p, id: p.id ?? randomUUID(), restaurantId, email: p.email.toLowerCase() }
    await this.db.query(`insert into auth.users(id, email, encrypted_password) values ($1, $2, extensions.crypt($3, extensions.gen_salt('bf', 4)))`, [person.id, person.email, person.password])
    await this.db.query(`insert into public.memberships(restaurant_id, user_id, role, name, active, login) values ($1, $2, $3, $4, true, $5)`, [restaurantId, person.id, person.role, person.name, person.email])
    if (person.approvalPin) await this.rpc(person, 'set_approval_pin', { pin: person.approvalPin })
    return person
  }
  /** A restaurant with settings, one person per role, a back-office device and the catalog with opening stock, all
   *  through apply_operation as the owner. The first seed also fills stack.users, restaurantId, settings and office. */
  async seed(o: SeedOptions = {}): Promise<Seeded> {
    const restaurantId = randomUUID(), name = o.name ?? 'Ziggy Lounge', domain = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'resto'
    const settings: Settings = { ...defaultSettings, name, ...o.settings }
    await this.db.query('insert into public.restaurants(id, settings) values ($1, $2)', [restaurantId, settings])
    const users = {} as Record<Role, Person>
    for (const [role, person, password, approvalPin] of PEOPLE) {
      const over = o.people?.[role]; if (over === false) continue
      users[role] = await this.addPerson(restaurantId, { role, name: person, email: `${role}@${domain}.test`, password, approvalPin, ...over })
    }
    const extra: Person[] = []
    for (const p of o.extra ?? []) extra.push(await this.addPerson(restaurantId, p))
    const owner = users.owner, office = randomUUID(), menu = o.menu ?? sampleMenu, stock = o.stock ?? sampleStock
    if (!owner) throw new Error('seed: the owner publishes the catalog, keep people.owner')
    await this.rpc(owner, 'enroll_device', { device_id: office, mode: 'office' })
    await this.apply(owner, office, 'catalog.publish', { menu, stock })
    for (const s of stock) {
      const qty = o.opening === false ? 0 : o.opening?.[s.id] ?? (s.unit === 'pcs' ? 50_000 : 10_000_000)
      if (qty > 0) await this.apply(owner, office, 'stock.record', { stockId: s.id, kind: 'opening', qty, reason: 'Saldo awal uji', cost: 0, fromDrawer: false })
    }
    const seeded = { restaurantId, settings, users, office, extra }
    if (!this.restaurantId) Object.assign(this, seeded)
    return seeded
  }

  // ---- browser wiring ------------------------------------------------------------------------------------------
  /** Routes a context's (or page's) Supabase requests to this stack. */
  async attach(target: BrowserContext | Page) {
    // context.setOffline(true) does not reach a route handler that answers by itself: follow it here (HARNESS-01).
    const context = 'setOffline' in target ? target : target.context(), setOffline = context.setOffline.bind(context); let down = false
    context.setOffline = async (offline: boolean) => { down = offline; return setOffline(offline) }
    await target.route(SUPABASE_URL + '/**', async route => {
      if (this.closed) return route.abort('failed').catch(() => undefined)
      if (down) return route.abort('internetdisconnected').catch(() => undefined)
      const r = route.request()
      const job = (async () => {
        const res = await this.handle({ method: r.method(), url: r.url(), headers: await r.allHeaders(), body: r.postData() })
        await ('abort' in res ? route.abort(res.abort) : route.fulfill(res))
      })().catch(() => route.abort('failed').catch(() => undefined))
      this.inflight.add(job); await job; this.inflight.delete(job)
    })
  }
  /** Another device on the same database: a new context (the test's options, plus these) with its own page. */
  async newPage(options: BrowserContextOptions = {}) {
    if (!this.browser) throw new Error('stack.newPage needs the fixture (stack.browser)')
    const context = await this.browser.newContext(options); this.contexts.push(context)
    await context.addInitScript(() => { Object.assign(window, { __prints: 0 }); window.print = () => { (window as unknown as { __prints: number }).__prints++ } })
    await this.attach(context)
    return context.newPage()
  }
  async close() {
    this.closed = true
    await Promise.allSettled([...this.inflight])
    await Promise.allSettled(this.contexts.map(c => c.close()))
    await this.db.close()
  }

  // ---- HTTP ----------------------------------------------------------------------------------------------------
  async handle(req: Req): Promise<Reply> {
    const url = new URL(req.url), headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]))
    const call: Call = { key: keyOf(url), method: req.method, url: req.url, user: subOf(headers.authorization), status: 0, at: Date.now() }
    try { call.args = req.body ? JSON.parse(req.body) : Object.fromEntries(url.searchParams) } catch { call.args = req.body }
    this.log.push(call)
    const wait = this.latency.get(call.key) ?? this.latency.get('*'); if (wait) await sleep(wait)
    if (this.down) { call.error = 'offline'; return { abort: 'internetdisconnected' } }
    const rule = this.rules.find(r => r.times > 0 && (typeof r.match === 'string' ? r.match === call.key : r.match(call)))
    let res: Reply
    if (rule) {
      rule.times--; const f = rule.failure
      if (f === 'network' || f === 'offline') { call.error = f; return { abort: f === 'network' ? 'failed' : 'internetdisconnected' } }
      const code = f.code ?? 'P0001'
      res = call.key.startsWith('auth:') ? gotrue(f.status ?? 400, code, f.message) : pgrst(new StackError(f.status ?? httpStatus(code, false), code, f.message, f.details ?? null, f.hint ?? null))
    } else res = await this.serve(req.method, url, headers, req.body ?? '')
    if ('status' in res) { call.status = res.status; if (res.status >= 400) call.error = errorOf(res.body) }
    call.ms = Date.now() - call.at
    return res
  }
  private async serve(method: string, url: URL, h: Record<string, string>, body: string): Promise<Reply> {
    // The API gateway checks the key before anything else.
    if (!h.apikey) return reply(401, { message: 'No API key found in request', hint: 'No `apikey` request header or url param was found.' })
    if (h.apikey !== ANON_KEY) return reply(401, { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' })
    const path = url.pathname
    try {
      if (path.startsWith('/auth/v1/')) return await this.auth(method, path.slice(9), url, h, body)
      if (path.startsWith('/functions/v1/')) return await this.edge(path.slice(14), h, body)
      if (!path.startsWith('/rest/v1/')) return reply(404, { message: 'no Route matched with those values' })
      const who = this.bearer(h); if ('status' in who) return who
      if (path.startsWith('/rest/v1/rpc/')) {
        if (method !== 'POST') return pgrst(new StackError(405, 'PGRST101', 'Only POST is emulated for functions'))
        let args: unknown; try { args = body ? JSON.parse(body) : {} } catch { return pgrst(new StackError(400, 'PGRST102', 'Empty or invalid json')) }
        if (!args || typeof args !== 'object' || Array.isArray(args)) return pgrst(new StackError(400, 'PGRST102', 'Expected a JSON object of named arguments'))
        const out = await this.call(who, decodeURIComponent(path.slice(13)), args as Record<string, unknown>)
        return out === undefined ? reply(204) : reply(200, out)
      }
      if (method !== 'GET' && method !== 'HEAD') return pgrst(new StackError(501, 'PGRST000', `stack emulator: ${method} on tables is not emulated (the app only reads tables); use stack.sqlAs()`))
      return await this.select(who, method, decodeURIComponent(path.slice(9)), url.searchParams, h)
    } catch (e) { return pgrst(e instanceof StackError ? e : this.pgError(e, 'authenticated')) }
  }
  // PostgREST's view of the Authorization header: none or the API key is anon, a valid JWT carries its role and claims.
  private bearer(h: Record<string, string>): Who | Reply {
    const token = /^bearer\s+(.+)$/i.exec(h.authorization ?? '')?.[1]
    if (!token || token === ANON_KEY) return ANON
    const c = this.verify(token)
    if (c === 'expired') return reply(401, { code: 'PGRST303', details: null, hint: null, message: 'JWT expired' }, { 'www-authenticate': 'Bearer error="invalid_token", error_description="JWT expired"' })
    if (c === 'invalid' || !['anon', 'authenticated', 'service_role'].includes(c.role as string)) return reply(401, { code: 'PGRST301', details: null, hint: null, message: 'JWSError JWSInvalidSignature' }, { 'www-authenticate': 'Bearer error="invalid_token"' })
    return { role: c.role as Who['role'], sub: typeof c.sub === 'string' ? c.sub : null, claims: c }
  }

  // ---- PostgREST -----------------------------------------------------------------------------------------------
  // POST /rpc/fn with named arguments: the overload whose names fit, arguments typed from pg_proc through
  // json_to_record as PostgREST does, inside one transaction as the caller's role with their claims.
  private async call(who: Who, fn: string, args: Record<string, unknown>): Promise<string | undefined> {
    const keys = Object.keys(args).sort()
    const { rows } = await this.db.query<{ names: string[]; types: string[]; nargs: number; ndefaults: number; set: boolean; void: boolean }>(
      `select p.pronargs as nargs, p.pronargdefaults as ndefaults, p.proretset as set, p.prorettype = 'void'::regtype as void,
        array(select a.n from unnest(coalesce(p.proargnames, array_fill(''::text, array[p.pronargs])), coalesce(p.proargmodes, array_fill('i'::"char", array[p.pronargs]))) with ordinality a(n, m, i) where a.m in ('i', 'b', 'v') order by a.i) as names,
        array(select format_type(t.oid, null) from unnest(p.proargtypes) with ordinality t(oid, i) order by t.i) as types
       from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1 and p.prokind = 'f'`, [fn])
    const fits: Proc[] = rows.filter(c => keys.every(k => c.names.includes(k)) && c.names.slice(0, c.nargs - c.ndefaults).every(n => keys.includes(n)))
    if (!fits.length) throw new StackError(404, 'PGRST202', `Could not find the function public.${fn}(${keys.join(', ')}) in the schema cache`, `Searched for the function public.${fn} with parameters ${keys.join(', ')} or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.`)
    if (fits.length > 1) throw new StackError(300, 'PGRST203', `Could not choose the best candidate function between: ${fits.map(c => `public.${fn}(${c.names.map((n, i) => `${n} => ${c.types[i]}`).join(', ')})`).join(', ')}`)
    const c = fits[0], used = c.names.filter(n => keys.includes(n))
    const record = `json_to_record($1::json) as _a(${used.map(n => `${q(n)} ${c.types[c.names.indexOf(n)]}`).join(', ')})`
    const invoke = `public.${q(fn)}(${used.map(n => `${q(n)} := _a.${q(n)}`).join(', ')})`, from = used.length ? ` from ${record}` : ''
    const sql = c.void ? `select ${invoke}${from}`
      : c.set ? `select coalesce(json_agg(_r), '[]')::text as body from ${used.length ? `${record}, lateral ${invoke} _r` : `${invoke} _r`}`
      : `select to_json(${invoke})::text as body${from}`
    try {
      return await this.as(who, 'POST', `/rpc/${fn}`, async tx => {
        const r = await tx.query<{ body: string | null }>(sql, used.length ? [JSON.stringify(args)] : [])
        return c.void ? undefined : r.rows[0]?.body ?? 'null'
      })
    } catch (e) { throw this.pgError(e, who.role) }
  }
  // GET/HEAD /table: select=, eq/neq/gt/gte/lt/lte/like/ilike/is/in filters (not. too), order=, limit=, offset=,
  // Prefer: count=exact → Content-Range, Accept: vnd.pgrst.object+json → one object or 406. Runs under RLS.
  private async select(who: Who, method: string, table: string, params: URLSearchParams, h: Record<string, string>): Promise<Reply> {
    const { rows: cols } = await this.db.query<{ name: string; type: string }>(
      `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type from pg_attribute a join pg_class c on c.oid = a.attrelid
       where c.relnamespace = 'public'::regnamespace and c.relname = $1 and c.relkind in ('r', 'v', 'm', 'p', 'f') and a.attnum > 0 and not a.attisdropped order by a.attnum`, [table])
    if (!cols.length) throw new StackError(404, 'PGRST205', `Could not find the table 'public.${table}' in the schema cache`)
    const type = new Map(cols.map(c => [c.name, c.type])), args: string[] = []
    const column = (name: string) => { if (!type.has(name)) throw new StackError(400, '42703', `column ${table}.${name} does not exist`); return q(name) }
    const arg = (v: string, as: string) => { args.push(v); return `cast($${args.length}::text as ${as})` }
    const pick = (params.get('select') ?? '*').split(',').filter(Boolean).map(c => c === '*' ? '*' : column(c)).join(', ') || '*'
    const where: string[] = []
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'offset', 'columns'].includes(k)) continue
      const m = /^(not\.)?(eq|neq|gt|gte|lt|lte|like|ilike|is|in)\.([\s\S]*)$/.exec(v)
      if (!m) throw new StackError(400, 'PGRST100', `"failed to parse filter (${v})" (line 1, column 1)`)
      const [, not, op, value] = m, col = column(k), t = type.get(k)!
      let cond: string
      if (op === 'is') { if (!/^(null|true|false|unknown)$/i.test(value)) throw new StackError(400, 'PGRST100', `"failed to parse filter (${v})"`); cond = `${col} is ${value.toLowerCase()}` }
      else if (op === 'in') {
        const list = /^\(([\s\S]*)\)$/.exec(value)?.[1]; if (list === undefined) throw new StackError(400, 'PGRST100', `"failed to parse filter (${v})"`)
        const items = [...list.matchAll(/"((?:[^"\\]|\\.)*)"|([^,]+)/g)].map(x => x[1] !== undefined ? x[1].replace(/\\(.)/g, '$1') : x[2])
        cond = items.length ? `${col} in (${items.map(x => arg(x, t)).join(', ')})` : 'false'
      } else if (op === 'like' || op === 'ilike') cond = `${col}::text ${op} ${arg(value.replaceAll('*', '%'), 'text')}`
      else cond = `${col} ${{ eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op]} ${arg(value, t)}`
      where.push(not ? `not (${cond})` : cond)
    }
    const order = (params.get('order') ?? '').split(',').filter(Boolean).map(o => {
      const [c, ...mods] = o.split('.')
      return [column(c), ...mods.map(x => ({ asc: 'asc', desc: 'desc', nullsfirst: 'nulls first', nullslast: 'nulls last' } as Record<string, string>)[x] ?? (() => { throw new StackError(400, 'PGRST100', `"failed to parse order (${o})"`) })())].join(' ')
    })
    const int = (k: string) => { const v = params.get(k); if (v === null) return null; if (!/^\d+$/.test(v)) throw new StackError(400, 'PGRST100', `"failed to parse ${k} (${v})"`); return Number(v) }
    const limit = Math.min(int('limit') ?? 1000, 1000), offset = int('offset') ?? 0 // hosted PostgREST: max-rows 1000
    const filter = `from public.${q(table)}${where.length ? ` where ${where.join(' and ')}` : ''}`
    const counting = /count=(exact|planned|estimated)/.test(h.prefer ?? ''), single = (h.accept ?? '').includes('application/vnd.pgrst.object+json')
    try {
      return await this.as(who, method, `/${table}`, async tx => {
        const body = (await tx.query<{ body: string }>(`select coalesce(json_agg(_t), '[]')::text as body from (select ${pick} ${filter}${order.length ? ` order by ${order.join(', ')}` : ''} limit ${limit} offset ${offset}) _t`, args)).rows[0].body
        const found = (JSON.parse(body) as unknown[]).length
        const total = counting ? (await tx.query<{ n: number }>(`select count(*)::int as n ${filter}`, args)).rows[0].n : null
        const range = { 'content-range': `${found ? `${offset}-${offset + found - 1}` : '*'}/${total ?? '*'}` }
        if (single) {
          if (found !== 1) return reply(406, { code: 'PGRST116', details: `The result contains ${found} rows`, hint: null, message: 'JSON object requested, multiple (or no) rows returned' })
          return reply(200, method === 'HEAD' ? '' : JSON.stringify((JSON.parse(body) as unknown[])[0]), { ...range, 'content-type': 'application/vnd.pgrst.object+json; charset=utf-8' })
        }
        return reply(200, method === 'HEAD' ? '' : body, range)
      })
    } catch (e) { throw this.pgError(e, who.role) }
  }
  // One transaction as PostgREST runs a request: the role from the JWT and its claims as settings.
  private as<T>(who: Who, method: string, path: string, run: (tx: Transaction) => Promise<T>) {
    return this.db.transaction(async tx => {
      await tx.query(`select set_config('role', $1, true), set_config('request.jwt.claims', $2, true), set_config('request.jwt.claim.sub', $3, true), set_config('request.method', $4, true), set_config('request.path', $5, true)`,
        [who.role, JSON.stringify(who.claims), who.sub ?? '', method, path])
      return run(tx)
    })
  }
  private pgError(e: unknown, role: Who['role']) {
    if (e instanceof StackError) return e
    const x = e as { code?: string; message?: string; detail?: string; hint?: string }, code = x.code ?? 'XX000'
    return new StackError(httpStatus(code, role === 'anon'), code, x.message ?? String(e), x.detail ?? null, x.hint ?? null)
  }

  // ---- GoTrue --------------------------------------------------------------------------------------------------
  private async auth(method: string, path: string, url: URL, h: Record<string, string>, raw: string): Promise<Reply> {
    let body: Record<string, any> = {}; try { body = raw ? JSON.parse(raw) : {} } catch { return gotrue(400, 'bad_json', 'Could not parse request body as JSON') }
    if (path === 'token' && method === 'POST') {
      const grant = url.searchParams.get('grant_type')
      if (grant === 'password') {
        if (!body.email || !body.password) return gotrue(400, 'validation_failed', 'missing email or phone')
        const [user] = await this.sql<{ id: string; email: string }>(`select id, email from auth.users where email = lower($1) and encrypted_password = extensions.crypt($2, encrypted_password) and (banned_until is null or banned_until < now())`, [body.email, body.password])
        if (!user) return gotrue(400, 'invalid_credentials', 'Invalid login credentials', { error: 'invalid_grant', error_description: 'Invalid login credentials' })
        await this.db.query('update auth.users set last_sign_in_at = now() where id = $1', [user.id])
        const session = randomUUID(); this.sessions.set(session, { user: user.id, revoked: false })
        return this.issue(user.id, session)
      }
      if (grant === 'refresh_token') {
        const entry = this.refresh.get(body.refresh_token ?? ''), session = entry && this.sessions.get(entry.session)
        if (!entry || !session || session.revoked) return gotrue(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found', { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Refresh Token Not Found' })
        // GoTrue lets a rotated token be used again for 10 s (concurrent tabs); after that it is reuse and ends the session.
        if (entry.usedAt && Date.now() - entry.usedAt > 10_000) { session.revoked = true; return gotrue(400, 'refresh_token_already_used', 'Invalid Refresh Token: Already Used', { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Already Used' }) }
        entry.usedAt ??= Date.now()
        return this.issue(session.user, entry.session)
      }
      return gotrue(400, 'validation_failed', `unsupported_grant_type: ${grant}`)
    }
    const token = /^bearer\s+(.+)$/i.exec(h.authorization ?? '')?.[1] ?? '', c = this.verify(token)
    const signedIn = typeof c === 'object' && typeof c.sub === 'string' && typeof c.session_id === 'string' ? c as { sub: string; session_id: string } : null
    if (path === 'logout' && method === 'POST') {
      if (!signedIn) return gotrue(401, 'bad_jwt', 'invalid JWT: unable to parse or verify signature, token is expired or invalid')
      const scope = url.searchParams.get('scope') ?? 'global'
      for (const [id, s] of this.sessions) if (s.user === signedIn.sub && (scope === 'global' || (scope === 'local') === (id === signedIn.session_id))) s.revoked = true
      return reply(204)
    }
    if (path === 'user' && (method === 'GET' || method === 'PUT')) {
      if (!signedIn) return gotrue(401, 'bad_jwt', `invalid JWT: unable to parse or verify signature, ${c === 'expired' ? 'token has invalid claims: token is expired' : 'signature is invalid'}`)
      if (this.sessions.get(signedIn.session_id)?.revoked !== false) return gotrue(403, 'session_not_found', 'Session from session_id claim in JWT does not exist')
      if (method === 'PUT' && body.password !== undefined) {
        if (typeof body.password !== 'string' || body.password.length < 6) return gotrue(422, 'weak_password', 'Password should be at least 6 characters.', { weak_password: { reasons: ['length'] } })
        const [same] = await this.sql(`select 1 from auth.users where id = $1 and encrypted_password = extensions.crypt($2, encrypted_password)`, [signedIn.sub, body.password])
        if (same) return gotrue(422, 'same_password', 'New password should be different from the old password.')
        await this.db.query(`update auth.users set encrypted_password = extensions.crypt($2, extensions.gen_salt('bf', 4)), updated_at = now() where id = $1`, [signedIn.sub, body.password])
      }
      const user = await this.user(signedIn.sub); return user ? reply(200, user) : gotrue(403, 'user_not_found', 'User from sub claim in JWT does not exist')
    }
    return gotrue(404, 'not_found', `stack emulator: ${method} /auth/v1/${path} is not emulated`)
  }
  private async issue(sub: string, session: string): Promise<Reply> {
    const user = await this.user(sub), refresh = randomBytes(9).toString('base64url'), claims = this.claims(sub, user!.email as string, session, this.ttl)
    this.refresh.set(refresh, { session })
    return reply(200, { access_token: this.sign(claims), token_type: 'bearer', expires_in: this.ttl, expires_at: claims.exp, refresh_token: refresh, user })
  }
  private async user(id: string) {
    const [u] = await this.sql<{ id: string; email: string; created_at: Date; updated_at: Date; last_sign_in_at: Date | null }>('select id, email, created_at, updated_at, last_sign_in_at from auth.users where id = $1', [id])
    return u && { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: u.created_at, phone: '', confirmed_at: u.created_at, last_sign_in_at: u.last_sign_in_at, app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [], created_at: u.created_at, updated_at: u.updated_at, is_anonymous: false }
  }
  private claims(sub: string, email: string, session: string, ttl: number) {
    const now = Math.floor(Date.now() / 1000)
    return { aud: 'authenticated', exp: now + ttl, iat: now, iss: `${SUPABASE_URL}/auth/v1`, sub, email, phone: '', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, role: 'authenticated', aal: 'aal1', amr: [{ method: 'password', timestamp: now }], session_id: session, is_anonymous: false }
  }
  private member(p: Person): Who { return { role: 'authenticated', sub: p.id, claims: this.claims(p.id, p.email, 'stack', this.ttl) } }
  private sign(claims: object) {
    const body = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify(claims))}`, token = `${body}.${createHmac('sha256', this.secret).update(body).digest('base64url')}`
    this.issued.push(token); return token
  }
  private verify(token: string): Record<string, unknown> | 'invalid' | 'expired' {
    const [h, p, s] = token.split('.')
    if (!s || createHmac('sha256', this.secret).update(`${h}.${p}`).digest('base64url') !== s) return 'invalid'
    let c: Record<string, unknown>; try { c = JSON.parse(Buffer.from(p, 'base64url').toString()) } catch { return 'invalid' }
    return typeof c.exp !== 'number' || c.exp * 1000 <= Date.now() || this.expired.has(token) ? 'expired' : c
  }

  // ---- Edge function -------------------------------------------------------------------------------------------
  // /functions/v1/telegram from the till: as the deployed function, it files the request as the signed-in person
  // (request_approval) and counts the owners and managers it would message; no Telegram call leaves the machine.
  private async edge(name: string, h: Record<string, string>, raw: string): Promise<Reply> {
    if (name !== 'telegram') return reply(404, { code: 'NOT_FOUND', message: 'Requested function was not found' })
    let body: Record<string, any> = {}; try { body = JSON.parse(raw || '{}') } catch { /* the function would fail on req.json() too */ }
    const who = this.bearer(h), user = 'status' in who ? null : who.sub, entry = { user, body, reply: undefined as unknown }; this.telegram.push(entry)
    if ('status' in who || !user) return (entry.reply = { error: 'Unauthorized' }, reply(401, entry.reply))
    try {
      const id = JSON.parse((await this.call(who, 'request_approval', { action: body.action, order_id: body.orderId ?? null, amount: body.amount ?? null, what: body.what }))!)
      const [r] = await this.sql<{ r: { chats?: number[] } | null }>('select public.telegram_request($1) as r', [id])
      entry.reply = { id, sent: r?.r?.chats?.length ?? 0 }; return reply(200, entry.reply)
    } catch (e) { entry.reply = { error: (e as Error).message }; return reply(400, entry.reply) }
  }
}
const ANON: Who = { role: 'anon', sub: null, claims: { role: 'anon' } }
function keyOf(url: URL) {
  const p = url.pathname
  if (p.startsWith('/rest/v1/rpc/')) return decodeURIComponent(p.slice(13))
  if (p.startsWith('/rest/v1/')) return 'table:' + decodeURIComponent(p.slice(9))
  if (p === '/auth/v1/token') return 'auth:' + (url.searchParams.get('grant_type') ?? 'token')
  if (p.startsWith('/auth/v1/')) return 'auth:' + p.slice(9)
  if (p.startsWith('/functions/v1/')) return 'fn:' + p.slice(14)
  return p
}
function subOf(authorization?: string) {
  try { const sub = JSON.parse(Buffer.from((authorization ?? '').split('.')[1] ?? '', 'base64url').toString()).sub; return typeof sub === 'string' ? sub : null } catch { return null }
}
function errorOf(body: string) { try { const b = JSON.parse(body); return b.message ?? b.msg ?? b.error ?? body } catch { return body } }
