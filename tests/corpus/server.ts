import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
// The real server: every migration in supabase/migrations on PGlite (Postgres 17 in WASM), with the auth schema
// stubbed the way scripts/test-db.mjs does it. PGlite reads the clock through Date.now(), so a test that fakes Date
// moves the server's now() along with the till's.
//
// `client` stands in for supabase-js: rpc() calls the function as the signed-in person (role authenticated, auth.uid()
// from request.jwt.claim.sub, RLS and grants in force), from() runs the few table reads the app makes, and
// auth.getSession() answers with whoever `session` holds. Errors come back as PostgREST shapes them: {code, message}.
export type Pg = PGlite
const ROOT = new URL('../../', import.meta.url).pathname
export async function createDatabase() {
  const pg = new PGlite({ extensions: { pgcrypto } })
  await pg.exec(`create schema auth;create schema extensions;create role anon;create role authenticated;create role service_role;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`)
  for (const file of (await readdir(ROOT + 'supabase/migrations')).sort()) await pg.exec(await readFile(ROOT + 'supabase/migrations/' + file, 'utf8'))
  return pg
}

export interface PgError { code: string; message: string; details?: string; hint?: string }
const fail = (e: unknown): PgError => { const x = e as { code?: string; message?: string; detail?: string; hint?: string }; return { code: x.code ?? 'PGRST000', message: x.message ?? String(e), details: x.detail, hint: x.hint } }

export class Server {
  session: string | null = null
  // A hook for the transport: lets a test lose the answer to an operation the server committed.
  afterRpc?: (name: string, args: Record<string, unknown>) => PgError | undefined
  calls = 0
  private signatures = new Map<string, Map<string, string>>()
  constructor(public pg: Pg) {}
  // Runs as the superuser: provisioning and test introspection, the way the hosted project's service role would.
  async admin<T = Record<string, unknown>>(sql: string, params: unknown[] = []) { await this.pg.exec('reset role'); return (await this.pg.query<T>(sql, params)).rows }
  private async as(user: string | null) {
    await this.pg.exec('reset role')
    await this.pg.query("select set_config('request.jwt.claim.sub',$1,false)", [user ?? ''])
    await this.pg.exec(`set role ${user ? 'authenticated' : 'anon'}`)
  }
  private async signature(name: string) {
    let s = this.signatures.get(name)
    if (!s) {
      const rows = await this.admin<{ names: string[] | null; types: string[] }>("select p.proargnames as names,array(select format_type(t,null) from unnest(p.proargtypes::oid[]) t) as types from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1", [name])
      if (rows.length !== 1) throw new Error(`rpc ${name}: ${rows.length} functions`)
      s = new Map((rows[0].names ?? []).map((n, i) => [n, rows[0].types[i]]))
      this.signatures.set(name, s)
    }
    return s
  }
  // PostgREST calls a function by its argument names; supabase-js sends them as JSON.
  async rpc(name: string, args: Record<string, unknown> = {}): Promise<{ data: any; error: PgError | null }> {
    this.calls++
    try {
      const sig = await this.signature(name), names = Object.keys(args).filter((k) => args[k] !== undefined)
      for (const n of names) if (!sig.has(n)) throw Object.assign(new Error(`Could not find the function public.${name}(${names.join(', ')})`), { code: 'PGRST202' })
      await this.as(this.session)
      const sql = `select public.${name}(${names.map((n, i) => `${n} => $${i + 1}::${sig.get(n)}`).join(',')}) as r`
      const rows = (await this.pg.query<{ r: unknown }>(sql, names.map((n) => (args[n] === null || typeof args[n] === 'boolean' ? args[n] : typeof args[n] === 'object' ? JSON.stringify(args[n]) : String(args[n]))))).rows
      const lost = this.afterRpc?.(name, args)
      if (lost) return { data: null, error: lost }
      return { data: rows[0]?.r ?? null, error: null }
    } catch (e) {
      return { data: null, error: fail(e) }
    } finally {
      await this.pg.exec('reset role')
    }
  }
  // The table reads the app makes through supabase-js: select, eq, in, order, maybeSingle, count/head.
  from(table: string) { return new Select(this, table) }
  async read(table: string, cols: string, where: [string, string, unknown][], order: string | undefined, count: boolean) {
    try {
      await this.as(this.session)
      const params: unknown[] = []
      const conds = where.map(([col, op, v]) => { params.push(op === 'in' ? JSON.stringify(v) : String(v)); return op === 'in' ? `${col}::text = any(array(select jsonb_array_elements_text($${params.length}::jsonb)))` : `${col}::text = $${params.length}` })
      const sql = `select ${count ? 'count(*)::int as n' : cols} from public.${table}${conds.length ? ' where ' + conds.join(' and ') : ''}${order && !count ? ` order by ${order}` : ''}`
      return { rows: (await this.pg.query<Record<string, unknown>>(sql, params)).rows, error: null }
    } catch (e) {
      return { rows: [], error: fail(e) }
    } finally {
      await this.pg.exec('reset role')
    }
  }
  // supabase-js, as far as src/ uses it.
  client() {
    return {
      rpc: (name: string, args?: Record<string, unknown>) => this.rpc(name, args),
      from: (table: string) => this.from(table),
      auth: {
        getSession: async () => ({ data: { session: this.session ? { user: { id: this.session }, access_token: 'test' } : null }, error: null }),
        signOut: async () => { this.session = null; return { error: null } },
        signInWithPassword: async () => ({ data: { user: null, session: null }, error: { message: 'Not in the contract harness' } }),
      },
      functions: { invoke: async () => ({ data: null, error: { message: 'No edge functions in the contract harness' } }) },
    }
  }
}
class Select implements PromiseLike<{ data: any; error: PgError | null; count?: number | null }> {
  private cols = '*'; private where: [string, string, unknown][] = []; private orderBy?: string; private count = false; private single = false
  constructor(private server: Server, private table: string) {}
  select(cols = '*', options?: { count?: string; head?: boolean }) { this.cols = cols; this.count = Boolean(options?.head && options.count); return this }
  eq(col: string, v: unknown) { this.where.push([col, 'eq', v]); return this }
  in(col: string, v: unknown[]) { this.where.push([col, 'in', v]); return this }
  order(col: string, o?: { ascending?: boolean }) { this.orderBy = `${col}${o?.ascending === false ? ' desc' : ''}`; return this }
  maybeSingle() { this.single = true; return this }
  then<A = { data: any; error: PgError | null; count?: number | null }, B = never>(ok?: ((v: { data: any; error: PgError | null; count?: number | null }) => A | PromiseLike<A>) | null, no?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return this.server.read(this.table, this.cols, this.where, this.orderBy, this.count).then(({ rows, error }) => {
      if (error) return { data: null, error, count: null }
      if (this.count) return { data: null, error: null, count: rows[0].n as number }
      return { data: this.single ? (rows[0] ?? null) : rows, error: null }
    }).then(ok, no)
  }
}
