// @vitest-environment node
// The client-server contract on a realistic corpus (tests/corpus): Ziggy Lounge and its Dago outlet trading through
// the real Commands on every device and role, synced by the real synchronize() into every migration on PGlite, with
// a shared simulated clock. Default: one day, under a minute. CORPUS=full: fourteen days at 150–250 orders a day.
//   pnpm vitest run tests/unit/contract.test.ts
//   CORPUS=full pnpm vitest run tests/unit/contract.test.ts
import { appendFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ client: {} as Record<string, unknown> }))
vi.mock('../../src/lib/supabase', () => ({ configured: true, telegramBot: '', supabase: h.client }))
import { menu } from '../corpus/catalog'
import { FULL, Lounge, QUICK, wib } from '../corpus/trade'
import * as verify from '../corpus/verify'
import { World, type Finding } from '../corpus/world'

// CORPUS_SEED=<n> trades a different fortnight (or day) with the same rules.
const plan = { ...(process.env.CORPUS === 'full' ? FULL : QUICK), ...(process.env.CORPUS_SEED && { seed: Number(process.env.CORPUS_SEED) }) }
let world: World, lounge: Lounge
const show = (fs: Finding[]) => fs.map((f) => `${f.at} ${f.where} ${f.what}: ${f.detail}`)
beforeAll(async () => {
  world = await World.create(h.client, plan.seed, wib(plan.start, '05:00'))
  world.lossRate = plan.loss
  lounge = new Lounge(world, plan)
  await lounge.setup()
  // CORPUS_LOG=<file> notes each finished day there, for following a long run.
  for (let i = 0; i < plan.days; i++) { await lounge.day(i); if (process.env.CORPUS_LOG) appendFileSync(process.env.CORPUS_LOG, `${new Date().toISOString()} ${lounge.days[i]}: ${world.accepted.length} operations, ${world.findings.length} findings\n`) }
  for (const d of world.devices.values()) await world.sync(d)
  // From here on the network is reliable: the checks read and resend, they do not simulate.
  world.lossRate = 0
}, plan.days * 900_000 + 120_000)
afterAll(() => vi.useRealTimers())

describe(`contract: ${plan.days} day(s) of Ziggy Lounge (seed ${plan.seed}) through apply_operation`, () => {
  it('sends a realistic volume through every kind of operation', () => {
    const kinds = new Map<string, number>()
    for (const op of world.accepted) kinds.set(op.kind, (kinds.get(op.kind) ?? 0) + 1)
    for (const k of ['shift.open', 'shift.close', 'shift.cash', 'order.save', 'order.prepare', 'order.ready', 'payment.record', 'order.void', 'stock.record', 'catalog.publish', 'catalog.remove', 'purchase.save', 'purchase.receive', 'production.record', 'supplier.save', 'salesorder.save', 'salesorder.pay', 'transfer.send', 'count.record', 'count.submit'])
      expect(kinds.get(k) ?? 0, k).toBeGreaterThan(0)
    expect(world.accepted.length).toBeGreaterThan(plan.days * plan.orders[0] * 2)
  })
  it('turns down no operation the app sent (a rejection halts that device)', () => expect(show(world.findings.filter((f) => f.kind === 'rejected'))).toEqual([]))
  it('leaves no operation stuck in an outbox', () => expect(show(world.findings.filter((f) => f.kind === 'stuck'))).toEqual([]))
  it('refuses no command the restaurant was entitled to run', () => expect(show(world.findings.filter((f) => f.kind === 'refused'))).toEqual([]))
  it('prices every order on the till as the corpus does, and keeps stock as the corpus does', () => expect(show(world.findings.filter((f) => f.kind === 'mismatch'))).toEqual([]))
  it('books every order, payment and refund on the server as the restaurant took them', async () => {
    expect(await verify.orders(world, lounge.oracle, lounge.ziggy)).toEqual([])
    expect(await verify.orders(world, lounge.oracle, lounge.dago)).toEqual([])
  }, 300_000)
  it('closes every shift on what was counted: drawer, cash moved and each EDC slip', async () => {
    expect(await verify.shifts(world, lounge.oracle, lounge.ziggy, lounge.oracle.settings.get('ziggy')!.edcs ?? [])).toEqual([])
    expect(await verify.shifts(world, lounge.oracle, lounge.dago, [])).toEqual([])
  }, 300_000)
  it('reports each day and the whole range as sold (sales_report)', async () => {
    const out: string[] = []
    for (const day of lounge.days) out.push(...(await verify.salesReport(world, lounge.oracle, lounge.ziggy, 'manager', day, day)))
    out.push(...(await verify.salesReport(world, lounge.oracle, lounge.ziggy, 'manager', lounge.days[0], lounge.days.at(-1)!)))
    out.push(...(await verify.salesReport(world, lounge.oracle, lounge.dago, 'manager2', lounge.days[0], lounge.days.at(-1)!)))
    expect(out).toEqual([])
  }, 300_000)
  it('gives the accountant the books as they happened (accounting_data), and they balance', async () => {
    const out: string[] = [], z = menu(), from = lounge.days[0], to = lounge.days.at(-1)!
    out.push(...(await verify.accounting(world, lounge.oracle, lounge.ziggy, 'maya', from, to, z)))
    if (lounge.days.length > 2) out.push(...(await verify.accounting(world, lounge.oracle, lounge.ziggy, 'owner', lounge.days[1], lounge.days[2], z)))
    out.push(...(await verify.accounting(world, lounge.oracle, lounge.dago, 'owner2', from, to, z)))
    expect(out).toEqual([])
  }, 300_000)
  it("leaves every device holding the server's state after its last pull", async () => expect(await verify.pulled(world)).toEqual([]), 300_000)
  it('answers every operation sent again with its first receipt, and changes nothing', async () => {
    const ops = process.env.CORPUS === 'full' ? world.accepted.filter((_, i) => i % 5 === 0) : world.accepted
    expect(await verify.replay(world, ops)).toEqual([])
  }, 600_000)
})
