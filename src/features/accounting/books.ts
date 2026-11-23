import { balances, journal, openings, sumMoves, zero, type Account, type Books, type CashEntry, type Range, type Stock } from "../../domain/accounting";
import { unitCosts } from "../../domain/calculate";
import type { Identity, MenuItem } from "../../domain/types";
import type { MejaDB } from "../../lib/db";
import { supabase } from "../../lib/supabase";

// What a stretch of days leaves for the days after it: every account's balance and the stock with its average cost.
export interface Carry { balances: Record<Account, number>; stock: Stock }
type Load = (from: string, to: string) => Promise<Books>;
export const addDays = (d: string, days: number) => new Date(Date.parse(`${d}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
const monthEnd = (d: string) => addDays(`${addDays(`${d.slice(0, 8)}28`, 4).slice(0, 8)}01`, -1);

// The demo, and a signed-in store the server could not answer for: the books from what this device holds.
export async function localBooks(db: MejaDB, r: Range): Promise<Books> {
  const [orders, movements, shifts, cash, purchaseOrders, salesOrders, book, seed] = await Promise.all([db.orders.toArray(), db.movements.toArray(), db.shifts.toArray(), db.cash.toArray(), db.purchaseOrders.toArray(), db.salesOrders.toArray(), db.meta.get("ledger"), db.meta.get("costs")]);
  // Prices known by the end of the range, like the server: a later purchase must not change a month that has ended.
  const costs = Object.fromEntries(unitCosts(movements.filter((m) => r.dayOf(m.at) <= r.to), JSON.parse(seed?.value || "{}")));
  return { orders, ...sumMoves(movements, new Set(orders.filter((o) => o.mode === "compliment").map((o) => o.id)), r), costs, shifts, opened: openings(shifts, r), cash, purchaseOrders, salesOrders, entries: JSON.parse(book?.value || "[]") };
}
export const serverBooks: Load = async (from, to) => {
  const { data, error } = await supabase!.rpc("accounting_data", { from_day: from, to_day: to });
  if (error) throw new Error(error.message);
  return data as unknown as Books;
};

// The balances and stock on the morning of `from`, worked forward from `start` (the store's first day). The server
// answers for at most 93 days at a time, so history is walked a calendar month at a time. A month that has ended does
// not change any more, so what it leaves behind is kept on this laptop under `cache` and the next visit starts there
// ("Hitung ulang dari awal" on the page throws the kept months away).
// ponytail: the checkpoints live in this browser; keep them on the server once history is long or laptops are many.
export async function carryTo(load: Load, menu: MenuItem[], dayOf: Range["dayOf"], start: string, from: string, today: string, cache?: string): Promise<Carry> {
  let marks: Record<string, Carry> = {};
  try { if (cache) marks = JSON.parse(localStorage.getItem(cache) || "{}"); } catch { /* unreadable: start over */ }
  const last = Object.keys(marks).filter((d) => d >= start && d < from).sort().at(-1);
  let carry: Carry = last ? marks[last] : { balances: zero(), stock: {} }, cursor = last ? addDays(last, 1) : start;
  while (cursor < from) {
    // Without a cache (the demo, where everything is on the device) the whole stretch is read at once.
    const end = cache ? monthEnd(cursor) : addDays(from, -1), to = end < from ? end : addDays(from, -1);
    const done = journal(await load(cursor, to), menu, { from: cursor, to, dayOf }, carry.stock);
    carry = { balances: balances(done.entries, carry.balances), stock: done.stock };
    // The server still takes an operation up to 7 days late (a till that was offline over the month's last night), so a
    // month is kept only from the 8th business day after it ends, when nothing more can land in it.
    if (cache && to === end && addDays(end, 8) <= today) {
      marks[end] = carry;
      for (const old of Object.keys(marks).sort().slice(0, -36)) delete marks[old];
      try { localStorage.setItem(cache, JSON.stringify(marks)); } catch { /* storage full or private mode: worked out again next time */ }
    }
    cursor = addDays(to, 1);
  }
  return carry;
}

// The cash book is written online: the server for a signed-in store, the device for the demo.
export async function saveEntry(db: MejaDB, user: Identity, entry: CashEntry) {
  if (user.demo || !supabase) { const book = await db.meta.get("ledger"); await db.meta.put({ id: "ledger", value: JSON.stringify([...JSON.parse(book?.value || "[]"), entry]) }); return; }
  const { error } = await supabase.rpc("ledger_save", { entry: { ...entry } });
  if (error) throw new Error("Catatan belum tersimpan. Periksa sambungan internet, lalu coba lagi.");
}
export async function removeEntry(db: MejaDB, user: Identity, id: string) {
  if (user.demo || !supabase) { const book = await db.meta.get("ledger"); await db.meta.put({ id: "ledger", value: JSON.stringify((JSON.parse(book?.value || "[]") as CashEntry[]).filter((e) => e.id !== id)) }); return; }
  const { error } = await supabase.rpc("ledger_remove", { entry_id: id });
  if (error) throw new Error("Catatan belum terhapus. Periksa sambungan internet, lalu coba lagi.");
}
