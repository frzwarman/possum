import { isSale, lineUse, menuType } from "./calculate";
import type { CashMovement, Ingredient, MenuItem, MenuType, Movement, Order, PurchaseOrder, SalesOrder, Shift, StockItem } from "./types";

// The books for a range of business days. A signed-in store gets them complete from the server (accounting_data): a
// device only holds its newest orders and the stock movements since it signed in, which is not enough to close a month.
// The demo builds the same shape from the device. Everything the Akuntansi page shows is worked out here from it.
export interface BookLine { itemId: string; name: string; qty: number; price: number; cancelled: boolean; recipe: Ingredient[]; modifiers: { price: number; recipe: Ingredient[] }[] }
export type BookOrder = Pick<Order, "id" | "receiptId" | "mode" | "status" | "cashier" | "totals" | "payment" | "refund" | "createdAt"> & { lines: BookLine[] };
// Stock movements summed per business day, ingredient and kind. comp = used for a compliment instead of a sale.
// cost = the rupiah written on the movements (purchases, batches, transfers), negative where stock left.
// batch/at: a production run keeps its own rows (id and time), so one that uses what another made the same day is valued in order.
export interface Move { day: string; stockId: string; kind: Movement["kind"]; comp: boolean; qty: number; cost: number; batch?: string; at?: string }
// A shift opening: its float, and what the drawer held when the shift before it closed (0 when there was none, null
// when that one closed without a count). The difference is cash that left the drawer for the safe or the bank.
export interface Opened { at: string; opening: number; prior: number | null }
// Money that never passes the till, written by hand on the Akuntansi page: rent, salaries, a tax payment, the owner's capital.
export interface CashEntry { id: string; day: string; kind: CashKind; amount: number; note: string; by?: string }
export interface Books {
  asOf?: string; orders: BookOrder[]; moves: Move[];
  // Stock on hand per ingredient when the range starts, and the latest price per thousandth of a base unit.
  opening: Record<string, number>; costs: Record<string, number>;
  shifts: Shift[]; opened: Opened[]; cash: CashMovement[]; purchaseOrders: PurchaseOrder[]; salesOrders: SalesOrder[];
  // Every entry of the cash book, whatever its date: there are few, and a late one must still reach the opening balances.
  entries: CashEntry[];
}
export interface Range { from: string; to: string; dayOf: (iso: string) => string }
const within = (r: Range, iso?: string) => { if (!iso) return ""; const d = r.dayOf(iso); return d >= r.from && d <= r.to ? d : ""; };
const gross = (l: BookLine) => l.qty * (l.price + l.modifiers.reduce((n, m) => n + m.price, 0));
const drawer = (s: Shift) => (s.counted == null ? null : s.counted - (s.settlements ?? []).reduce((n, x) => n + x.slip, 0));

// The demo's version of what the server sums: movements on this device, per day, ingredient and kind.
export function sumMoves(movements: Movement[], compliments: Set<string>, r: Range) {
  const moves = new Map<string, Move>(), opening: Record<string, number> = {};
  for (const m of movements) {
    const day = r.dayOf(m.at);
    if (day < r.from) opening[m.stockId] = (opening[m.stockId] ?? 0) + m.qty;
    if (day < r.from || day > r.to) continue;
    const comp = m.kind === "preparation" && compliments.has(m.recordId), batch = m.kind === "production" ? m.recordId : undefined, unpriced = (m.kind === "purchase" || m.kind === "transfer" || m.kind === "opening") && m.qty > 0 && m.cost === 0, key = [day, m.stockId, m.kind, comp, batch, unpriced].join("|");
    const row = moves.get(key) ?? { day, stockId: m.stockId, kind: m.kind, comp, qty: 0, cost: 0, ...(batch && { batch }) };
    if (batch && (!row.at || m.at < row.at)) row.at = m.at;
    row.qty += m.qty;
    row.cost += m.qty < 0 ? -m.cost : m.cost;
    moves.set(key, row);
  }
  return { moves: [...moves.values()], opening };
}
// The demo's version of the server's shift openings in the range, each with the drawer count of the shift before it.
export function openings(shifts: Shift[], r: Range): Opened[] {
  const all = [...shifts].sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  return all.flatMap((s, i) => (within(r, s.openedAt) ? [{ at: s.openedAt, opening: s.opening, prior: i ? drawer(all[i - 1]) : 0 }] : []));
}

// One row per business day, counted at payment like Laporan. A sale is gross − discount + service + tax = total. A
// staff meal is not a sale: what was given free is "compliments", what the staff member paid is "staff". A refund
// counts on the day it was given back and leaves by the way the order was paid, so cash + qris + card = received.
export interface DayRow {
  day: string; orders: number; gross: number; discount: number; net: number; service: number; tax: number; total: number
  staff: number; compliments: number; refunds: number; cash: number; qris: number; card: number; received: number
}
export function recap(orders: BookOrder[], r: Range): DayRow[] {
  const rows = new Map<string, DayRow>();
  const row = (day: string) => {
    let x = rows.get(day);
    if (!x) rows.set(day, (x = { day, orders: 0, gross: 0, discount: 0, net: 0, service: 0, tax: 0, total: 0, staff: 0, compliments: 0, refunds: 0, cash: 0, qris: 0, card: 0, received: 0 }));
    return x;
  };
  for (const o of orders) {
    const t = o.totals, method = o.payment?.method, paid = within(r, o.payment?.at), back = within(r, o.refund?.at);
    if (paid) {
      const x = row(paid);
      if (isSale(o)) { x.orders++; x.gross += t.subtotal; x.discount += t.discount; x.service += t.service; x.tax += t.tax; x.total += t.total; }
      else { x.staff += t.total; x.compliments += t.discount; }
      if (method && method !== "none") x[method] += t.total;
    }
    if (back) { const x = row(back); x.refunds += t.total; if (method && method !== "none") x[method] -= t.total; }
  }
  for (const x of rows.values()) { x.net = x.gross - x.discount; x.received = x.total + x.staff - x.refunds; }
  return [...rows.values()].sort((a, b) => a.day.localeCompare(b.day));
}

// Stock on hand per ingredient: quantity, what it is worth in whole rupiah, and its average cost per thousandth of a
// unit. Carried from one stretch of days to the next, so an ingredient keeps its average across months.
export type Stock = Record<string, [qty: number, value: number, average: number]>;
// Moving average, worked a day at a time: the day's deliveries first (each joins the stock at what was paid for it),
// then what left, at the average. A batch made in-house takes the worth of what went into it. An ingredient that has
// never come in with a price, or was carried in at no worth because it had none then, starts at the latest known
// price; unseen holds what that added. Returns what every movement added to or took from the stock's worth, in whole
// rupiah, so the ledger's stock account and the stock list always agree.
export function valuation(books: Pick<Books, "moves" | "opening" | "costs">, before: Stock = {}) {
  const stock: Stock = {}, worth = new Map<Move, number>(), unseen: Record<string, number> = {};
  const at = (id: string) => {
    if (!stock[id]) {
      const qty = books.opening[id] ?? 0, known = before[id], average = known?.[2] || books.costs[id] || 0;
      stock[id] = [qty, known?.[2] ? known[1] : Math.round(Math.max(0, qty) * average), average];
      if (stock[id][1] !== (known?.[1] ?? 0)) unseen[id] = stock[id][1] - (known?.[1] ?? 0);
    }
    return stock[id];
  };
  for (const id of new Set([...Object.keys(before), ...Object.keys(books.opening)])) at(id);
  const put = (m: Move, s: Stock[string], qty: number, value: number) => { worth.set(m, value - s[1]); s[0] = qty; s[1] = value; if (qty > 0 && value > 0) s[2] = value / qty; };
  const receive = (m: Move, cost: number) => {
    const s = at(m.stockId), qty = s[0] + m.qty;
    if (cost > 0 && s[0] > 0) put(m, s, qty, s[1] + cost);
    else { if (cost > 0) s[2] = cost / m.qty; put(m, s, qty, cost > 0 ? Math.round(qty * s[2]) : s[1] + Math.round(m.qty * s[2])); }
  };
  const issue = (m: Move) => { const s = at(m.stockId), qty = s[0] + m.qty; put(m, s, qty, qty === 0 ? 0 : s[1] + Math.round(m.qty * s[2])); };
  for (const day of [...new Set(books.moves.map((m) => m.day))].sort()) {
    const today = books.moves.filter((m) => m.day === day);
    for (const m of today) if (m.kind !== "production" && m.qty > 0) receive(m, m.kind === "purchase" || m.kind === "transfer" || m.kind === "opening" ? m.cost : 0);
    // Batches in the order they were made (rows without a batch id, from an older server, are one batch); what a batch
    // used is shared between what it made, by the cost the kitchen recorded for each.
    const batches = new Map<string, Move[]>();
    for (const m of today) if (m.kind === "production") batches.set(m.batch ?? "", [...(batches.get(m.batch ?? "") ?? []), m]);
    for (const made of [...batches.values()].sort((a, b) => (a[0].at ?? "").localeCompare(b[0].at ?? ""))) {
      const outs = made.filter((m) => m.qty > 0);
      for (const m of made) if (m.qty <= 0) issue(m);
      const spent = -made.filter((m) => m.qty <= 0).reduce((n, m) => n + worth.get(m)!, 0), noted = outs.reduce((n, m) => n + m.cost, 0);
      let left = spent;
      outs.forEach((m, i) => { const share = spent <= 0 ? m.cost : i === outs.length - 1 ? left : Math.floor(spent * (noted > 0 ? m.cost / noted : 1 / outs.length)); left -= share; receive(m, share); });
    }
    for (const m of today) if (m.kind !== "production" && m.qty <= 0) issue(m);
  }
  return { stock, worth, unseen };
}

// Sales per menu item, before the order's discount, with what the ingredients cost at their average. known = every
// ingredient of every portion has a cost, so the margin can be trusted. The gross column adds up to recap's gross.
export interface ItemRow { id: string; name: string; category: string; type: MenuType; qty: number; gross: number; cost: number; known: boolean }
export function itemSales(orders: BookOrder[], menu: MenuItem[], r: Range, stock: Stock): ItemRow[] {
  const items = new Map(menu.map((m) => [m.id, m])), rows = new Map<string, ItemRow>();
  for (const o of orders) {
    if (!isSale(o) || !within(r, o.payment?.at)) continue;
    for (const l of o.lines.filter((l) => !l.cancelled)) {
      const m = items.get(l.itemId), use = lineUse(l);
      const x = rows.get(l.itemId) ?? { id: l.itemId, name: l.name, category: m?.category ?? "Tidak lagi di menu", type: m ? menuType(m) : "food", qty: 0, gross: 0, cost: 0, known: true };
      x.qty += l.qty;
      x.gross += gross(l);
      x.cost += use.reduce((n, u) => n + u.qty * (stock[u.stockId]?.[2] ?? 0), 0);
      x.known = x.known && use.length > 0 && use.every((u) => (stock[u.stockId]?.[2] ?? 0) > 0);
      rows.set(l.itemId, x);
    }
  }
  return [...rows.values()].sort((a, b) => a.category.localeCompare(b.category) || b.gross - a.gross);
}

// Per ingredient: what was on hand when the range started, what came in and went out by kind, what is left, and what
// it was and is worth at average cost. Quantities are thousandths of the base unit; "other" is opening stock and adjustments.
export interface StockRow {
  id: string; name: string; unit: string; opening: number; purchase: number; production: number; transfer: number
  used: number; waste: number; count: number; other: number; closing: number; average: number; before: number; value: number
}
export function stockLedger(books: Pick<Books, "moves" | "opening">, items: Pick<StockItem, "id" | "name" | "unit">[], before: Stock, after: Stock, unseen: Record<string, number> = {}): StockRow[] {
  const names = new Map(items.map((s) => [s.id, s])), rows = new Map<string, StockRow>();
  const row = (id: string) => {
    let x = rows.get(id);
    if (!x) rows.set(id, (x = { id, name: names.get(id)?.name ?? id, unit: names.get(id)?.unit ?? "", opening: 0, purchase: 0, production: 0, transfer: 0, used: 0, waste: 0, count: 0, other: 0, closing: 0, average: after[id]?.[2] ?? 0, before: (before[id]?.[1] ?? 0) + (unseen[id] ?? 0), value: after[id]?.[1] ?? 0 }));
    return x;
  };
  for (const [id, qty] of Object.entries(books.opening)) row(id).opening = qty;
  for (const m of books.moves) row(m.stockId)[m.kind === "preparation" ? "used" : m.kind === "opening" || m.kind === "adjustment" ? "other" : m.kind] += m.qty;
  for (const x of rows.values()) x.closing = x.opening + x.purchase + x.production + x.transfer + x.used + x.waste + x.count + x.other;
  return [...rows.values()].filter((x) => x.opening || x.closing || x.purchase || x.production || x.transfer || x.used || x.waste || x.count || x.other).sort((a, b) => a.name.localeCompare(b.name));
}

// Purchase orders that moved in the range or still had something owed when it ended. Payments settle the oldest
// delivery first; what is left of each delivery is aged from the day it arrived to the end of the range.
export interface PayRow { id: string; number: string; supplier: string; receivedIn: number; paidIn: number; owed: number; d0: number; d31: number; d61: number; d91: number }
export function payables(orders: PurchaseOrder[], r: Range): PayRow[] {
  const end = Date.parse(r.to), sum = (list: { at: string; amount: number }[], from: string) => list.filter((x) => { const d = r.dayOf(x.at); return d >= from && d <= r.to; }).reduce((n, x) => n + x.amount, 0);
  return orders.filter((p) => p.status !== "cancelled").map((p) => {
    const arrived = p.receipts.map((x) => ({ at: x.at, amount: x.lines.reduce((n, l) => n + l.cost, 0) })).sort((a, b) => a.at.localeCompare(b.at));
    const row = { id: p.id, number: p.number, supplier: p.supplier, receivedIn: sum(arrived, r.from), paidIn: sum(p.payments, r.from), owed: 0, d0: 0, d31: 0, d61: 0, d91: 0 };
    let paid = sum(p.payments, "");
    for (const x of arrived) {
      const day = r.dayOf(x.at);
      if (day > r.to) continue;
      const left = Math.max(0, x.amount - Math.max(0, paid)), age = (end - Date.parse(day)) / 864e5;
      paid -= x.amount;
      row.owed += left;
      row[age <= 30 ? "d0" : age <= 60 ? "d31" : age <= 90 ? "d61" : "d91"] += left;
    }
    return row;
  }).filter((x) => x.receivedIn || x.paidIn || x.owed).sort((a, b) => a.supplier.localeCompare(b.supplier) || a.number.localeCompare(b.number));
}

// The accounts the journal posts to: a starting code, a name, and where the account sits in the statements. The
// accounting team renames them to their own chart on the Akuntansi page; the keys are what the code below posts to.
export type AccountKind = "asset" | "liability" | "equity" | "revenue" | "cogs" | "loss" | "opex" | "other";
export const ACCOUNTS = {
  cash: ["1-1100", "Kas laci kasir", "asset"], qris: ["1-1210", "Bank · QRIS", "asset"], card: ["1-1220", "Bank · kartu", "asset"], outside: ["1-1300", "Kas & bank di luar laci", "asset"],
  receivable: ["1-1400", "Piutang usaha", "asset"], inventory: ["1-1500", "Persediaan bahan", "asset"], transit: ["1-1600", "Rekening antar outlet", "asset"],
  payable: ["2-1100", "Hutang usaha", "liability"], tax: ["2-1200", "Hutang pajak restoran (PB1)", "liability"], service: ["2-1300", "Titipan service charge", "liability"],
  capital: ["3-1100", "Modal pemilik", "equity"], draw: ["3-1200", "Prive pemilik", "equity"], equity: ["3-1900", "Saldo awal & penyesuaian persediaan", "equity"],
  food: ["4-1100", "Penjualan makanan", "revenue"], beverage: ["4-1200", "Penjualan minuman", "revenue"], snack: ["4-1300", "Penjualan camilan", "revenue"], staff: ["4-1400", "Penjualan makan staf", "revenue"], catering: ["4-1500", "Penjualan katering", "revenue"],
  discount: ["4-1800", "Diskon penjualan", "revenue"], returns: ["4-1900", "Retur penjualan", "revenue"],
  cogs: ["5-1100", "HPP bahan terjual", "cogs"],
  compliment: ["6-1100", "Beban compliment", "loss"], waste: ["6-1200", "Beban bahan terbuang", "loss"], shrink: ["6-1300", "Selisih persediaan", "loss"], cashGap: ["6-1400", "Selisih kas", "loss"],
  rent: ["6-2100", "Sewa", "opex"], payroll: ["6-2200", "Gaji & upah", "opex"], utilities: ["6-2300", "Listrik, air & gas", "opex"], telecom: ["6-2400", "Internet & telepon", "opex"], supplies: ["6-2500", "Perlengkapan & kebersihan", "opex"],
  repairs: ["6-2600", "Perbaikan & pemeliharaan", "opex"], marketing: ["6-2700", "Pemasaran", "opex"], bankFees: ["6-2800", "Biaya bank & EDC", "opex"], otherExpense: ["6-2900", "Biaya lain-lain", "opex"], cashOut: ["6-2950", "Kas keluar dari laci", "opex"],
  income: ["7-1100", "Pendapatan lain (kas masuk)", "other"],
} as const satisfies Record<string, readonly [string, string, AccountKind]>;
export type Account = keyof typeof ACCOUNTS;
const accounts = Object.keys(ACCOUNTS) as Account[];
export const zero = () => Object.fromEntries(accounts.map((k) => [k, 0])) as Record<Account, number>;
// What a cash-book entry can be: a label, the account it debits and the one it credits. Paid from, or into, the money
// outside the drawer; cash taken from the drawer is recorded at the till as before.
export const CASHBOOK = {
  rent: ["Sewa", "rent", "outside"], payroll: ["Gaji & upah", "payroll", "outside"], utilities: ["Listrik, air & gas", "utilities", "outside"], telecom: ["Internet & telepon", "telecom", "outside"],
  supplies: ["Perlengkapan & kebersihan", "supplies", "outside"], repairs: ["Perbaikan & pemeliharaan", "repairs", "outside"], marketing: ["Pemasaran", "marketing", "outside"],
  bankFees: ["Biaya bank & EDC", "bankFees", "outside"], otherExpense: ["Biaya lain-lain", "otherExpense", "outside"],
  taxPaid: ["Setor PB1 ke pemerintah daerah", "tax", "outside"], servicePaid: ["Bagi service charge ke staf", "service", "outside"],
  capital: ["Setoran modal pemilik", "outside", "capital"], draw: ["Pengambilan pemilik (prive)", "draw", "outside"],
} as const satisfies Record<string, readonly [string, Account, Account]>;
export type CashKind = keyof typeof CASHBOOK;
export interface Entry { day: string; ref: string; memo: string; account: Account; debit: number; credit: number }
type Legs = Map<string, { day: string; ref: string; memo: string; legs: Map<Account, number> }>;
// A leg is a debit when positive and a credit when negative; legs on the same account of one journal net out.
const leg = (book: Legs, day: string, ref: string, memo: string, account: Account, amount: number) => {
  const key = `${day}|${ref}`, e = book.get(key) ?? { day, ref: `${ref}-${day.replaceAll("-", "")}`, memo, legs: new Map<Account, number>() };
  e.legs.set(account, (e.legs.get(account) ?? 0) + amount);
  book.set(key, e);
};
const lines = (book: Legs): Entry[] => [...book.values()].sort((a, b) => a.day.localeCompare(b.day)).flatMap((e) =>
  accounts.flatMap((account) => { const v = e.legs.get(account) ?? 0; return v ? [{ day: e.day, ref: e.ref, memo: e.memo, account, debit: Math.max(0, v), credit: Math.max(0, -v) }] : []; }).sort((a, b) => Number(b.debit > 0) - Number(a.debit > 0)));

// The range as double-entry journals, one per business day and kind, each balanced. Sales post at payment, refunds on
// the day given back, purchases at what was paid for them, and stock leaves at its average cost (valuation above).
// Returns the stock as the range leaves it, for the days after.
export function journal(books: Books, menu: MenuItem[], r: Range, before: Stock = {}) {
  const types = new Map(menu.map((m) => [m.id, menuType(m)])), book: Legs = new Map(), { stock, worth, unseen } = valuation(books, before);
  const post = (day: string, ref: string, memo: string, account: Account, amount: number) => leg(book, day, ref, memo, account, amount);
  const pair = (day: string, ref: string, memo: string, debit: Account, credit: Account, amount: number) => { if (amount) { post(day, ref, memo, debit, amount); post(day, ref, memo, credit, -amount); } };

  for (const o of books.orders) {
    const t = o.totals, method = o.payment?.method, till = method && method !== "none" ? method : undefined, paid = within(r, o.payment?.at), back = within(r, o.refund?.at);
    if (paid) {
      if (till) post(paid, "JUAL", "Penjualan kasir", till, t.total);
      if (isSale(o)) {
        post(paid, "JUAL", "Penjualan kasir", "discount", t.discount);
        for (const l of o.lines.filter((l) => !l.cancelled)) post(paid, "JUAL", "Penjualan kasir", types.get(l.itemId) ?? "food", -gross(l));
        post(paid, "JUAL", "Penjualan kasir", "service", -t.service);
        post(paid, "JUAL", "Penjualan kasir", "tax", -t.tax);
      } else if (till) post(paid, "JUAL", "Penjualan kasir", "staff", -t.total);
    }
    if (back && till) {
      post(back, "RETUR", "Pengembalian dana", till, -t.total);
      if (isSale(o)) { post(back, "RETUR", "Pengembalian dana", "returns", t.subtotal - t.discount); post(back, "RETUR", "Pengembalian dana", "service", t.service); post(back, "RETUR", "Pengembalian dana", "tax", t.tax); }
      else post(back, "RETUR", "Pengembalian dana", "staff", t.total);
    }
  }

  // Stock on hand that Takar had no price for (never seen, or carried in at no worth) comes in at the latest known price.
  for (const v of Object.values(unseen)) pair(r.from, "SALDO", "Saldo awal & penyesuaian stok", "inventory", "equity", v);
  const bought = new Map<string, number>();
  for (const m of books.moves) {
    const w = worth.get(m) ?? 0;
    if (m.kind === "preparation") pair(m.day, "HPP", "Bahan terpakai", m.comp ? "compliment" : "cogs", "inventory", -w);
    else if (m.kind === "waste") pair(m.day, "BUANG", "Bahan terbuang", "waste", "inventory", -w);
    else if (m.kind === "count") pair(m.day, "HITUNG", "Selisih hitung stok", "inventory", "shrink", w);
    else if (m.kind === "opening" || m.kind === "adjustment") pair(m.day, "SALDO", "Saldo awal & penyesuaian stok", "inventory", "equity", w);
    else if (m.kind === "production") pair(m.day, "PRODUKSI", "Selisih nilai produksi", "inventory", "shrink", w);
    else if (m.kind === "transfer") {
      // Both ways at the transfer's own value (negative for stock that left), so a cancelled one clears the account and
      // the outlet it reaches owes what this one is owed. Where this outlet's average differs, that is a stock difference.
      pair(m.day, "TRANSFER", "Transfer antar outlet", "inventory", "transit", m.cost);
      pair(m.day, "TRANSFER", "Transfer antar outlet", "inventory", "shrink", w - m.cost);
    } else {
      // A delivery is worth what was paid for it. When it lands in a stock that had run below zero the average moves
      // what was there too; that part is a stock difference, not something owed to anyone.
      bought.set(m.day, (bought.get(m.day) ?? 0) + m.cost);
      pair(m.day, "BELI", "Pembelian bahan", "inventory", "shrink", w - m.cost);
    }
  }
  // Purchases: what came in on a purchase order is owed to the supplier; the rest was bought on the spot, from the
  // drawer when a cash movement carries the purchase, otherwise with money from outside the till.
  const onOrder = new Map<string, number>(), fromDrawer = new Map<string, number>(), documents = new Set<number>();
  for (const p of books.purchaseOrders) {
    for (const x of p.receipts) { const d = within(r, x.at); if (d) onOrder.set(d, (onOrder.get(d) ?? 0) + x.lines.reduce((n, l) => n + l.cost, 0)); }
    for (const x of p.payments) { if (x.from === "drawer") documents.add(Date.parse(x.at)); const d = within(r, x.at); if (d) pair(d, "BAYAR", "Pembayaran pemasok", "payable", x.from === "drawer" ? "cash" : "outside", x.amount); }
  }
  for (const s of books.salesOrders) {
    // CAT-2: what a cancelled order keeps (down payment not given back) is income on the day it was cancelled; the receivable ends at 0.
    const kept = s.status === "cancelled" ? within(r, s.updatedAt) : "", keep = s.payments.reduce((n, x) => n + x.amount, 0);
    if (kept && keep > 0) pair(kept, "KATERING", "Uang muka katering hangus", "receivable", "catering", keep);
    const d = s.status === "delivered" ? within(r, s.deliveredAt) : "";
    if (d) { post(d, "KATERING", "Pesanan katering terkirim", "receivable", s.totals.total); post(d, "KATERING", "Pesanan katering terkirim", "catering", s.totals.discount - s.totals.subtotal); post(d, "KATERING", "Pesanan katering terkirim", "service", -s.totals.service); post(d, "KATERING", "Pesanan katering terkirim", "tax", -s.totals.tax); }
    for (const x of s.payments) { if (x.from === "drawer") documents.add(Date.parse(x.at)); const paid = within(r, x.at); if (paid) pair(paid, "TERIMA", "Pembayaran katering", x.from === "drawer" ? "cash" : "outside", "receivable", x.amount); }
  }
  // Drawer cash: a movement tied to a purchase or written by a purchase order or catering payment is already posted
  // above; what is left is cash someone took out or put in by hand, each with its own reason.
  let n = 0;
  for (const c of [...books.cash].sort((a, b) => a.at.localeCompare(b.at))) {
    const d = within(r, c.at);
    if (!d) continue;
    if (c.recordId) fromDrawer.set(d, (fromDrawer.get(d) ?? 0) - c.amount);
    else if (!documents.has(Date.parse(c.at))) { const ref = `KAS${++n}`; if (c.amount < 0) pair(d, ref, `Kas keluar: ${c.reason}`, "cashOut", "cash", -c.amount); else pair(d, ref, `Kas masuk: ${c.reason}`, "cash", "income", c.amount); }
  }
  for (const [d, total] of bought) {
    const owed = Math.min(total, onOrder.get(d) ?? 0), till = Math.min(total - owed, fromDrawer.get(d) ?? 0);
    pair(d, "BELI", "Pembelian bahan", "inventory", "payable", owed);
    pair(d, "BELI", "Pembelian bahan", "inventory", "cash", till);
    pair(d, "BELI", "Pembelian bahan", "inventory", "outside", total - owed - till);
  }
  // The drawer between shifts: a float put in, or the takings above the next float carried out to the safe or the bank.
  for (const o of books.opened) { const d = within(r, o.at); if (d) pair(d, "MODAL", "Modal laci & setoran kas", "cash", "outside", o.opening - (o.prior ?? o.opening)); }
  // A drawer that counted short or over when the shift closed. With EDC slips, counted and expected hold the drawer
  // plus every machine, so the machines come back out. A gap on an EDC slip is not posted: it is a question for the
  // bank until someone settles it, and the Sif tab lists it.
  for (const s of books.shifts) {
    const d = within(r, s.closedAt);
    if (d && s.counted != null && s.expected != null) pair(d, "SELISIH", "Selisih kas saat tutup sif", "cash", "cashGap", s.counted - s.expected - (s.settlements ?? []).reduce((n, x) => n + x.slip - x.expected, 0));
  }
  return { entries: lines(book), stock, unseen };
}

// The cash book as journals, one per entry.
export function cashbook(entries: CashEntry[]): Entry[] {
  const book: Legs = new Map();
  [...entries].sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id)).forEach((e, i) => {
    const [label, debit, credit] = CASHBOOK[e.kind] ?? CASHBOOK.otherExpense, memo = e.note ? `${label}: ${e.note}` : label;
    leg(book, e.day, `KB${i + 1}`, memo, debit, e.amount);
    leg(book, e.day, `KB${i + 1}`, memo, credit, -e.amount);
  });
  return lines(book);
}

// Debit minus credit per account over a journal, on top of what was there before.
export function balances(entries: Entry[], before?: Record<Account, number>) {
  const sum = { ...(before ?? zero()) };
  for (const e of entries) sum[e.account] += e.debit - e.credit;
  return sum;
}
const of = (b: Record<Account, number>, kind: AccountKind) => accounts.filter((k) => ACCOUNTS[k][2] === kind).reduce((n, k) => n + b[k], 0);
// Profit and loss from a range's balances: sales down to what the ingredients cost, what was lost, and the running
// costs the accounting team wrote into the cash book.
export function profit(b: Record<Account, number>) {
  const sales = -(b.food + b.beverage + b.snack), net = sales - b.discount - b.returns, revenue = -of(b, "revenue"), margin = revenue - b.cogs;
  const losses = of(b, "loss"), opex = of(b, "opex"), other = -of(b, "other");
  return { sales, net, revenue, margin, losses, opex, other, result: margin - losses - opex + other };
}
// The balance sheet when the range ends: what the business holds, what it owes, and the owners' part, which is their
// capital plus every profit so far. opening = balances carried into the range, period = the range's own.
export function position(opening: Record<Account, number>, period: Record<Account, number>) {
  const end = { ...opening };
  for (const k of accounts) end[k] += period[k];
  const pick = (kind: AccountKind, sign: number) => accounts.filter((k) => ACCOUNTS[k][2] === kind).map((k) => ({ account: k, amount: sign * end[k] || 0 }));
  const assets = pick("asset", 1), liabilities = pick("liability", -1), equity = pick("equity", -1), retained = profit(opening).result, current = profit(period).result;
  const total = (rows: { amount: number }[]) => rows.reduce((n, x) => n + x.amount, 0);
  return { assets, liabilities, equity, retained, current, totalAssets: total(assets), totalLiabilities: total(liabilities), totalEquity: total(equity) + retained + current };
}
// The general ledger: per account, what it stood at when the range started, every journal line in it with the
// running balance, and where it ends. Balances are debit minus credit.
export function ledger(entries: Entry[], opening: Record<Account, number>) {
  return accounts.flatMap((account) => {
    let balance = opening[account];
    const rows = entries.filter((e) => e.account === account).map((e) => ({ ...e, balance: (balance += e.debit - e.credit) }));
    return rows.length || opening[account] ? [{ account, opening: opening[account], rows, closing: balance }] : [];
  });
}
