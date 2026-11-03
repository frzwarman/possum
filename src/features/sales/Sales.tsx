import { useState } from "react";
import { Navigate } from "@tanstack/react-router";
import { ReceiptText } from "lucide-react";
import { useApp } from "../../app/context";
import { Button } from "../../components/ui/button";
import { businessDay, rupiah, when } from "../../domain/calculate";
import type { Order } from "../../domain/types";
import { Receipt } from "../orders/Receipt";
const method = { cash: "Tunai", qris: "QRIS", card: "Kartu" };
// Sales by receipt, menu item, day and cashier, counted at payment like Laporan. Totals per menu
// are before the order-level discount; refunded receipts are listed but not counted.
export default function Sales() {
  const { orders, salesOrders, settings, manager } = useApp();
  const today = businessDay(new Date().toISOString(), settings?.timezone, settings?.cutoff);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [tab, setTab] = useState("receipts");
  const [receipt, setReceipt] = useState<Order>();
  if (!manager) return <Navigate to="/pos" />;
  const day = (o: Order) => businessDay(o.payment!.at, settings?.timezone, settings?.cutoff);
  const paid = orders.filter((o) => o.payment && day(o) >= from && day(o) <= to).sort((a, b) => b.payment!.at.localeCompare(a.payment!.at));
  const kept = paid.filter((o) => o.status !== "refunded");
  // Catering money is counted when it is received (DP, settlement, returned DP), like Laporan counts the till.
  const catering = salesOrders.flatMap((so) => so.payments).filter((p) => { const d = businessDay(p.at, settings?.timezone, settings?.cutoff); return d >= from && d <= to; }).reduce((n, p) => n + p.amount, 0);
  const total = kept.reduce((n, o) => n + o.totals.total, 0);
  const group = (key: (o: Order) => string) => {
    const rows = new Map<string, { count: number; total: number }>();
    for (const o of kept) {
      const r = rows.get(key(o)) || { count: 0, total: 0 };
      r.count++;
      r.total += o.totals.total;
      rows.set(key(o), r);
    }
    return [...rows].sort((a, b) => b[1].total - a[1].total);
  };
  const items = new Map<string, { name: string; qty: number; total: number }>();
  for (const o of kept)
    for (const l of o.lines.filter((l) => !l.cancelled)) {
      const r = items.get(l.itemId) || { name: l.name, qty: 0, total: 0 };
      r.qty += l.qty;
      r.total += l.qty * (l.price + l.modifiers.reduce((n, m) => n + m.price, 0));
      items.set(l.itemId, r);
    }
  const rows =
    tab === "items"
      ? [...items.values()].sort((a, b) => b.total - a.total).map((r) => [r.name, `${r.qty} porsi`, rupiah(r.total)])
      : tab === "days"
        ? group(day).sort((a, b) => b[0].localeCompare(a[0])).map(([d, r]) => [d, `${r.count} transaksi`, rupiah(r.total)])
        : group((o) => o.cashier).map(([c, r]) => [c, `${r.count} transaksi`, rupiah(r.total)]);
  return (
    <section className="page-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Hasil jualan</p>
          <h1>Penjualan</h1>
          <p className="muted">Per struk, per menu, per hari, dan per kasir.</p>
        </div>
      </div>
      <div className="report-filter">
        <label>
          Dari tanggal
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          Sampai tanggal
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <div className="metrics">
        <article className="metric featured">
          <span>Penjualan bersih</span>
          <strong>{rupiah(total)}</strong>
          <small>Tanpa struk yang direfund</small>
        </article>
        <article className="metric">
          <span>Transaksi</span>
          <strong>{kept.length}</strong>
          <small>Rata-rata {rupiah(kept.length ? Math.round(total / kept.length) : 0)}</small>
        </article>
        <article className="metric">
          <span>Diskon</span>
          <strong>{rupiah(kept.reduce((n, o) => n + o.discount, 0))}</strong>
          <small>{kept.filter((o) => o.discount).length} struk</small>
        </article>
        <article className="metric">
          <span>Refund</span>
          <strong>{rupiah(paid.filter((o) => o.status === "refunded").reduce((n, o) => n + o.totals.total, 0))}</strong>
          <small>{paid.length - kept.length} struk</small>
        </article>
      </div>
      {catering !== 0 && <p className="callout">Pembayaran pesanan katering &amp; B2B di rentang ini: {rupiah(catering)} (DP, pelunasan, pengembalian; tidak termasuk di atas).</p>}
      <div className="category-tabs">
        {[["receipts", "Per struk"], ["items", "Per menu"], ["days", "Per hari"], ["cashiers", "Per kasir"]].map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <article className="panel">
        <div className="table-scroll">
          {tab === "receipts" ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Waktu</th>
                  <th>Struk</th>
                  <th>Kasir</th>
                  <th>Metode</th>
                  <th>Total</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {paid.map((o) => (
                  <tr key={o.id}>
                    <td>{when(o.payment!.at, settings?.timezone, { dateStyle: "short", timeStyle: "short" })}</td>
                    <td>
                      {o.label || "Tanpa label"}
                      <br />
                      <small className="muted">{o.receiptId.slice(0, 11)}</small>
                    </td>
                    <td>{o.cashier}</td>
                    <td>{method[o.payment!.method]}</td>
                    <td>
                      {rupiah(o.totals.total)}
                      {o.status === "refunded" && <small className="muted"> · direfund</small>}
                    </td>
                    <td>
                      <Button variant="ghost" size="sm" aria-label={`Struk ${o.label || o.receiptId}`} onClick={() => setReceipt(o)}>
                        <ReceiptText size={16} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="data-table">
              <tbody>
                {rows.map(([a, b, c]) => (
                  <tr key={a}>
                    <td>{a}</td>
                    <td>{b}</td>
                    <td>{c}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {!paid.length && <p className="muted">Belum ada pembayaran di rentang ini.</p>}
      </article>
      {receipt && <Receipt order={receipt} kitchen={false} reprint onClose={() => setReceipt(undefined)} />}
    </section>
  );
}
