import { itemStation, menuType } from '../../src/domain/calculate'
import type { Approval, Discount, Line, MenuItem, Modifier, Order, Settings, Shift, StockItem } from '../../src/domain/types'
import { saveEntry } from '../../src/features/accounting/books'
import { ADVERSARIAL, DAGO_STAFF, ZIGGY_STAFF, menu as fullMenu, packs, settings as ziggySettings, stock as fullStock } from './catalog'
import { Oracle, businessDay, type OOrder } from './oracle'
import type { Device, Outlet, World } from './world'
// Two weeks at Ziggy Lounge, Jakarta, and its second outlet in Dago that it sends stock to. Every action goes through
// the real Commands on the device and as the person who would do it: cashiers sell and close on the till, the admin
// receives deliveries on the laptop, the kitchen and the bar make batches on their tablets, the manager approves with
// his PIN, reviews counts, runs catering and transfers, edits discounts mid-shift, and the accountant keeps the cash book.

export interface Plan { seed: number; start: string; days: number; orders: readonly [number, number]; loss: number; offline: boolean }
export const QUICK: Plan = { seed: 20261102, start: '2026-11-02', days: 1, orders: [40, 55], loss: 0.03, offline: true }
export const FULL: Plan = { seed: 20261102, start: '2026-11-02', days: 14, orders: [150, 250], loss: 0.02, offline: true }

const M = 60_000
// A wall-clock time in Jakarta (UTC+7, no daylight saving) on a calendar date.
export const wib = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00+07:00`)
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10)
const strange = () => ADVERSARIAL
// The events a shift always has, by the order's place in it.
type Force = 'takeaway' | 'manual' | 'voucher' | 'void' | 'voidline' | 'refund' | 'staff' | 'family' | 'tab' | 'saved'
const FORCED: Record<number, Force> = { 1: 'takeaway', 2: 'manual', 4: 'voucher', 6: 'void', 8: 'voidline', 10: 'refund', 12: 'staff', 14: 'family', 16: 'tab', 18: 'saved' }

export class Lounge {
  readonly oracle = new Oracle()
  ziggy!: Outlet; dago!: Outlet
  till!: Device; laptop!: Device; bar!: Device; kitchen!: Device; till2!: Device; laptop2!: Device; bar2!: Device; kitchen2!: Device
  readonly days: string[]
  // Counts waiting for the manager, by outlet; sales orders and transfers in flight; purchase orders not yet received.
  private pager = 0
  private openPOs: { id: string; outlet: string; due: string; lines: { stockId: string; qty: number; cost: number }[] }[] = []
  private catering: { id: string; outlet: string; deliver: string; total: number; paid: number; lines: { itemId: string; version: number; qty: number }[]; cancel: boolean }[] = []
  private transfers: { id: string; lines: { stockId: string; qty: number; value: number }[] }[] = []
  constructor(readonly world: World, readonly plan: Plan) {
    this.days = Array.from({ length: plan.days }, (_, i) => addDays(plan.start, i))
  }
  get rand() { return this.world.rand }
  // A calendar event on day `k` of each week (of `n` days); a one-day run has them all.
  private on(index: number, k: number, n = 7) { return this.plan.days === 1 || index % n === k }
  private lead() { return this.plan.days === 1 ? 0 : 2 }
  // Who may type a PIN at this outlet's till (owner, manager, and at Ziggy the admin too).
  private approver(outlet: string, ...only: string[]) { return this.rand.pick(only.length ? only : outlet === 'ziggy' ? ['manager', 'admin', 'owner'] : ['manager2', 'owner2']) }
  private mismatch(day: string, what: string, expected: unknown, actual: unknown) {
    this.world.note({ kind: 'mismatch', where: day, what, detail: `expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}` })
  }

  async setup() {
    const w = this.world, first = this.days[0], last = this.days[this.days.length - 1], group = w.rand.uuid()
    const z = ziggySettings('Ziggy Lounge', first, this.days)
    const d: Settings = { ...ziggySettings('Ziggy Dago', first, this.days), address: 'Jl. Ir. H. Juanda No. 50, Bandung', taxBps: 1100, serviceBps: 0, edcs: [], stationTablets: true, discounts: [], family: [], complimentBudget: 0, packaging: [] }
    this.oracle.settings.set('ziggy', z); this.oracle.settings.set('dago', d)
    this.ziggy = await w.outlet('ziggy', z, ZIGGY_STAFF, group)
    this.dago = await w.outlet('dago', d, DAGO_STAFF, group)
    w.at(wib(first, '06:00'))
    this.till = await w.device(this.ziggy, 'Ziggy kasir', 'pos'); this.laptop = await w.device(this.ziggy, 'Ziggy laptop', 'office')
    this.bar = await w.device(this.ziggy, 'Ziggy bar', 'station'); this.kitchen = await w.device(this.ziggy, 'Ziggy dapur', 'station')
    this.till2 = await w.device(this.dago, 'Dago kasir', 'pos'); this.laptop2 = await w.device(this.dago, 'Dago laptop', 'office')
    this.bar2 = await w.device(this.dago, 'Dago bar', 'station'); this.kitchen2 = await w.device(this.dago, 'Dago dapur', 'station')
    // The owner publishes the menu and the bahan from the laptop and books the opening stock, valued at pack prices.
    const stock = fullStock(), menu = fullMenu()
    await w.signIn(this.laptop, 'owner')
    await w.act(this.laptop, 'catalog.publish', (c) => c.publish(menu, stock))
    this.oracle.publish('ziggy', menu)
    for (const s of stock) {
      const p = packs.get(s.id), qty = s.production ? s.production.output * 2 : Math.max(s.threshold * 6, (p?.qty ?? 1000) * 2)
      const cost = p ? Math.round((qty * p.price) / p.qty) : 0
      const done = await w.act(this.laptop, 'stock.record opening', (c) => c.stockRecord(s.id, 'opening', qty, 'Saldo awal go-live', cost))
      if (done !== undefined) this.oracle.move('ziggy', w.iso(), s.id, 'opening', qty, cost, 'opening')
    }
    await w.sync(this.laptop)
    // Dago: the same bahan (so a transfer lands on the same ids), a shorter menu without options.
    const dagoMenu = menu.filter((m) => !m.id.startsWith('aneh-')).slice(0, 40).map((m) => ({ ...m, groups: [], modifiers: [] }))
    await w.signIn(this.laptop2, 'owner2')
    await w.act(this.laptop2, 'catalog.publish', (c) => c.publish(dagoMenu, stock))
    this.oracle.publish('dago', dagoMenu)
    for (const s of stock.filter((x) => !x.production)) {
      const qty = Math.max(s.threshold * 3, 1000)
      const done = await w.act(this.laptop2, 'stock.record opening', (c) => c.stockRecord(s.id, 'opening', qty, 'Saldo awal Dago', 0))
      if (done !== undefined) this.oracle.move('dago', w.iso(), s.id, 'opening', qty, 0, 'opening')
    }
    await w.sync(this.laptop2)
    // Suppliers, with what people type into them.
    await w.signIn(this.laptop, 'admin')
    for (const [i, name] of ['PT Kopi Nusantara', 'CV Susu Segar "Lembang"', '=Pasar Santa; kios 12', 'UD Sayur <Segar> & Buah'].entries())
      await w.act(this.laptop, 'supplier.save', (c) => c.saveSupplier({ id: w.rand.uuid(), name, phone: ['+62 812 1111', '(021) 555-01', '', '0812-3456-7890'][i], address: strange()[i + 6], note: strange()[i], active: true }))
    // The first delivery, ordered before go-live and received on the first morning.
    const sup = (await this.laptop.session!.db.suppliers.toArray())[0], lines = ['susu-segar', 'kopi-house', 'es-batu', 'gelas-16'].map((id) => { const p = packs.get(id)!; return { stockId: id, qty: 4 * p.qty, cost: 4 * p.price } })
    const po = await w.act(this.laptop, 'purchase.save', (c) => c.savePurchase({ supplierId: sup.id, supplier: sup.name, note: 'Stok pembukaan', lines }))
    if (po) this.openPOs.push({ id: po.id, outlet: 'ziggy', due: first, lines })
    await w.sync(this.laptop)
    void last
  }

  // The day the till sells through, the laptop and tablets around it.
  async day(index: number) {
    const w = this.world, day = this.days[index]
    this.pager = 0
    const [lo, hi] = this.plan.orders, total = w.rand.int(lo, hi), morning = Math.round(total * 0.42)
    // 07:30 the admin receives what was ordered, buys the day's fresh produce, orders for tomorrow, pays a supplier.
    w.at(wib(day, '07:30'))
    await this.backOffice(day)
    // 08:00 the kitchen and the bar make their batches on their tablets.
    w.at(wib(day, '08:00'))
    await this.batches()
    // 09:30 Siti opens the till; on day 6 the manager runs the evening himself.
    w.at(wib(day, '09:30'))
    await this.shift(day, 'siti', morning, wib(day, '16:00'), index)
    w.at(wib(day, '16:05'))
    await this.shift(day, this.on(index, 5) ? 'manager' : 'dewi', total - morning, wib(day, '23:30'), index)
    // Dago, a smaller outlet with station tablets, sells through the day.
    w.at(wib(day, '23:35'))
    await this.dagoDay(day, Math.max(8, Math.round(total * 0.2)), index)
    // The manager's evening at the laptop: catering, transfers, the books.
    await this.managerRound(day, index)
    for (const d of this.world.devices.values()) await w.sync(d)
    await this.endOfDay(day)
  }

  private async backOffice(day: string) {
    const w = this.world, o = this.oracle
    await w.signIn(this.laptop, 'admin')
    for (const po of this.openPOs.filter((p) => p.outlet === 'ziggy' && p.due <= day)) {
      // Most arrive in full; some short, and the rest is closed; the supplier is paid now, later, or partly.
      const short = w.rand.chance(0.2), lines = po.lines.map((l) => (short && w.rand.chance(0.5) ? { ...l, qty: Math.max(1, Math.floor(l.qty / 2)), cost: Math.floor(l.cost / 2) } : l))
      const pay = w.rand.weighted([['outside', 0.5], ['unpaid', 0.5]] as const)
      const done = await w.act(this.laptop, 'purchase.receive', (c) => c.receivePurchase(po.id, lines, pay, short && w.rand.chance(0.5)))
      if (done) { for (const l of lines) o.move('ziggy', w.iso(), l.stockId, 'purchase', l.qty, l.cost, po.id); this.openPOs = this.openPOs.filter((p) => p !== po) }
      if (done && pay === 'unpaid' && w.rand.chance(0.6)) {
        const owed = lines.reduce((n, l) => n + l.cost, 0), part = w.rand.chance(0.5) ? owed : Math.max(1, Math.floor(owed / 2))
        await w.act(this.laptop, 'purchase.pay', (c) => c.payPurchase(po.id, part, 'outside'))
      }
    }
    // Fresh produce at the market, booked straight to stock with what it cost.
    const local = await this.laptop.session!.db.stock.toArray()
    for (const s of this.restock(local, 'ziggy', 0.35)) {
      const p = packs.get(s.id)!, n = w.rand.int(2, 6), qty = n * p.qty, cost = n * p.price
      const done = await w.act(this.laptop, 'stock.record purchase', (c) => c.stockRecord(s.id, 'purchase', qty, w.rand.chance(0.15) ? w.rand.pick(strange()) : `Pasar ${s.name}`, cost))
      if (done !== undefined) o.move('ziggy', w.iso(), s.id, 'purchase', qty, cost, 'direct')
    }
    // A purchase order for tomorrow: the rest of what runs low.
    const need = this.restock(local, 'ziggy', 1).slice(0, 12)
    if (need.length) {
      const suppliers = await this.laptop.session!.db.suppliers.toArray(), sup = w.rand.pick(suppliers)
      const lines = need.map((s) => { const p = packs.get(s.id)!, n = w.rand.int(3, 8); return { stockId: s.id, qty: n * p.qty, cost: n * p.price } })
      const po = await w.act(this.laptop, 'purchase.save', (c) => c.savePurchase({ supplierId: sup?.id, supplier: sup?.name ?? 'Pemasok umum', note: w.rand.chance(0.3) ? w.rand.pick(strange()) : 'Kirim pagi', lines }))
      if (po) {
        if (w.rand.chance(0.1)) { await w.act(this.laptop, 'purchase.cancel', (c) => c.cancelPurchase(po.id, 'Pemasok tutup')) }
        else this.openPOs.push({ id: po.id, outlet: 'ziggy', due: addDays(day, 1), lines })
      }
    }
    await w.sync(this.laptop)
  }
  // What runs low by the oracle's count (the same as the server's, when the contract holds): bought when under twice
  // its threshold, or a few at random.
  private restock(local: StockItem[], outlet: string, share: number) {
    return local.filter((s) => !s.production && packs.has(s.id) && !s.id.startsWith('aneh') && (this.oracle.on(outlet, s.id) < Math.max(s.threshold * 2, 1) || this.rand.chance(0.01)))
      .filter(() => this.rand.chance(share))
  }

  private async batches() {
    const w = this.world, o = this.oracle
    for (const [device, key] of [[this.kitchen, 'joko'], [this.bar, 'raka']] as const) {
      if (device.session?.staff.key !== key) await w.signIn(device, key)
      const items = (await device.session!.db.stock.toArray()).filter((s) => s.production && s.station === (key === 'joko' ? 'kitchen' : 'bar'))
      for (const [n, s] of items.entries()) {
        // Topped up to four times its par, and the first item on each station's list made fresh every morning.
        const target = s.threshold * 4, runs = Math.max(n === 0 || w.rand.chance(0.3) ? 1 : 0, Math.min(4, Math.ceil(Math.max(0, target - o.on('ziggy', s.id)) / s.production!.output)))
        for (let i = 0; i < runs; i++) {
          // The kitchen weighs what it actually used and what came out: a little off the recipe now and then.
          const yieldQty = Math.round(s.production!.output * (w.rand.chance(0.2) ? 0.95 : 1)), inputs = s.production!.inputs.map((x) => ({ ...x, qty: Math.round(x.qty * (w.rand.chance(0.2) ? 1.03 : 1)) }))
          const note = w.rand.chance(0.1) ? w.rand.pick(strange()) : ''
          const cost = await w.act(device, 'production.record', (c) => c.produce(s.id, yieldQty, inputs, note))
          if (cost !== undefined) o.produce('ziggy', w.iso(), s.id, yieldQty, inputs, 'batch')
        }
      }
      // Waste: milk past its date, a dropped batch.
      if (w.rand.chance(0.6)) {
        const s = w.rand.pick(items.length ? items : (await device.session!.db.stock.toArray()).slice(0, 5)), qty = Math.max(1000, Math.round(Math.min(o.on('ziggy', s.id), s.threshold) / 10))
        const done = await w.act(device, 'stock.record waste', (c) => c.stockRecord(s.id, 'waste', qty, w.rand.chance(0.3) ? w.rand.pick(strange()) : 'Basi', 0))
        if (done !== undefined) o.move('ziggy', w.iso(), s.id, 'waste', -qty, 0, 'waste')
      }
      await w.sync(device)
    }
  }

  // One cashier's shift on the Ziggy till: float, orders, cash in and out, waste, a count, the close.
  private async shift(day: string, key: string, orders: number, until: number, index: number) {
    const w = this.world, o = this.oracle, till = this.till
    await w.signIn(till, key)
    const cashier = key !== 'manager'
    const shift = await w.act(till, 'shift.open', (c) => c.openShift(500_000))
    if (!shift) return
    o.shifts.set(shift.id, { id: shift.id, outlet: 'ziggy', opening: 500_000, openedAt: shift.openedAt, cashMoves: 0 })
    await w.sync(till)
    const start = w.now, step = (until - 25 * M - start) / Math.max(1, orders)
    // Day 2: the till loses the internet for two hours mid-shift and catches up after. Day 5: offline while the
    // manager changes the saved discounts on the laptop, so the till sells by its old copy.
    const offline = this.plan.offline && key === 'siti' && this.on(index, 1) ? [wib(day, '12:00'), wib(day, '14:00')] : this.plan.offline && key !== 'siti' && this.on(index, 4) ? [wib(day, '17:20'), wib(day, '17:50')] : undefined
    const held: Order[] = []
    let lastSync = w.now
    for (let i = 0; i < orders; i++) {
      w.at(start + i * step + w.rand.int(0, Math.max(1, Math.floor(step / 2))))
      till.online = !offline || w.now < offline[0] || w.now > offline[1]
      if (this.on(index, 4) && key !== 'siti' && !this.discountsChanged && w.now >= wib(day, '17:30')) await this.changeDiscounts(day)
      if (this.on(index, 2) && key === 'siti' && !this.menuChanged && w.now >= wib(day, '13:00')) await this.changeMenu(day)
      // Every shift has each kind of event at least once, whatever the dice say.
      const force = FORCED[i]
      const order = await this.sell(day, cashier, till, 'ziggy', force)
      if (order?.status === 'open') held.push(order)
      // A tab paid later, a cash drawer movement, a waste entry.
      if (held.length && w.rand.chance(0.3)) { const h = held.shift()!; if (w.rand.chance(0.4)) await this.addTo(h.id); await this.pay(h.id, cashier) }
      if (w.rand.chance(0.04) || i === 3 || i === 9) await this.cash(cashier, till.online, i === 3 ? 'out' : i === 9 ? 'in' : undefined)
      if (w.rand.chance(0.03) || i === 5) await this.waste(till, 'ziggy')
      if (key === 'manager' && w.rand.chance(0.05)) await this.drawerPurchase(day)
      if (till.online && w.now - lastSync >= 10_000) { await w.sync(till); lastSync = w.now }
      if (w.rand.chance(0.05)) { for (const d of [this.bar, this.kitchen, this.laptop]) await w.sync(d) }
    }
    till.online = true
    for (const h of held) await this.pay(h.id, cashier)
    await w.sync(till)
    // The cashier counts the bar fridge before closing; the manager approves it on the laptop right after.
    w.at(until - 20 * M)
    await this.count(till, 'ziggy', key === 'siti' ? 'Kulkas bar' : 'Rak bar', cashier)
    w.at(until - 5 * M)
    await this.close(day, shift, cashier)
  }

  private discountsChanged = false
  private menuChanged = false
  // The manager, on the laptop, stops one saved discount and raises another while the till sells by its old copy.
  private async changeDiscounts(day: string) {
    const w = this.world
    this.discountsChanged = true
    if (this.laptop.session?.staff.key !== 'manager') await w.signIn(this.laptop, 'manager')
    const current = (await this.laptop.session!.db.settings.get('settings'))!
    const discounts: Discount[] = current.discounts!.filter((d) => d.id !== 'camilan-5k').map((d) => (d.id === 'happy-hour' ? { ...d, value: 25, name: 'Happy hour minuman 25%' } : d))
    const next = { ...current, discounts }
    const done = await w.act(this.laptop, 'settings.update', (c) => c.settings(next))
    if (done !== undefined) this.oracle.settings.set('ziggy', next)
    await w.sync(this.laptop)
    void day
  }
  // The chef publishes new prices and a recipe change mid-shift; the till keeps the old versions in carts until it pulls.
  private async changeMenu(day: string) {
    const w = this.world
    this.menuChanged = true
    if (this.laptop.session?.staff.key !== 'chef') await w.signIn(this.laptop, 'chef')
    const s = this.laptop.session!, menu = await s.db.menu.toArray(), stock = await s.db.stock.toArray()
    const changed = new Set(['latte-iced', 'kopsu-aren', 'nasgor-ziggy', 'fries', 'es-teh'])
    const seasonal: MenuItem = { id: 'es-kopi-musiman', name: 'Es Kopi Musiman', category: 'Kopi', type: 'beverage', station: 'bar', price: 33000, active: true, soldOut: false, favorite: false, version: 1, recipe: [], modifiers: [] }
    const next = [...menu.map((m) => changed.has(m.id) ? { ...m, version: m.version + 1, price: m.price + 2000, recipe: m.recipe.map((r, i) => (i === 0 ? { ...r, qty: r.qty + 1000 } : r)) } : m), seasonal]
    const pin = await w.approve(this.laptop, 'manager', 'publish')
    const done = await w.act(this.laptop, 'catalog.publish', (c) => c.publish(next, stock, pin))
    if (done !== undefined) this.oracle.publish('ziggy', next.filter((m) => changed.has(m.id) || m === seasonal))
    await w.sync(this.laptop)
    void day
  }

  // A line as the POS builds it (Pos.tsx add()): the item's version, recipe, station and type, the options picked.
  line(item: MenuItem, qty: number, mods: Modifier[], note: string): Line {
    return { id: crypto.randomUUID(), itemId: item.id, name: item.name, price: item.price, qty, modifiers: mods, note, recipe: item.recipe, catalogVersion: item.version, prepared: false, cancelled: false, station: itemStation(item), type: menuType(item) }
  }
  private options(item: MenuItem) {
    const w = this.world, picked: Modifier[] = []
    for (const g of item.groups ?? []) {
      const opts = item.modifiers.filter((m) => m.group === g.id)
      if (g.required) { const d = opts.find((m) => m.default); picked.push(w.rand.chance(0.65) && d ? d : w.rand.pick(opts)) }
      else if (w.rand.chance(0.25)) picked.push(...w.rand.sample(opts, w.rand.int(1, Math.min(2, opts.length))))
    }
    for (const m of item.modifiers.filter((m) => !m.group)) if (w.rand.chance(0.15)) picked.push(m)
    return picked
  }
  private pickItem(menu: MenuItem[]) {
    const w = this.world, odd = menu.filter((m) => m.id.startsWith('aneh-') && m.id !== 'aneh-belum-laku')
    if (odd.length && w.rand.chance(0.02)) return w.rand.pick(odd)
    const kind = w.rand.weighted([['beverage', 0.58], ['food', 0.28], ['snack', 0.14]] as const)
    const list = menu.filter((m) => m.active && !m.soldOut && !m.id.startsWith('aneh-') && menuType(m) === kind)
    return w.rand.pick(list.length ? list : menu.filter((m) => m.active && !m.id.startsWith('aneh-')))
  }

  // One guest at the counter: a cart, maybe a discount or a compliment, saved, sometimes changed, sent and paid.
  async sell(day: string, cashier: boolean, device = this.till, outlet = 'ziggy', force?: Force): Promise<Order | undefined> {
    const w = this.world, o = this.oracle, s = device.session!, menu = await s.db.menu.toArray(), local = (await s.db.settings.get('settings'))!
    const mode = force === 'staff' || force === 'family' ? 'compliment' : force === 'takeaway' ? 'takeaway' : force ? 'dinein' : outlet === 'dago' ? w.rand.weighted([['dinein', 0.7], ['takeaway', 0.3]] as const) : w.rand.weighted([['dinein', 0.7], ['takeaway', 0.23], ['compliment', 0.07]] as const)
    const comp = force === 'staff' || force === 'family' ? force : mode === 'compliment' ? w.rand.weighted([['staff', 0.6], ['family', 0.4]] as const) : undefined
    const who = comp === 'family' ? w.rand.pick(local.family?.length ? local.family : ['Keluarga']) : comp ? w.rand.pick(['Raka Barista', 'Joko Dapur', 'Siti', w.rand.pick(strange()).slice(0, 30) || 'Staf']) : ''
    const lines: Line[] = []
    for (let n = w.rand.weighted([[1, 0.45], [2, 0.3], [3, 0.15], [4, 0.1]] as const); n > 0 || (force === 'voidline' && lines.length < 2) || (force === 'voucher' && lines.reduce((x, l) => x + l.price * l.qty, 0) < 120_000); n--) {
      const item = this.pickItem(menu)
      lines.push(this.line(item, w.rand.weighted([[1, 0.78], [2, 0.16], [3, 0.04], [6, 0.02]] as const), this.options(item), w.rand.chance(0.08) ? w.rand.pick([...strange(), 'Tidak pedas', 'Es sedikit', 'Tanpa bawang']) : ''))
    }
    this.pager++
    const label = w.rand.chance(0.03) ? w.rand.pick(strange()) : `Pager ${this.pager}`
    const name = w.rand.chance(0.25) ? w.rand.pick(['Bu Ani', 'Pak Budi', 'Kevin', ...strange()]).trim().slice(0, 60) || undefined : undefined
    const oo: OOrder = { id: '', outlet, shiftId: '', mode, ...(comp && { comp }), lines: lines.map((l) => ({ id: l.id, itemId: l.itemId, version: l.catalogVersion, qty: l.qty, mods: l.modifiers.map((m) => m.id), cancelled: false, name: l.name })), discount: { kind: 'none' }, status: 'open', createdAt: '' }
    // A discount: a saved one in one tap (a PIN when the manager marked it), or a manual one with a manager's PIN.
    let discountId: string | undefined, discount = 0, discountReason = '', approval: Approval | undefined
    const running = (local.discounts ?? []).filter((d) => !d.ended && d.from <= day && day <= d.to && o.savedAmount(oo, d) > 0 && (force !== 'voucher' || d.approval) && (force !== 'saved' || !d.approval))
    const kind = mode === 'compliment' ? 'none' : force === 'manual' ? 'manual' : force === 'voucher' || force === 'saved' ? 'saved' : force ? 'none' : w.rand.weighted([['none', 0.87], ['saved', 0.09], ['manual', 0.04]] as const)
    if (kind === 'saved' && running.length) {
      const d = w.rand.pick(running)
      discountId = d.id; discount = o.savedAmount(oo, d); discountReason = d.name; oo.discount = { kind: 'saved', def: structuredClone(d) }
      if (d.approval && cashier) { if (!device.online) return undefined; approval = await w.approve(device, this.approver(outlet), 'discount', { amount: discount }) }
    } else if (kind === 'manual') {
      const sub = o.subtotal(oo)
      discount = Math.min(sub, w.rand.chance(0.5) ? 5000 : Math.floor(sub / 10 / 1000) * 1000 || 1000); discountReason = w.rand.chance(0.3) ? w.rand.pick(strange()).trim() || 'Diskon' : 'Pelanggan tetap'
      oo.discount = { kind: 'manual', amount: discount }
      if (cashier) { if (!device.online) return undefined; approval = await w.approve(device, this.approver(outlet), 'discount', { amount: discount }) }
    }
    const saved = await w.act(device, 'order.save', (c) => c.save({ id: 'current', revision: 0, label, ...(name && { name }), mode, ...(comp && { compliment: { kind: comp, who } }), lines, discount, discountReason, ...(approval && { discountApproval: approval }), ...(discountId && { discountId }) }))
    if (!saved) return undefined
    Object.assign(oo, { id: saved.id, shiftId: saved.shiftId, createdAt: saved.createdAt })
    o.orders.set(oo.id, oo)
    this.compare('order.save', oo, saved)
    let order: Order = saved
    // The guest adds something before paying.
    if (w.rand.chance(0.08)) {
      const item = this.pickItem(menu), extra = this.line(item, 1, this.options(item), '')
      const again = await w.act(device, 'order.save (re-save)', (c) => c.save({ id: 'current', orderId: order.id, revision: order.revision, label, ...(name && { name }), mode, ...(comp && { compliment: { kind: comp, who } }), lines: [...order.lines, extra], discount: oo.discount.kind === 'manual' ? discount : 0, discountReason, ...(discountId && { discountId }) }))
      if (again) { oo.lines.push({ id: extra.id, itemId: extra.itemId, version: extra.catalogVersion, qty: 1, mods: extra.modifiers.map((m) => m.id), cancelled: false, name: extra.name }); order = again; this.compare('order.save (re-save)', oo, again) }
    }
    // Walked out before paying: the order is voided with a reason and a PIN.
    if ((force === 'void' || (!force && w.rand.chance(0.02))) && device.online) {
      const a = cashier ? await w.approve(device, this.approver(outlet), 'void', { orderId: order.id, amount: order.totals.total }) : undefined
      const done = await w.act(device, 'order.void', (c) => c.voidOrder(order.id, w.rand.chance(0.3) ? w.rand.pick(strange()) : 'Tamu batal', a))
      if (done !== undefined) oo.status = 'void'
      return undefined
    }
    if (outlet === 'dago') {
      // Station tablets: the order is sent now, paid when the guest leaves.
      const sent = await w.act(device, 'order.prepare', (c) => c.prepare(order.id))
      if (sent) o.prepare(oo, sent.updatedAt, oo.lines)
      return sent
    }
    if (force === 'tab' || (!force && w.rand.chance(0.04))) return order // a tab, paid later in the shift
    return this.pay(order.id, cashier, device, force)
  }
  // A tab the guest adds to later, from whatever menu the till holds by then (a newer version after a publish).
  private async addTo(id: string, device = this.till) {
    const w = this.world, oo = this.oracle.orders.get(id)!, s = device.session!, order = (await s.db.orders.get(id))!
    if (!order || order.status !== 'open') return
    const item = this.pickItem(await s.db.menu.toArray()), extra = this.line(item, 1, this.options(item), '')
    const again = await w.act(device, 'order.save (tab)', (c) => c.save({ id: 'current', orderId: id, revision: order.revision, label: order.label, ...(order.name && { name: order.name }), mode: order.mode, ...(order.compliment && { compliment: order.compliment }), lines: [...order.lines, extra], discount: oo.discount.kind === 'manual' ? order.discount : 0, discountReason: order.discountReason, ...(order.discountId && { discountId: order.discountId }) }))
    if (again) { oo.lines.push({ id: extra.id, itemId: extra.itemId, version: extra.catalogVersion, qty: 1, mods: extra.modifiers.map((m) => m.id), cancelled: false, name: extra.name }); this.compare('order.save (tab)', oo, again) }
  }
  // Pays an order as the pilot does it: every unsent line goes to the bar and kitchen (one prepare), then the payment.
  async pay(id: string, cashier: boolean, device = this.till, force?: Force): Promise<Order | undefined> {
    const w = this.world, o = this.oracle, oo = o.orders.get(id)!, s = device.session!
    let order = (await s.db.orders.get(id))!
    if (!order || order.status !== 'open') return undefined
    if (order.lines.some((l) => !l.prepared && !l.cancelled)) {
      const unsent = oo.lines.filter((l) => !order.lines.find((x) => x.id === l.id)?.prepared)
      const sent = await w.act(device, 'order.prepare', (c) => c.prepare(id))
      if (!sent) return undefined
      o.prepare(oo, sent.updatedAt, unsent)
      order = sent
    }
    const expected = o.totals(oo), till = o.settings.get(oo.outlet)!, edcs = till.edcs ?? []
    const method = expected.total === 0 ? 'none' : w.rand.weighted([['cash', 0.36], ['qris', 0.3], ['card', 0.34]] as const)
    const edc = method === 'qris' || method === 'card' ? (edcs.length ? w.rand.pick(edcs) : undefined) : undefined
    const code = edc && w.rand.chance(0.3) ? (w.rand.chance(0.15) ? w.rand.pick(strange()).slice(0, 30) : String(w.rand.int(100000, 999999))) : undefined
    const tendered = method === 'cash' ? w.rand.pick([expected.total, Math.ceil(expected.total / 5000) * 5000, Math.ceil(expected.total / 50000) * 50000, Math.ceil(expected.total / 100000) * 100000]) : 0
    const paid = await w.act(device, 'payment.record', (c) => c.pay(id, method, tendered, true, { edc, approvalCode: code }))
    if (!paid) return undefined
    oo.status = 'paid'; oo.paidAt = paid.payment!.at; oo.paidTotal = expected.total; oo.payment = { method, tendered, ...(paid.payment?.edc && { edc: paid.payment.edc }) }
    this.compare('payment.record', oo, paid)
    // After paying: a made line comes off with a manager's PIN (a dropped drink), or the whole order is refunded.
    if (device.online && (force === 'voidline' || (!force && w.rand.chance(0.025))) && oo.lines.filter((l) => !l.cancelled).length > 1) {
      const target = w.rand.pick(oo.lines.filter((l) => !l.cancelled)), was = target.cancelled
      target.cancelled = true
      const fits = o.discount(oo) <= o.subtotal(oo)
      target.cancelled = was
      if (fits) {
        const old = o.discount(oo), a = cashier ? await w.approve(device, this.approver(oo.outlet), 'voidline', { orderId: id, lineId: target.id, amount: o.value(oo.outlet, target) }) : undefined
        const done = await w.act(device, 'order.voidline', (c) => c.voidLine(id, target.id, w.rand.chance(0.3) ? w.rand.pick(strange()).trim() || 'Tumpah' : 'Gelas tumpah', a))
        if (done) {
          target.cancelled = true
          // A void never raises what the guest owes: the discount is at least the old one less the line, at most the old one and what is left.
          const own = o.discount(oo), kept = Math.max(0, Math.min(o.subtotal(oo), old, Math.max(own, old - o.value(oo.outlet, target))))
          if (kept !== own && oo.mode !== 'compliment') oo.discount = { kind: 'manual', amount: kept }
          this.compare('order.voidline', oo, done)
        }
      }
    }
    if (device.online && (force === 'refund' || (!force && w.rand.chance(0.012))) && oo.status === 'paid') {
      const a = cashier ? await w.approve(device, this.approver(oo.outlet), 'refund', { orderId: id }) : undefined
      const total = o.totals(oo).total
      const done = await w.act(device, 'refund.record', (c) => c.refund(id, w.rand.chance(0.3) ? w.rand.pick(strange()) : 'Salah pesanan', a))
      if (done !== undefined) { oo.status = 'refunded'; oo.refundAt = w.iso(); oo.refundTotal = total }
    }
    return paid
  }
  private compare(what: string, oo: OOrder, order: Order) {
    const e = this.oracle.totals(oo)
    if (JSON.stringify(e) !== JSON.stringify({ subtotal: order.totals.subtotal, discount: order.totals.discount, service: order.totals.service, tax: order.totals.tax, total: order.totals.total })) this.mismatch(businessDay(order.updatedAt), `${what} totals on the till (${order.receiptId})`, e, order.totals)
  }

  private async cash(cashier: boolean, online: boolean, way?: 'in' | 'out') {
    const w = this.world, s = this.till.session!, out = way ? way === 'out' : w.rand.chance(0.7)
    if (out && cashier && !online) return
    const amount = out ? -w.rand.pick([20000, 50000, 75000]) : w.rand.pick([100000, 200000])
    const reason = w.rand.chance(0.3) ? w.rand.pick(strange()) : out ? 'Beli es batu' : 'Tukar uang kecil'
    const a = out && cashier ? await w.approve(this.till, this.approver('ziggy'), 'cashout', { amount: -amount }) : undefined
    const done = await w.act(this.till, 'shift.cash', (c) => c.cashMove(amount, reason, a))
    const shift = await s.db.shifts.where('status').equals('open').first()
    if (done !== undefined && shift) this.oracle.shifts.get(shift.id)!.cashMoves += amount
  }
  private async waste(device: Device, outlet: string) {
    const w = this.world, s = device.session!, items = (await s.db.stock.toArray()).filter((x) => this.oracle.on(outlet, x.id) > 5000 && !x.id.startsWith('aneh'))
    const item = w.rand.pick(items), qty = w.rand.int(1, 5) * (item.unit === 'pcs' ? 1000 : 10_000)
    const done = await w.act(device, 'stock.record waste', (c) => c.stockRecord(item.id, 'waste', qty, w.rand.chance(0.3) ? w.rand.pick(strange()) : 'Tumpah', 0))
    if (done !== undefined) this.oracle.move(outlet, w.iso(), item.id, 'waste', -qty, 0, 'waste')
  }
  // The manager at the till buys ice with cash from the drawer.
  private async drawerPurchase(day: string) {
    const w = this.world, p = packs.get('es-batu')!, n = w.rand.int(1, 3)
    const done = await w.act(this.till, 'stock.record purchase (laci)', (c) => c.stockRecord('es-batu', 'purchase', n * p.qty, 'Es batu darurat', n * p.price, true))
    if (done !== undefined) {
      this.oracle.move('ziggy', w.iso(), 'es-batu', 'purchase', n * p.qty, n * p.price, 'drawer')
      const shift = await this.till.session!.db.shifts.where('status').equals('open').first()
      if (shift) this.oracle.shifts.get(shift.id)!.cashMoves -= n * p.price
    }
    void day
  }

  // Counting one storage area: what is there, a few lines off; the manager approves it on the laptop right away, so
  // no sale happens between the count and its approval (that case has its own test).
  private async count(device: Device, outlet: string, area: string, cashier: boolean) {
    const w = this.world, o = this.oracle, s = device.session!
    const items = (await s.db.stock.toArray()).filter((x) => x.area === area).slice(0, 15)
    if (!items.length) return
    const lines = items.map((x) => { const on = Math.max(0, o.on(outlet, x.id)), off = w.rand.chance(0.25) ? Math.round(on * w.rand.pick([0.9, 0.97, 1.02])) : on; return { stockId: x.id, counted: Math.max(0, off), reason: off !== on && w.rand.chance(0.3) ? w.rand.pick(strange()).slice(0, 200) : '' } })
    const id = crypto.randomUUID()
    const submitted = await w.act(device, 'count.submit', (c) => c.submitCount({ id, area, lines }))
    if (!submitted) return
    await w.sync(device)
    // The manager approves it, or the admin does with the manager's PIN for this count (CNT-3).
    const laptop = outlet === 'ziggy' ? this.laptop : this.laptop2, reviewer = outlet === 'ziggy' ? (w.rand.chance(0.3) ? 'admin' : 'manager') : 'manager2'
    if (laptop.session?.staff.key !== reviewer) await w.signIn(laptop, reviewer)
    else await w.sync(laptop)
    const pending = await laptop.session!.db.counts.get(id)
    if (!pending) { this.mismatch(businessDay(w.iso()), `count ${area} submitted but not on the ${reviewer}'s laptop after a pull`, 'submitted', 'missing'); return }
    const pin = reviewer === 'admin' ? await w.approve(laptop, 'manager', 'count', { orderId: id }) : undefined
    const approved = await w.act(laptop, 'count.record', (c) => c.recordCount({ id, area: pending.area, lines: pending.lines }, pin))
    if (approved) for (const l of lines) o.move(outlet, w.iso(), l.stockId, 'count', l.counted - o.on(outlet, l.stockId), 0, id)
    await w.sync(laptop)
    void cashier
  }

  // Close: the drawer counted (now and then a little off, rarely more than the limit), each EDC's slip matched.
  private async close(day: string, shift: Shift, cashier: boolean) {
    const w = this.world, o = this.oracle, s = this.till.session!, settings = (await s.db.settings.get('settings'))!
    const open = (await s.db.orders.where('shiftId').equals(shift.id).toArray()).filter((x) => x.status === 'open')
    for (const x of open) await this.pay(x.id, cashier)
    const cash = o.expectedCash(shift.id), gapCash = w.rand.weighted([[0, 0.8], [-2000, 0.1], [5000, 0.05], [-25000, 0.05]] as const)
    const edc = o.expectedEdc(shift.id, settings.edcs ?? []), slips: Record<string, number> = {}
    for (const [e, v] of edc) slips[e] = v + (w.rand.chance(0.05) ? -w.rand.pick([1000, 15000]) : 0)
    const counted = Math.max(0, cash + gapCash), gap = Math.abs(counted - cash) + [...edc].reduce((n, [e, v]) => n + Math.abs(slips[e] - v), 0)
    const a = cashier && gap > (settings.varianceLimit ?? 10000) ? await w.approve(this.till, this.approver('ziggy'), 'variance', { amount: gap }) : undefined
    const closed = await w.act(this.till, 'shift.close', (c) => c.closeShift(counted, a, (settings.edcs ?? []).length ? slips : undefined))
    if (!closed) return
    const os = o.shifts.get(shift.id)!
    Object.assign(os, { closedAt: closed.closedAt, counted, slips })
    const expectedAll = cash + [...edc.values()].reduce((n, v) => n + v, 0)
    if (closed.expected !== expectedAll) this.mismatch(day, `shift close on the till: expected cash+EDC (${shift.cashier})`, expectedAll, closed.expected)
    await w.sync(this.till)
  }

  // Dago: one cashier, station tablets mark tickets ready, cash or QRIS without an EDC.
  private async dagoDay(day: string, orders: number, index: number) {
    const w = this.world, o = this.oracle
    w.at(wib(addDays(day, 0), '23:36'))
    // Dago trades on the same day; its clock is replayed after Ziggy's evening, so its shift opens at the time it is.
    await w.signIn(this.till2, 'kasir2')
    for (const [d, k] of [[this.bar2, 'barista2'], [this.kitchen2, 'dapur2']] as const) if (d.session?.staff.key !== k) await w.signIn(d, k)
    const shift = await w.act(this.till2, 'shift.open', (c) => c.openShift(300_000))
    if (!shift) return
    o.shifts.set(shift.id, { id: shift.id, outlet: 'dago', opening: 300_000, openedAt: shift.openedAt, cashMoves: 0 })
    const open: string[] = []
    for (let i = 0; i < orders; i++) {
      w.advance(w.rand.int(20_000, 90_000))
      const sent = await this.sell(day, true, this.till2, 'dago')
      if (sent) open.push(sent.id)
      await w.sync(this.till2)
      // The tablets pull the ticket and mark it ready, then the guest pays.
      if (open.length && w.rand.chance(0.6)) {
        const id = open.shift()!
        for (const [d, st] of [[this.bar2, 'bar'], [this.kitchen2, 'kitchen']] as const) {
          await w.sync(d)
          const local = await d.session!.db.orders.get(id)
          if (local?.lines.some((l) => l.prepared && !l.cancelled && !l.readyAt && (l.station ?? 'kitchen') === st)) await w.act(d, 'order.ready', (c) => c.ready(id, st))
          await w.sync(d)
        }
        await w.sync(this.till2)
        // Now and then the table orders one more thing after its tickets came back ready: a re-save over lines the
        // stations marked, then the new line goes out before the bill.
        if (w.rand.chance(0.25)) await this.addTo(id, this.till2)
        await this.pay(id, true, this.till2)
      }
    }
    for (const id of open) await this.pay(id, true, this.till2)
    await w.sync(this.till2)
    const cash = o.expectedCash(shift.id)
    const closed = await w.act(this.till2, 'shift.close', (c) => c.closeShift(cash))
    if (closed) Object.assign(o.shifts.get(shift.id)!, { closedAt: closed.closedAt, counted: cash })
    if (closed && closed.expected !== cash) this.mismatch(day, 'Dago shift close: expected cash', cash, closed.expected)
    await w.sync(this.till2)
    void index
  }

  // The manager's evening at the laptop: catering, a transfer to Dago, a removal; the accountant's cash book.
  private async managerRound(day: string, index: number) {
    const w = this.world, o = this.oracle
    if (this.laptop.session?.staff.key !== 'manager') await w.signIn(this.laptop, 'manager')
    const s = this.laptop.session!, menu = await s.db.menu.toArray()
    // Catering: an office lunch for the day after tomorrow, a down payment now, delivered and settled on the day.
    if (this.on(index, 0, 2)) {
      const items = w.rand.sample(menu.filter((m) => m.active && !m.id.startsWith('aneh')), 3)
      const lines = items.map((m) => ({ id: crypto.randomUUID(), itemId: m.id, name: m.name, qty: w.rand.int(5, 30), price: Math.round(m.price * 0.9), catalogVersion: m.version }))
      const cancel = w.rand.chance(0.25), customer = { name: w.rand.chance(0.5) ? w.rand.pick(strange()).trim() || 'PT Uji' : 'PT Maju Jaya', phone: '+62 811 222 333', address: 'Jl. Sudirman Kav. 1\nLt. 12' }
      const so = await w.act(this.laptop, 'salesorder.save', (c) => c.saveSalesOrder({ customer, deliverAt: new Date(wib(addDays(day, this.lead()), '11:30')).toISOString(), lines, discount: w.rand.pick([0, 50000]), note: w.rand.pick([...strange(), 'Tanpa sendok']) }))
      if (so) {
        const dp = Math.round(so.totals.total * 0.3)
        await w.act(this.laptop, 'salesorder.pay', (c) => c.paySalesOrder(so.id, dp, 'outside'))
        this.catering.push({ id: so.id, outlet: 'ziggy', deliver: addDays(day, this.lead()), total: so.totals.total, paid: dp, lines: lines.map((l) => ({ itemId: l.itemId, version: l.catalogVersion, qty: l.qty })), cancel })
        // A negotiated price per line, the restaurant's charges on top.
        const z = o.settings.get('ziggy')!, sub = lines.reduce((n, l) => n + l.price * l.qty, 0), sv = Math.floor(((sub - so.discount) * z.serviceBps + 5000) / 10000), tx = Math.floor(((sub - so.discount + sv) * z.taxBps + 5000) / 10000)
        if (so.totals.total !== sub - so.discount + sv + tx) this.mismatch(day, `catering ${so.number} total`, sub - so.discount + sv + tx, so.totals.total)
      }
    }
    for (const c of this.catering.filter((x) => x.deliver <= day)) {
      this.catering = this.catering.filter((x) => x !== c)
      if (c.cancel) { await w.act(this.laptop, 'salesorder.cancel', (x) => x.cancelSalesOrder(c.id, w.rand.pick(['Acara batal', ...strange()]), c.paid, 'outside')); continue }
      const done = await w.act(this.laptop, 'salesorder.deliver', (x) => x.deliverSalesOrder(c.id))
      if (done !== undefined) for (const l of c.lines) for (const r of o.item('ziggy', l).recipe) o.move('ziggy', w.iso(), r.stockId, 'preparation', -r.qty * l.qty, 0, c.id)
      await w.act(this.laptop, 'salesorder.pay', (x) => x.paySalesOrder(c.id, c.total - c.paid, 'outside'))
    }
    // A transfer of beans and milk to Dago every third day; Dago books it in the next morning, one line short.
    if (this.on(index, 1, 3)) {
      const outlets = JSON.parse((await s.db.meta.get('outlets'))?.value || '[]') as { id: string; name: string }[]
      const to = outlets.find((x) => x.id === this.dago.id)
      if (!to) this.mismatch(day, 'linked outlet Dago on the manager laptop', this.dago.id, outlets)
      else {
        const lines = [{ stockId: 'kopi-house', qty: 2_000_000 }, { stockId: 'susu-segar', qty: 12_000_000 }, { stockId: 'gelas-16', qty: 100_000 }]
        const t = await w.act(this.laptop, 'transfer.send', (c) => c.sendTransfer(to, lines, w.rand.pick(['Kiriman rutin', ...strange()])))
        if (t) {
          const priced = lines.map((l) => ({ ...l, value: Math.min(1e9, Math.round(l.qty * (o.unit('ziggy', l.stockId) ?? 0))) }))
          for (const l of priced) o.move('ziggy', w.iso(), l.stockId, 'transfer', -l.qty, l.value, t.id)
          this.transfers.push({ id: t.id, lines: priced })
        }
      }
    }
    await w.sync(this.laptop)
    for (const t of this.transfers.splice(0)) {
      if (this.laptop2.session?.staff.key !== 'manager2') await w.signIn(this.laptop2, 'manager2')
      await w.act(this.laptop2, 'outlet_transfers', (c) => c.refreshTransfers())
      // One line arrives short; once in a while the sender calls it back instead.
      if (w.rand.chance(0.15)) {
        const done = await w.act(this.laptop, 'transfer.cancel', (c) => c.cancelTransfer(t.id, 'Salah kirim'))
        if (done !== undefined) for (const l of t.lines) o.move('ziggy', w.iso(), l.stockId, 'transfer', l.qty, l.value, t.id)
        continue
      }
      const got = t.lines.map((l, i) => ({ stockId: l.stockId, target: l.stockId, qty: i === 1 ? Math.floor(l.qty / 2) : l.qty }))
      const done = await w.act(this.laptop2, 'transfer.receive', (c) => c.receiveTransfer(t.id, got))
      if (done !== undefined) t.lines.forEach((l, i) => { if (got[i].qty > 0) o.move('dago', w.iso(), l.stockId, 'transfer', got[i].qty, Math.min(1e9, Math.round((l.value * got[i].qty) / l.qty)), t.id) })
      await w.sync(this.laptop2)
    }
    // Day 6: a test item that never sold is removed for good.
    if (this.on(index, 5)) {
      if (this.laptop.session?.staff.key !== 'manager') await w.signIn(this.laptop, 'manager')
      // Removed from the menu list on the laptop, so only while it is still listed there.
      if (await this.laptop.session!.db.menu.get('aneh-belum-laku')) await w.act(this.laptop, 'catalog.remove', (c) => c.removeMenu(['aneh-belum-laku']))
    }
    await w.sync(this.laptop)
    // The accountant writes the day's costs into the cash book.
    await w.signIn(this.laptop, 'maya')
    const kinds = [['utilities', 450_000, 'PLN & PDAM'], ['supplies', 120_000, '=Sabun; "lap"'], ['payroll', 1_250_000, 'Gaji harian\nlembur'], ['bankFees', 35_000, 'MDR EDC']] as const
    for (const [kind, amount, note] of w.rand.sample(kinds, 2)) {
      const entry = { id: crypto.randomUUID(), day, kind, amount, note }
      await w.act(this.laptop, 'ledger_save', async (_c, ss) => { await saveEntry(ss.db, ss.identity, entry); return entry })
    }
  }

  // At the end of each day: the server's stock per bahan, each shift's cash and every order of the day, against what the
  // restaurant did.
  async endOfDay(day: string) {
    const w = this.world, o = this.oracle
    for (const outlet of [this.ziggy, this.dago]) {
      const rows = await w.server.admin<{ stock_id: string; qty: string }>('select stock_id,sum(qty)::text as qty from public.stock_movements where restaurant_id=$1 group by 1', [outlet.id])
      const server = new Map(rows.map((r) => [r.stock_id, Number(r.qty)]))
      for (const id of new Set([...server.keys(), ...[...o.balance.keys()].filter((k) => k.startsWith(outlet.key + '|')).map((k) => k.slice(outlet.key.length + 1))]))
        if ((server.get(id) ?? 0) !== o.on(outlet.key, id)) this.mismatch(day, `${outlet.key} stock ${id}`, o.on(outlet.key, id), server.get(id) ?? 0)
    }
  }
}
