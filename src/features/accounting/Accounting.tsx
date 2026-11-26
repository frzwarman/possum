import { useEffect, useMemo, useState } from "react";
import { Navigate } from "@tanstack/react-router";
import { AlertCircle, Boxes, Percent, Printer, ReceiptText, Trash2, Wallet } from "lucide-react";
import { useApp } from "../../app/context";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { SkeletonRows } from "../../components/ui/loading";
import { Money } from "../../components/ui/money";
import { Select } from "../../components/ui/select";
import { ACCOUNTS, CASHBOOK, balances, cashbook, itemSales, journal, ledger, payables, position, profit, recap, stockLedger, zero, type Account, type Books, type CashEntry, type CashKind, type Range } from "../../domain/accounting";
import { businessDay, paidValue, quantity, rupiah as money, typeLabel, when } from "../../domain/calculate";
import { can } from "../../domain/permissions";
import { csv, download, uid } from "../../lib/db";
import { supabase } from "../../lib/supabase";
import { workbook, type Format } from "../../lib/xlsx";
import { addDays, carryTo, localBooks, removeEntry, saveEntry, serverBooks, type Carry } from "./books";

// One table per tab, the same on screen, in print, in the CSV and in the Excel workbook. rp = rupiah, qty =
// thousandths of a base unit, pct = a share of one; an empty string is a blank cell.
type Cell = string | number;
type Kind = "text" | "rp" | "qty" | "num" | "pct";
interface Sheet { id: string; label: string; head: string[]; kinds: Kind[]; rows: Cell[][]; foot?: Cell[]; strong?: number[]; empty: string; note: string }
// A credit balance of nothing is −0 once its sign is turned; it must not print as "-Rp0".
const rupiah = (v: number) => money(v || 0);
type Chart = Record<Account, readonly [string, string]>;
const show = (v: Cell, k: Kind) => (v === "" ? "" : k === "rp" ? rupiah(v as number) : k === "qty" ? quantity(v as number) : k === "pct" ? `${Math.round((v as number) * 100)}%` : String(v));
// For a file: quantities in whole units, a share as a fraction (Excel formats it) or as a percentage (CSV).
export const plain = (v: Cell, k: Kind, percent = false) => (typeof v !== "number" || k === "text" || k === "rp" || k === "num" ? v : k === "qty" ? (v as number) / 1000 : percent ? Math.round((v as number) * 1000) / 10 : v);
const FORMAT: Record<Kind, Format> = { text: "text", rp: "int", num: "int", qty: "dec", pct: "pct" };
const html = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const DAYS = 93, DATE = /^\d{4}-\d\d-\d\d$/;
// ponytail: the chart of accounts lives on this laptop; move it into the store's settings when two laptops need the same one.
const firstChart = Object.fromEntries(Object.entries(ACCOUNTS).map(([k, v]) => [k, [v[0], v[1]]])) as unknown as Chart;
const savedChart = (): Chart => { try { return { ...firstChart, ...JSON.parse(localStorage.getItem("takar-accounts") || "{}") }; } catch { return firstChart; } };
const kinds = Object.entries(CASHBOOK).map(([value, [label]]) => ({ value, label }));

// The books for the accounting team: profit and loss, the balance sheet, the day's sales the way a ledger wants them,
// what the stock did and is worth, what is owed to suppliers, each shift's cash, the cash book of running costs, and a
// journal and general ledger ready for their accounting software.
export default function Accounting() {
  const { user, db, settings, menu, stockItems, act, busy } = useApp();
  const tz = settings?.timezone, cutoff = settings?.cutoff, today = businessDay(new Date().toISOString(), tz, cutoff);
  const first = `${today.slice(0, 8)}01`, lastEnd = addDays(first, -1);
  const spans: Record<string, [string, string]> = { day: [today, today], yesterday: [addDays(today, -1), addDays(today, -1)], week: [addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7)), today], month: [first, today], last: [`${lastEnd.slice(0, 8)}01`, lastEnd] };
  const [period, setPeriod] = useState("month");
  const [from, setFrom] = useState(first);
  const [to, setTo] = useState(today);
  const [tab, setTab] = useState("laba-rugi");
  const [again, setAgain] = useState(0);
  const [chart, setChart] = useState(savedChart);
  const [editing, setEditing] = useState<Record<string, [string, string]>>();
  const [form, setForm] = useState<{ day: string; kind: CashKind; amount: string; note: string }>();
  const [removing, setRemoving] = useState<CashEntry>();
  const [data, setData] = useState<{ key: string; books: Books; carry: Carry; server: boolean; error?: string }>();
  const valid = DATE.test(from) && DATE.test(to) && from <= to && Date.parse(to) - Date.parse(from) < DAYS * 864e5;
  const key = `${from}|${to}|${again}`, local = user.demo || !supabase;
  // The store's first day: history before the range is walked from there, so the balance sheet and the average cost of
  // stock start where the store did. Without one on record the range stands by itself. The number in the key of the kept
  // months goes up whenever what a month leaves behind is worked out differently, so no laptop builds on months kept the old way.
  const start = local ? "2000-01-01" : DATE.test(settings?.goLive ?? "") ? settings!.goLive : from, marks = `takar-books-2-${user.restaurantId}-${start}`;
  useEffect(() => {
    if (!valid || !settings) return;
    let live = true;
    const dayOf = (iso: string) => businessDay(iso, tz, cutoff), mine = (f: string, t: string) => localBooks(db, { from: f, to: t, dayOf });
    void (async () => {
      let next: Omit<NonNullable<typeof data>, "key">;
      if (local) next = { carry: await carryTo(mine, menu, dayOf, start, from, today), books: await mine(from, to), server: false };
      else try { next = { carry: await carryTo(serverBooks, menu, dayOf, start, from, today, marks), books: await serverBooks(from, to), server: true }; }
      // The server could not answer (offline, or not updated yet): show what this device holds and say that it may be short.
      catch (e) { next = { carry: { balances: zero(), stock: {} }, books: await mine(from, to), server: false, error: e instanceof Error ? e.message : String(e) }; }
      if (live) setData({ key, ...next });
    })();
    return () => { live = false; };
    // menu and settings are read as they are when the range is asked for; a reload asks again.
  }, [key, valid, local, db, Boolean(settings), menu.length]);
  const ready = valid && data?.key === key ? data : undefined;

  const view = useMemo(() => {
    if (!ready) return undefined;
    const { books, carry } = ready, range: Range = { from, to, dayOf: (iso) => businessDay(iso, tz, cutoff) }, name = (k: Account) => chart[k][1];
    const done = journal(books, menu, range, carry.stock), noted = books.entries.filter((e) => e.day >= from && e.day <= to).sort((a, b) => a.day.localeCompare(b.day));
    const entries = [...done.entries, ...cashbook(noted)].sort((a, b) => a.day.localeCompare(b.day));
    const opening = balances(cashbook(books.entries.filter((e) => e.day < from)), carry.balances), b = balances(entries), p = profit(b), sheet = position(opening, b), book = ledger(entries, opening);
    const days = recap(books.orders, range), items = itemSales(books.orders, menu, range, done.stock), stock = stockLedger(books, stockItems, carry.stock, done.stock, done.unseen), owed = payables(books.purchaseOrders, range);
    const total = <T,>(rows: T[], f: (r: T) => number) => rows.reduce((n, r) => n + f(r), 0);
    const closed = books.shifts.filter((s) => s.closedAt && range.dayOf(s.closedAt) >= from && range.dayOf(s.closedAt) <= to).sort((a, b) => a.closedAt!.localeCompare(b.closedAt!));
    const receivable = total(books.salesOrders.filter((s) => s.status === "delivered"), (s) => Math.max(0, s.totals.total - paidValue(s)));
    // [label, amount, a subtotal?, shown even at zero?]: lines that only matter when they happened are left out at zero.
    type Line = [string, Cell, boolean?, boolean?];
    const part = (kind: string) => (Object.keys(ACCOUNTS) as Account[]).filter((k) => ACCOUNTS[k][2] === kind).map((k): Line => [`   ${name(k)}`, -b[k]]);
    const pl: Line[] = [
      ["Penjualan kotor", p.sales, false, true], [`   ${name("food")}`, -b.food], [`   ${name("beverage")}`, -b.beverage], [`   ${name("snack")}`, -b.snack],
      [name("discount"), -b.discount], [name("returns"), -b.returns], ["Penjualan bersih", p.net, true],
      [name("staff"), -b.staff], [name("catering"), -b.catering], ["Pendapatan", p.revenue, true],
      [name("cogs"), -b.cogs, false, true], [`Laba kotor${p.revenue ? ` (${Math.round((p.margin / p.revenue) * 100)}% dari pendapatan)` : ""}`, p.margin, true],
      ["Selisih & susut", -p.losses, false, true], ...part("loss"), ["Biaya operasional", -p.opex, false, true], ...part("opex"), [name("income"), p.other],
      ["Laba bersih", p.result, true],
    ];
    const side = (title: string, rows: { account: Account; amount: number }[], sum: number, more: Line[] = []): Line[] => [[title, "", true], ...rows.filter((x) => x.amount).map((x): Line => [`   ${name(x.account)}`, x.amount]), ...more, [`Jumlah ${title.toLowerCase()}`, sum, true]];
    const bs: Line[] = [...side("Aset", sheet.assets, sheet.totalAssets), ...side("Kewajiban", sheet.liabilities, sheet.totalLiabilities),
      ...side("Ekuitas", sheet.equity, sheet.totalEquity, [["   Laba ditahan sampai awal rentang", sheet.retained, false, true], ["   Laba rentang ini", sheet.current, false, true]]), ["Jumlah kewajiban & ekuitas", sheet.totalLiabilities + sheet.totalEquity, true]];
    const statement = (list: Line[]) => { const shown = list.filter(([, v, strong, always]) => strong || always || v !== 0); return { rows: shown.map(([a, v]): Cell[] => [a, v]), strong: shown.flatMap(([, , strong], i) => (strong ? [i] : [])) }; };
    const sheets: Sheet[] = [
      { id: "laba-rugi", label: "Laba rugi", head: ["Pos", "Jumlah"], kinds: ["text", "rp"], ...statement(pl), empty: "", note: "Dari penjualan sampai laba bersih. Biaya operasional adalah yang dicatat di tab Biaya & kas, ditambah kas keluar dari laci." },
      { id: "neraca", label: "Neraca", head: ["Pos", "Jumlah"], kinds: ["text", "rp"], ...statement(bs), empty: "", note: `Posisi di akhir ${to}: saldo sejak ${local ? "awal data di perangkat ini" : start} ditambah jurnal rentang ini. Persediaan dinilai dengan harga rata-rata. Kas & bank di luar laci menampung semua uang di luar laci dan bisa negatif sampai modal pemilik dicatat di Biaya & kas; pinjaman dan aset tetap tidak dicatat di Takar.` },
      { id: "harian", label: "Rekap harian", head: ["Tanggal", "Transaksi", "Penjualan kotor", "Diskon", "Penjualan bersih", "Service", "PB1", "Total", "Makan staf", "Refund", "Tunai", "QRIS", "Kartu", "Diterima", "Compliment"], kinds: ["text", "num", "rp", "rp", "rp", "rp", "rp", "rp", "rp", "rp", "rp", "rp", "rp", "rp", "rp"],
        rows: days.map((d) => [d.day, d.orders, d.gross, d.discount, d.net, d.service, d.tax, d.total, d.staff, d.refunds, d.cash, d.qris, d.card, d.received, d.compliments]),
        foot: ["Jumlah", total(days, (d) => d.orders), total(days, (d) => d.gross), total(days, (d) => d.discount), total(days, (d) => d.net), total(days, (d) => d.service), total(days, (d) => d.tax), total(days, (d) => d.total), total(days, (d) => d.staff), total(days, (d) => d.refunds), total(days, (d) => d.cash), total(days, (d) => d.qris), total(days, (d) => d.card), total(days, (d) => d.received), total(days, (d) => d.compliments)],
        empty: "Belum ada pembayaran di rentang ini.", note: "Dihitung saat pembayaran. Diterima = Total + Makan staf − Refund = Tunai + QRIS + Kartu. Compliment adalah nilai yang diberikan gratis, bukan penjualan." },
      { id: "menu", label: "Per menu", head: ["Kategori", "Menu", "Jenis", "Terjual", "Penjualan kotor", "Biaya bahan", "Margin"], kinds: ["text", "text", "text", "num", "rp", "rp", "pct"],
        rows: items.map((i) => [i.category, i.name, typeLabel[i.type], i.qty, i.gross, i.known ? Math.round(i.cost) : "", i.known && i.gross ? (i.gross - i.cost) / i.gross : ""]),
        foot: ["Jumlah", "", "", total(items, (i) => i.qty), total(items, (i) => i.gross), "", ""], empty: "Belum ada menu terjual di rentang ini.", note: "Sebelum diskon pesanan. Biaya bahan memakai harga rata-rata; kosong bila ada bahan yang belum punya harga atau menu tanpa resep." },
      { id: "persediaan", label: "Persediaan", head: ["Bahan", "Satuan", "Awal", "Beli", "Produksi", "Transfer", "Terpakai", "Terbuang", "Selisih hitung", "Lainnya", "Akhir", "Nilai awal", "Harga rata-rata", "Nilai akhir"], kinds: ["text", "text", "qty", "qty", "qty", "qty", "qty", "qty", "qty", "qty", "qty", "rp", "rp", "rp"],
        rows: stock.map((s) => [s.name, s.unit, s.opening, s.purchase, s.production, s.transfer, s.used, s.waste, s.count, s.other, s.closing, s.before, Math.round(s.average * 1000), s.value]),
        foot: ["Jumlah", "", "", "", "", "", "", "", "", "", "", total(stock, (s) => s.before), "", total(stock, (s) => s.value)], empty: "Belum ada stok yang bergerak di rentang ini.", note: "Awal + Beli + Produksi + Transfer + Terpakai + Terbuang + Selisih hitung + Lainnya = Akhir. Nilai memakai harga rata-rata bergerak: kiriman masuk sebesar yang dibayar, yang keluar dinilai rata-ratanya. Lainnya adalah saldo awal dan penyesuaian." },
      { id: "hutang", label: "Hutang pemasok", head: ["Pemasok", "PO", "Diterima di rentang", "Dibayar di rentang", "Belum dibayar", "0–30 hari", "31–60 hari", "61–90 hari", "Lebih dari 90 hari"], kinds: ["text", "text", "rp", "rp", "rp", "rp", "rp", "rp", "rp"],
        rows: owed.map((o) => [o.supplier, o.number, o.receivedIn, o.paidIn, o.owed, o.d0, o.d31, o.d61, o.d91]),
        foot: ["Jumlah", "", total(owed, (o) => o.receivedIn), total(owed, (o) => o.paidIn), total(owed, (o) => o.owed), total(owed, (o) => o.d0), total(owed, (o) => o.d31), total(owed, (o) => o.d61), total(owed, (o) => o.d91)], empty: "Tidak ada kiriman, pembayaran atau hutang di rentang ini.", note: `Hutang per akhir ${to}, menurut umur sejak barang diterima; pembayaran melunasi kiriman tertua lebih dulu. Pembelian langsung tanpa PO dianggap lunas saat dibeli.${receivable ? ` Piutang katering yang belum lunas saat ini: ${rupiah(receivable)}.` : ""}` },
      { id: "sif", label: "Sif & kas", head: ["Ditutup", "Kasir", "Modal awal", "Kas seharusnya", "Kas dihitung", "Selisih kas", "Selisih EDC", "Slip EDC", "Disetujui"], kinds: ["text", "text", "rp", "rp", "rp", "rp", "rp", "text", "text"],
        rows: closed.map((s) => {
          const edc = s.settlements ?? [], slips = total(edc, (x) => x.slip), machines = total(edc, (x) => x.expected), known = s.counted != null && s.expected != null;
          return [when(s.closedAt!, tz), s.cashier, s.opening, known ? s.expected! - machines : "", known ? s.counted! - slips : "", known ? s.counted! - slips - (s.expected! - machines) : "", edc.length ? slips - machines : "", edc.map((x) => `${x.edc}: slip ${rupiah(x.slip)}, Takar ${rupiah(x.expected)}`).join("; "), s.varianceApprovedBy ?? ""];
        }), empty: "Belum ada sif yang ditutup di rentang ini.", note: "Selisih = dihitung − seharusnya. Selisih EDC adalah slip settlement dikurangi catatan Takar; cocokkan dengan mutasi bank." },
      { id: "biaya", label: "Biaya & kas", head: ["Tanggal", "Jenis", "Catatan", "Jumlah", "Dicatat oleh"], kinds: ["text", "text", "text", "rp", "text"],
        rows: noted.map((e) => [e.day, (CASHBOOK[e.kind] ?? CASHBOOK.otherExpense)[0], e.note, e.amount, e.by ?? ""]), foot: ["Jumlah", "", "", total(noted, (e) => e.amount), ""],
        empty: "Belum ada biaya yang dicatat di rentang ini.", note: "Uang yang tidak lewat kasir: sewa, gaji, listrik, setor PB1, modal pemilik. Semuanya dibayar dari, atau masuk ke, kas & bank di luar laci. Kas yang diambil dari laci dicatat di kasir seperti biasa." },
      { id: "jurnal", label: "Jurnal", head: ["Tanggal", "No. jurnal", "Kode akun", "Nama akun", "Keterangan", "Debit", "Kredit"], kinds: ["text", "text", "text", "text", "text", "rp", "rp"],
        rows: entries.map((e) => [e.day, e.ref, chart[e.account][0], name(e.account), e.memo, e.debit || "", e.credit || ""]),
        foot: ["Jumlah", "", "", "", "", total(entries, (e) => e.debit), total(entries, (e) => e.credit)], empty: "Belum ada yang bisa dijurnal di rentang ini.", note: "Satu jurnal per hari per jenis, debit selalu sama dengan kredit. Sesuaikan kode akun dengan bagan akun Anda sebelum mengimpor ke perangkat lunak akuntansi." },
      { id: "buku-besar", label: "Buku besar", head: ["Akun", "Tanggal", "No. jurnal", "Keterangan", "Debit", "Kredit", "Saldo"], kinds: ["text", "text", "text", "text", "rp", "rp", "rp"], empty: "Belum ada akun yang bergerak atau bersaldo.",
        note: "Per akun: saldo awal rentang, setiap baris jurnal, dan saldo berjalan. Saldo = debit − kredit, jadi akun kewajiban, ekuitas dan pendapatan bernilai negatif.",
        ...(() => { const rows: Cell[][] = [], strong: number[] = []; for (const a of book) { const label = `${chart[a.account][0]} ${name(a.account)}`; rows.push([label, "", "", "Saldo awal", "", "", a.opening], ...a.rows.map((e): Cell[] => [label, e.day, e.ref, e.memo, e.debit || "", e.credit || "", e.balance])); strong.push(rows.length); rows.push([label, "", "", "Saldo akhir", total(a.rows, (e) => e.debit), total(a.rows, (e) => e.credit), a.closing]); } return { rows, strong }; })() },
    ];
    return { sheets, p, noted, stockValue: total(stock, (s) => s.value) };
  }, [ready, menu, stockItems, chart, from, to, tz, cutoff, local, start]);

  if (!can(user.role, "accounting")) return <Navigate to="/" />;
  const sheet = view?.sheets.find((s) => s.id === tab) ?? view?.sheets[0];
  const pick = (p: string) => { setPeriod(p); if (spans[p]) { setFrom(spans[p][0]); setTo(spans[p][1]); } };
  const filled = (s: Sheet, percent: boolean) => [s.head, ...s.rows, ...(s.foot ? [s.foot] : [])].map((r) => r.map((v, i) => plain(v, s.kinds[i], percent)));
  const span = from === to ? from : `${from} sampai ${to}`;
  const exportSheet = () => sheet && download(`takar-${sheet.id}-${from}-${to}.csv`, csv(filled(sheet, true)), "text/csv");
  const exportAll = () => view && download(`takar-akuntansi-${from}-${to}.xlsx`, workbook(view.sheets.map((s) => ({ name: s.label, formats: s.kinds.map((k) => FORMAT[k]), bold: [...(s.strong ?? []).map((i) => i + 1), ...(s.foot ? [s.rows.length + 1] : [])], rows: filled(s, false) }))).buffer as ArrayBuffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  // PDF = the browser's print of a plain page with the same table as the screen, like Laporan.
  const print = () => {
    const w = sheet && window.open("", "_blank");
    if (!w) return;
    const cells = (r: Cell[], tag: string) => r.map((v, i) => `<${tag}${sheet.kinds[i] === "text" ? "" : ' class="n"'}>${html(tag === "th" ? String(v) : show(v, sheet.kinds[i]))}</${tag}>`).join("");
    w.document.write(`<!doctype html><title>${html(sheet.label)} ${span}</title><style>@page{size:A4 landscape;margin:12mm}body{font:11px/1.4 system-ui,sans-serif;color:#111}h1{font-size:17px;margin:0}p{margin:2px 0 12px;color:#555}table{border-collapse:collapse;width:100%}th,td{padding:4px 6px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top;white-space:pre-wrap}th{border-bottom:1px solid #111}.n{text-align:right;white-space:nowrap}.s td,tfoot td{font-weight:700;border-top:1px solid #111}</style><h1>${html(settings?.name || "")} · ${html(sheet.label)}</h1><p>${span}. ${html(sheet.note)}</p><table><thead><tr>${cells(sheet.head, "th")}</tr></thead><tbody>${sheet.rows.map((r, n) => `<tr${sheet.strong?.includes(n) ? ' class="s"' : ""}>${cells(r, "td")}</tr>`).join("")}</tbody>${sheet.foot ? `<tfoot><tr>${cells(sheet.foot, "td")}</tr></tfoot>` : ""}</table><p>Dicetak ${when(Date.now(), tz)} oleh ${html(user.name)}.</p>`);
    w.document.close();
    w.focus();
    w.print();
  };
  const saveChart = () => {
    const next = Object.fromEntries((Object.keys(ACCOUNTS) as Account[]).map((k) => [k, [editing![k][0].trim() || ACCOUNTS[k][0], editing![k][1].trim() || ACCOUNTS[k][1]] as const])) as Chart;
    try { localStorage.setItem("takar-accounts", JSON.stringify(next)); } catch { /* private mode: kept until the page closes */ }
    setChart(next);
    setEditing(undefined);
  };
  const saveForm = () => act(async () => { await saveEntry(db, user, { id: uid(), day: form!.day, kind: form!.kind, amount: Number(form!.amount), note: form!.note.trim(), by: user.name }); setForm(undefined); setAgain((n) => n + 1); }, "Catatan tersimpan");
  const remove = () => act(async () => { await removeEntry(db, user, removing!.id); setRemoving(undefined); setAgain((n) => n + 1); }, "Catatan dihapus");
  // Forget what earlier months left on this laptop and work the history out again from the store's first day.
  const recount = () => { try { localStorage.removeItem(marks); } catch { /* nothing kept */ } setAgain((n) => n + 1); };
  return (
    <section className="page-content accounting-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Untuk tim akuntansi</p>
          <h1>Akuntansi</h1>
          <p className="muted">{valid ? span : "Pilih rentang tanggal"}. Hari usaha berganti pukul {String(cutoff ?? 4).padStart(2, "0")}.00.</p>
        </div>
        <div className="report-actions">
          <Select ariaLabel="Periode" value={period} onChange={pick} options={[{ value: "day", label: "Hari ini" }, { value: "yesterday", label: "Kemarin" }, { value: "week", label: "Minggu ini" }, { value: "month", label: "Bulan ini" }, { value: "last", label: "Bulan lalu" }, { value: "custom", label: "Rentang lain" }]} />
          <button type="button" className="icon-button" aria-label="Cetak / PDF" title="Cetak / PDF tab ini" disabled={!sheet?.rows.length} onClick={print}><Printer size={18} /></button>
          <Button variant="secondary" disabled={!sheet?.rows.length} title="Unduh tab ini sebagai CSV" onClick={exportSheet}>CSV</Button>
          <button type="button" className="dark-button" disabled={!view} title="Unduh semua tab dalam satu berkas Excel" onClick={exportAll}>Unduh Excel</button>
        </div>
      </div>
      {period === "custom" && (
        <div className="report-filter">
          <label>Dari tanggal<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>Sampai tanggal<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
      )}
      {!valid && <p className="callout">Pilih rentang yang benar, paling panjang {DAYS} hari.</p>}
      {valid && (
        <p className="report-completeness">
          <AlertCircle size={16} aria-hidden />
          {local ? "Data demo di perangkat ini." : !ready ? "Mengambil angka dari server dan menghitung saldo awal…" : ready.server ? `Angka lengkap dari server, per ${when(ready.books.asOf ?? Date.now(), tz)}.` : `Server belum bisa memberi angka lengkap (${ready.error}). Yang tampil hanya data di perangkat ini, tanpa saldo awal, dan bisa kurang.`}
          {!local && ready && <><Button variant="ghost" size="sm" onClick={() => setAgain((n) => n + 1)}>Muat ulang</Button><Button variant="ghost" size="sm" title="Hitung lagi saldo awal dari hari pertama toko" onClick={recount}>Hitung ulang dari awal</Button></>}
        </p>
      )}
      {view && (
        <div className="metrics">
          <article className="metric tone-lavender"><span><ReceiptText size={16} aria-hidden /> Penjualan bersih</span><strong>{rupiah(view.p.net)}</strong><small>kotor {rupiah(view.p.sales)}, sebelum pajak & service</small></article>
          <article className="metric tone-sky"><span><Percent size={16} aria-hidden /> Laba kotor</span><strong>{rupiah(view.p.margin)}</strong><small>{view.p.revenue ? `${Math.round((view.p.margin / view.p.revenue) * 100)}% dari pendapatan` : "setelah biaya bahan"}</small></article>
          <article className="metric tone-mint"><span><Wallet size={16} aria-hidden /> Laba bersih</span><strong>{rupiah(view.p.result)}</strong><small>setelah biaya operasional {rupiah(view.p.opex)}</small></article>
          <article className="metric"><span><Boxes size={16} aria-hidden /> Nilai persediaan</span><strong>{rupiah(view.stockValue)}</strong><small>akhir rentang, harga rata-rata</small></article>
        </div>
      )}
      <div className="category-tabs" role="group" aria-label="Laporan akuntansi">
        {(view?.sheets ?? []).map((s) => <button type="button" key={s.id} className={s.id === sheet?.id ? "active" : ""} aria-pressed={s.id === sheet?.id} onClick={() => setTab(s.id)}>{s.label}</button>)}
      </div>
      <article className="panel">
        {valid && !view && <SkeletonRows label="Memuat angka akuntansi" count={6} />}
        {sheet && view && (
          <>
            <div className="panel-heading">
              <h2>{sheet.label}</h2>
              {sheet.id === "jurnal" && <Button variant="secondary" size="sm" onClick={() => setEditing(Object.fromEntries(Object.entries(chart).map(([k, v]) => [k, [v[0], v[1]]])))}>Kode akun</Button>}
              {sheet.id === "biaya" && <Button size="sm" onClick={() => setForm({ day: to < today ? to : today, kind: "rent", amount: "", note: "" })}>Catat biaya</Button>}
            </div>
            <p className="small muted">{sheet.note}</p>
            {sheet.rows.length ? (
              <div className="table-scroll">
                <table className="data-table books-table">
                  <thead><tr>{sheet.head.map((h, i) => <th key={h} className={sheet.kinds[i] === "text" ? undefined : "num"}>{h}</th>)}{sheet.id === "biaya" && <th><span className="sr-only">Hapus</span></th>}</tr></thead>
                  <tbody>{sheet.rows.map((r, n) => (
                    <tr key={n} className={sheet.strong?.includes(n) ? "sum" : undefined}>
                      {r.map((v, i) => <td key={i} className={sheet.kinds[i] === "text" ? undefined : "num"}>{show(v, sheet.kinds[i])}</td>)}
                      {sheet.id === "biaya" && <td className="num"><button type="button" className="icon-button" aria-label={`Hapus ${r[1]} ${r[0]}`} onClick={() => setRemoving(view.noted[n])}><Trash2 size={16} /></button></td>}
                    </tr>
                  ))}</tbody>
                  {sheet.foot && <tfoot><tr>{sheet.foot.map((v, i) => <td key={i} className={sheet.kinds[i] === "text" ? undefined : "num"}>{show(v, sheet.kinds[i])}</td>)}{sheet.id === "biaya" && <td />}</tr></tfoot>}
                </table>
              </div>
            ) : <p className="muted">{sheet.empty}</p>}
          </>
        )}
      </article>
      <Dialog open={Boolean(editing)} onOpenChange={() => setEditing(undefined)} title="Kode akun" description="Samakan dengan bagan akun di perangkat lunak akuntansi Anda. Tersimpan di laptop ini." wide>
        {editing && (
          <>
            <div className="account-grid">
              <div className="account-row small muted" aria-hidden><span>Kode</span><span>Nama akun</span></div>
              {(Object.keys(ACCOUNTS) as Account[]).map((k) => (
                <div key={k} className="account-row">
                  <input aria-label={`Kode ${ACCOUNTS[k][1]}`} value={editing[k][0]} maxLength={20} onChange={(e) => setEditing({ ...editing, [k]: [e.target.value, editing[k][1]] })} />
                  <input aria-label={`Nama ${ACCOUNTS[k][1]}`} value={editing[k][1]} maxLength={60} onChange={(e) => setEditing({ ...editing, [k]: [editing[k][0], e.target.value] })} />
                </div>
              ))}
            </div>
            <Button className="full" onClick={saveChart}>Simpan kode akun</Button>
          </>
        )}
      </Dialog>
      <Dialog open={Boolean(form)} onOpenChange={() => setForm(undefined)} title="Catat biaya" description="Untuk uang yang tidak lewat kasir. Dibayar dari, atau masuk ke, kas & bank di luar laci.">
        {form && (
          <>
            <label>Tanggal<input type="date" max={today} value={form.day} onChange={(e) => setForm({ ...form, day: e.target.value })} /></label>
            <Select label="Jenis" value={form.kind} onChange={(v) => setForm({ ...form, kind: v as CashKind })} options={kinds} />
            <label>Jumlah<Money value={form.amount} onChange={(amount) => setForm({ ...form, amount })} /></label>
            <label>Catatan<input value={form.note} maxLength={200} placeholder="mis. sewa November, gaji 4 orang" onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
            {form.day > today && <p className="callout">Tanggal belum terjadi.</p>}
            <Button className="full" loading={busy} disabled={busy || !DATE.test(form.day) || form.day > today || !(Number(form.amount) > 0) || Number(form.amount) > 1e11} onClick={saveForm}>Simpan catatan</Button>
          </>
        )}
      </Dialog>
      <Dialog open={Boolean(removing)} onOpenChange={() => setRemoving(undefined)} title="Hapus catatan ini?" description={removing ? `${(CASHBOOK[removing.kind] ?? CASHBOOK.otherExpense)[0]} ${rupiah(removing.amount)} pada ${removing.day}. Laporan dan neraca dihitung ulang tanpa catatan ini.` : undefined}>
        <div className="button-row">
          <Button variant="secondary" onClick={() => setRemoving(undefined)}>Batal</Button>
          <Button variant="destructive" loading={busy} onClick={remove}>Hapus</Button>
        </div>
      </Dialog>
    </section>
  );
}
