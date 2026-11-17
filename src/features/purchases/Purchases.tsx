import { Fragment, useState } from "react";
import { Navigate } from "@tanstack/react-router";
import { AlertTriangle, Check, FileText, Plus, Store, Trash2, Truck, UserRound, Wallet } from "lucide-react";
import { useApp } from "../../app/context";
import { can } from "../../domain/permissions";
import { DocumentDialog, whatsappNumber } from "../../app/Document";
import { Button } from "../../components/ui/button";
import { Money } from "../../components/ui/money";
import { Select } from "../../components/ui/select";
import { Dialog } from "../../components/ui/dialog";
import { convert, paidValue, quantity, receivedQty, receivedValue, rupiah, sanity, when } from "../../domain/calculate";
import type { Payment, PurchaseLine, PurchaseOrder, StockItem, Supplier } from "../../domain/types";
import { uid } from "../../lib/db";
const status = { ordered: "Dipesan", partial: "Sebagian diterima", received: "Selesai", cancelled: "Dibatalkan" };
type Source = Payment["from"] | "unpaid";
// One PO line being received: typed in `unit` (per = thousandths of the base unit in one), priced per unit.
// listed = the PO's price per unit; checked = the amount confirmed after the sanity warning.
type Row = { unit: string; per: number; expected: string; amount: string; listed: string; price: string; checked?: string };
const show = (unit: string) => (unit === "l" ? "L" : unit);
// A usual delivery as people say it (Figma M5: "3 karton (36 L)"): whole litres or kilos past 1.000 ml / g.
const big = (v: number, unit = "") => ((unit === "ml" || unit === "g") && v >= 1_000_000 ? `${quantity(v / 1000)} ${unit === "ml" ? "L" : "kg"}` : `${quantity(v)} ${unit}`);
// Blank or zero = not delivered (0); NaN = not a valid amount yet.
function got(r: Row, s?: StockItem) {
  if (!s || !/[1-9]/.test(r.amount)) return 0;
  try {
    return convert(r.amount, r.unit, s.unit, s.packs);
  } catch {
    return NaN;
  }
}
// An untouched price keeps the PO's exact pro rata cost; a typed price is per unit shown.
const lineTotal = (l: PurchaseLine, r: Row, qty: number) => Math.round(r.price === r.listed ? (l.cost * qty) / l.qty : (qty / r.per) * Number(r.price || 0));
// Order from a supplier, receive each delivery into stock as it arrives, and pay what is owed.
export default function Purchases() {
  const { purchaseOrders, suppliers, stockItems, movements, settings, commands, act, busy, shift, setError, user } = useApp();
  const [tab, setTab] = useState("open");
  const [draft, setDraft] = useState<{ id?: string; supplier: string; note: string; lines: PurchaseLine[] }>();
  const [line, setLine] = useState({ stockId: "", amount: "", unit: "", cost: "" });
  const [receiving, setReceiving] = useState<{ po: PurchaseOrder; rows: Row[]; complete: boolean }>();
  const [source, setSource] = useState<Source>("outside");
  const [paying, setPaying] = useState<{ po: PurchaseOrder; amount: string }>();
  const [closing, setClosing] = useState<PurchaseOrder>();
  const [reason, setReason] = useState("");
  const [supplier, setSupplier] = useState<Supplier>();
  const [printing, setPrinting] = useState<PurchaseOrder>();
  if (!can(user.role, "documents")) return <Navigate to="/pos" />;
  const item = (id: string) => stockItems.find((s) => s.id === id);
  const amount = (stockId: string, qty: number) => `${quantity(qty)} ${item(stockId)?.unit ?? ""}`;
  const owed = (p: PurchaseOrder) => receivedValue(p) - paidValue(p);
  const contact = (p: PurchaseOrder) => suppliers.find((s) => s.id === p.supplierId);
  const shown = purchaseOrders.filter((p) =>
    tab === "open" ? p.status === "ordered" || p.status === "partial" : tab === "owed" ? owed(p) > 0 : true,
  );
  const sources = (allowOwed: boolean) => [
    { value: "drawer", label: shift ? "Dari laci kas sif aktif" : "Dari laci kas (buka sif dulu)", disabled: !shift },
    { value: "outside", label: "Di luar laci (transfer / uang pemilik)" },
    ...(allowOwed ? [{ value: "unpaid", label: "Belum dibayar (tempo)" }] : []),
  ];
  const text = (p: PurchaseOrder) =>
    [
      `PURCHASE ORDER ${p.number}`,
      settings?.name,
      settings?.address,
      `Tanggal: ${when(p.createdAt, settings?.timezone, { dateStyle: "medium" })}`,
      `Kepada: ${p.supplier}`,
      "--------------------------------",
      ...p.lines.map((l, i) => `${i + 1}. ${item(l.stockId)?.name} ${amount(l.stockId, l.qty)}\n   ${rupiah(l.cost)}`),
      "--------------------------------",
      `Total: ${rupiah(p.total)}`,
      p.note && `Catatan: ${p.note}`,
      "Mohon konfirmasi ketersediaan. Terima kasih.",
    ]
      .filter(Boolean)
      .join("\n");
  function addLine() {
    const s = item(line.stockId);
    if (!draft || !s) return;
    try {
      const next = { stockId: s.id, qty: convert(line.amount, line.unit || s.unit, s.unit), cost: Number(line.cost || 0) };
      setDraft({ ...draft, lines: [...draft.lines.filter((l) => l.stockId !== s.id), next] });
      setLine({ stockId: "", amount: "", unit: "", cost: "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Jumlah tidak valid");
    }
  }
  // PUR-4 history: past deliveries of an ingredient, oldest first (the Stok page checks against the same).
  const deliveries = (id: string) => movements.filter((m) => m.stockId === id && m.kind === "purchase" && m.qty > 0).sort((a, b) => a.at.localeCompare(b.at)).map((m) => m.qty);
  function openReceiving(po: PurchaseOrder) {
    setSource("outside");
    setReceiving({
      po,
      complete: false,
      rows: po.lines.map((l) => {
        const s = item(l.stockId);
        const left = Math.max(0, l.qty - receivedQty(po, l.stockId));
        // Typed in the pack the order fills exactly ("2 karton"), else in kg / L, else the base unit. The prefill is
        // what is still to come, so a unit is only used when that amount is exact in it (3 decimals at most).
        const fits = (per: number) => l.qty % per === 0 && (left * 1000) % per === 0;
        const pack = s?.packs?.find((p) => fits(p.qty));
        const [unit, per] = pack ? [pack.name, pack.qty] : s && s.unit !== "pcs" && fits(1_000_000) ? [s.unit === "g" ? "kg" : "l", 1_000_000] : [s?.unit ?? "", 1000];
        const expected = String(left / per).replace(".", ",");
        const listed = String(Math.round((l.cost / l.qty) * per));
        return { unit, per, expected, amount: expected, listed, price: listed };
      }),
    });
    document.getElementById("main")?.scrollTo(0, 0);
  }
  async function receive() {
    if (!receiving) return;
    try {
      const lines = receiving.po.lines.flatMap((l, i) => {
        const r = receiving.rows[i];
        const s = item(l.stockId)!;
        // Blank or zero = not delivered; anything else is validated by convert() ("2,5" is fine, "25 kg" is not).
        if (!/[1-9]/.test(r.amount)) return [];
        const qty = convert(r.amount, r.unit, s.unit, s.packs);
        return [{ stockId: l.stockId, qty, cost: lineTotal(l, r, qty) }];
      });
      if (!lines.length) throw new Error("Isi jumlah yang datang, atau tutup PO");
      await act(async () => {
        await commands.receivePurchase(receiving.po.id, lines, source, receiving.complete);
        setReceiving(undefined);
      }, "Kiriman diterima dan masuk stok");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Jumlah tidak valid");
    }
  }
  // Receiving one delivery (Figma M5) replaces the list; the breadcrumb goes back to it.
  if (receiving) {
    const { po, rows } = receiving;
    const setRow = (i: number, patch: Partial<Row>) => setReceiving({ ...receiving, rows: rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
    const view = po.lines.map((l, i) => {
      const r = rows[i];
      const s = item(l.stockId);
      const qty = got(r, s);
      const history = deliveries(l.stockId);
      const verdict = qty > 0 ? sanity(qty, history) : "ok";
      return { l, r, s, qty, history, total: lineTotal(l, r, qty), flag: verdict !== "ok" && r.checked !== r.amount ? verdict : undefined };
    });
    const before = receivedValue(po);
    const changed = rows.filter((r) => r.price !== r.listed).length;
    const pending = view.filter((v) => v.flag).length;
    return (
      <section className="page-content receive-page" aria-labelledby="receive-title">
        <p className="crumbs">
          <button type="button" onClick={() => setReceiving(undefined)}>
            Pembelian
          </button>{" "}
          / Kiriman {po.number}
        </p>
        <div className="receive-heading">
          <h1 id="receive-title">Terima kiriman dari {po.supplier}</h1>
          <span className={`dot-chip ${po.status === "partial" ? "warning" : "info"}`}>{status[po.status]}</span>
        </div>
        <div className="receive-grid">
          <article className="panel receive-lines">
            <table className="receive-table">
              <thead>
                <tr>
                  <th>Bahan</th>
                  <th>Dipesan</th>
                  <th>Diterima</th>
                  <th className="num">Harga per kemasan</th>
                  <th className="num">Total baris</th>
                </tr>
              </thead>
              <tbody>
                {view.map(({ l, r, s, qty, history, total, flag }, i) => {
                  const done = receivedQty(po, l.stockId);
                  const usual = history.slice(-5).sort((a, b) => a - b)[Math.floor(Math.min(5, history.length) / 2)] ?? 0;
                  const typed = `${r.amount} ${show(r.unit)}`;
                  const normal = `${quantity((usual * 1000) / r.per)} ${show(r.unit)}${r.per === 1000 ? "" : ` (${big(usual, s?.unit)})`}`;
                  return (
                    <Fragment key={l.stockId}>
                      <tr className={flag ? "flagged" : undefined}>
                        <td>
                          <strong>{s?.name}</strong>
                        </td>
                        <td className="ordered" data-label="Dipesan">
                          {quantity((l.qty * 1000) / r.per)} {show(r.unit)}
                          {done > 0 && (
                            <small>
                              sudah datang {quantity((done * 1000) / r.per)} {show(r.unit)}
                            </small>
                          )}
                        </td>
                        <td>
                          <span className="unit-field">
                            <input inputMode="decimal" aria-label={`${s?.name} (${show(r.unit)})`} value={r.amount} onChange={(e) => setRow(i, { amount: e.target.value })} />
                            <span aria-hidden>{show(r.unit)}</span>
                          </span>
                          {qty > 0 && r.per !== 1000 && (
                            <small>
                              = {quantity(qty)} {s?.unit}
                            </small>
                          )}
                        </td>
                        <td className="num" data-label={`Harga per ${show(r.unit)}`}>
                          <Money aria-label={`Harga per ${show(r.unit)} ${s?.name}`} value={r.price} onChange={(v) => setRow(i, { price: v })} />
                        </td>
                        <td className="num">
                          <strong>{Number.isNaN(total) ? "—" : rupiah(total)}</strong>
                        </td>
                      </tr>
                      {flag && (
                        <tr className="flagged flag-note">
                          <td colSpan={5}>
                            <div>
                              <AlertTriangle size={20} aria-hidden />
                              <p role="alert">
                                <strong>{flag === "high" ? `${typed} itu ${Math.round(qty / usual)}× kiriman biasa ${normal}.` : `${typed} jauh di bawah kiriman biasa ${normal}.`}</strong>
                                <span>{r.amount === r.expected ? "Cek satuan dan jumlahnya di surat jalan." : `Cek surat jalan: yang datang ${typed} atau ${r.expected} ${show(r.unit)}?`}</span>
                              </p>
                              <div className="flag-actions">
                                {r.amount !== r.expected && (
                                  <Button variant="secondary" size="sm" onClick={() => setRow(i, { amount: r.expected })}>
                                    Ubah ke {r.expected} {show(r.unit)}
                                  </Button>
                                )}
                                <Button variant="ghost" size="sm" onClick={() => setRow(i, { checked: r.amount })}>
                                  Ya, {r.amount} benar
                                </Button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </article>
          <aside className="panel receive-summary">
            <dl>
              <div>
                <dt>Total dipesan</dt>
                <dd>{rupiah(po.total)}</dd>
              </div>
              {before > 0 && (
                <div>
                  <dt>Kiriman sebelumnya</dt>
                  <dd>{rupiah(before)}</dd>
                </div>
              )}
              <div>
                <dt>Total diterima</dt>
                <dd>{rupiah(view.reduce((n, v) => n + (v.total || 0), 0))}</dd>
              </div>
              <div>
                <dt>Harga berubah</dt>
                <dd>{changed ? `${changed} baris` : "Tidak ada"}</dd>
              </div>
            </dl>
            <label className="inline-check">
              <input type="checkbox" checked={receiving.complete} onChange={(e) => setReceiving({ ...receiving, complete: e.target.checked })} />
              Tidak ada kiriman lagi untuk PO ini
            </label>
            <Select label="Pembayaran kiriman ini" value={source} onChange={(v) => setSource(v as Source)} options={sources(true)} />
            {pending > 0 && <p className="receive-alert">{pending} baris perlu dicek sebelum stok naik.</p>}
            <Button className="btn-accent full receive-confirm" loading={busy} disabled={busy || pending > 0} onClick={() => receive()}>
              <Check size={20} /> Konfirmasi dan masukkan ke stok
            </Button>
          </aside>
        </div>
      </section>
    );
  }
  const waiting = purchaseOrders.filter((p) => p.status === "ordered" || p.status === "partial");
  const owing = purchaseOrders.filter((p) => owed(p) > 0);
  const archived = suppliers.filter((s) => !s.active).length;
  const tone = (p: PurchaseOrder) => (p.status === "cancelled" ? "" : owed(p) > 0 || p.status === "partial" ? "warning" : p.status === "received" ? "good" : "info");
  return (
    <section className="page-content purchases-page">
      <div className="page-heading">
        <div>
          <h1>Pembelian</h1>
          <p className="muted">Pesan bahan, terima kiriman ke stok, dan bayar yang masih terutang.</p>
        </div>
        {tab === "suppliers" ? (
          <Button className="btn-accent" onClick={() => setSupplier({ id: uid(), name: "", phone: "", address: "", note: "", active: true })}>
            <Plus size={17} /> Tambah pemasok
          </Button>
        ) : (
          <Button className="btn-accent" onClick={() => setDraft({ supplier: "", note: "", lines: [] })}>
            <Plus size={17} /> Buat PO
          </Button>
        )}
      </div>
      <div className="metrics">
        <article className="metric">
          <span>
            <Truck size={16} /> Menunggu kiriman
          </span>
          <strong>{waiting.length}</strong>
          <small>{waiting.length ? `PO senilai ${rupiah(waiting.reduce((n, p) => n + p.total, 0))}` : "Tidak ada PO terbuka"}</small>
        </article>
        <article className="metric">
          <span>
            <Wallet size={16} /> Utang ke pemasok
          </span>
          <strong>{rupiah(owing.reduce((n, p) => n + owed(p), 0))}</strong>
          <small>{owing.length ? `${owing.length} PO belum lunas` : "Semua lunas"}</small>
        </article>
        <article className="metric">
          <span>
            <Store size={16} /> Pemasok aktif
          </span>
          <strong>{suppliers.length - archived}</strong>
          {archived > 0 && <small>{archived} diarsipkan</small>}
        </article>
      </div>
      <div className="category-tabs">
        {(
          [
            ["open", "Menunggu kiriman", waiting.length],
            ["owed", "Belum dibayar", owing.length],
            ["all", "Semua PO", purchaseOrders.length],
            ["suppliers", "Pemasok", suppliers.length],
          ] as const
        ).map(([id, label, n]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            {label} <span>{n}</span>
          </button>
        ))}
      </div>
      {tab === "suppliers" ? (
        <article className="panel supplier-list">
          {suppliers.map((s) => (
            <div className="admin-row" key={s.id}>
              <div>
                <strong>{s.name}</strong>
                <p className="small muted">
                  {[s.phone, s.address, s.note].filter(Boolean).join(" · ") || "Belum ada kontak"}
                </p>
              </div>
              <span className={`dot-chip ${s.active ? "good" : ""}`}>{s.active ? "Aktif" : "Diarsipkan"}</span>
              {whatsappNumber(s.phone) && (
                <Button asChild variant="ghost" size="sm">
                  <a href={`https://wa.me/${whatsappNumber(s.phone)}`} target="_blank" rel="noreferrer">
                    WhatsApp
                  </a>
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={() => setSupplier({ ...s })}>
                Edit
              </Button>
            </div>
          ))}
          {!suppliers.length && <p className="muted">Simpan pemasok tetap beserta nomor WhatsApp-nya agar PO bisa langsung dikirim.</p>}
        </article>
      ) : (
        <div className="orders-grid">
          {shown.map((p) => (
            <article className="order-card" key={p.id}>
              <div className="order-card-heading">
                <h2>{p.supplier}</h2>
                <span className={`dot-chip ${tone(p)}`}>
                  {status[p.status]}
                  {owed(p) > 0 && " · belum lunas"}
                </span>
              </div>
              <p className="muted small">
                {p.number} · {when(p.createdAt, settings?.timezone)} · {p.receipts.length} kiriman
              </p>
              <div className="order-item-list">
                {p.lines.map((l) => (
                  <div key={l.stockId}>
                    <span>{item(l.stockId)?.name}</span>{" "}
                    <span className="muted">
                      {quantity(receivedQty(p, l.stockId))}/{amount(l.stockId, l.qty)}
                    </span>
                  </div>
                ))}
              </div>
              <div className="bill-total">
                <span>Nilai PO</span>
                <strong>{rupiah(p.total)}</strong>
              </div>
              {p.receipts.length > 0 && (
                <p className="small muted">
                  Diterima {rupiah(receivedValue(p))} · dibayar {rupiah(paidValue(p))}
                  {owed(p) > 0 && ` · sisa ${rupiah(owed(p))}`}
                </p>
              )}
              {p.note && <p className="small muted">{p.note}</p>}
              {(p.cancelReason || p.closeReason) && <p className="small muted">Ditutup: {p.cancelReason || p.closeReason}</p>}
              <div className="button-row">
                {(p.status === "ordered" || p.status === "partial") && (
                  <Button className="btn-accent" onClick={() => openReceiving(p)}>
                    Terima kiriman
                  </Button>
                )}
                {owed(p) > 0 && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSource("outside");
                      setPaying({ po: p, amount: String(owed(p)) });
                    }}
                  >
                    Bayar
                  </Button>
                )}
                {p.status === "ordered" && (
                  <Button variant="secondary" onClick={() => setDraft({ id: p.id, supplier: p.supplier, note: p.note, lines: p.lines })}>
                    Ubah
                  </Button>
                )}
                <Button variant="ghost" aria-label={`Cetak atau kirim ${p.number}`} onClick={() => setPrinting(p)}>
                  <FileText size={17} />
                </Button>
                {(p.status === "ordered" || p.status === "partial") && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setReason("");
                      setClosing(p);
                    }}
                  >
                    {p.status === "ordered" ? "Batalkan" : "Tutup sisa"}
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {tab !== "suppliers" && !shown.length && (
        <div className="empty-state">
          <Truck size={42} strokeWidth={1.3} />
          <h2>{tab === "open" ? "Tidak ada PO yang menunggu kiriman" : "Belum ada PO di sini"}</h2>
          <p>Buat PO saat memesan ke pemasok; stok bertambah setiap kali kiriman diterima.</p>
        </div>
      )}
      <Dialog open={Boolean(draft)} onOpenChange={() => setDraft(undefined)} title={draft?.id ? "Ubah PO" : "PO baru"} className="po-dialog">
        {draft && (
          <>
            <label>
              Pemasok
              <input list="meja-suppliers" value={draft.supplier} onChange={(e) => setDraft({ ...draft, supplier: e.target.value })} />
              <datalist id="meja-suppliers">
                {suppliers
                  .filter((s) => s.active)
                  .map((s) => (
                    <option key={s.id} value={s.name} />
                  ))}
              </datalist>
            </label>
            {draft.lines.map((l) => (
              <div className="bill-row" key={l.stockId}>
                <span>
                  {item(l.stockId)?.name} {amount(l.stockId, l.qty)}
                </span>
                <span>
                  {rupiah(l.cost)}{" "}
                  <button
                    className="text-button"
                    aria-label={`Hapus ${item(l.stockId)?.name}`}
                    onClick={() => setDraft({ ...draft, lines: draft.lines.filter((x) => x.stockId !== l.stockId) })}
                  >
                    <Trash2 size={15} />
                  </button>
                </span>
              </div>
            ))}
            <div className="form-grid">
              <Select
                label="Bahan"
                value={line.stockId}
                onChange={(v) => setLine({ ...line, stockId: v, unit: item(v)?.unit ?? "" })}
                options={[{ value: "", label: "Pilih bahan" }, ...stockItems.map((s) => ({ value: s.id, label: `${s.name} (${s.unit})` }))]}
              />
              <label>
                Jumlah
                <input inputMode="decimal" value={line.amount} onChange={(e) => setLine({ ...line, amount: e.target.value })} placeholder="0" />
              </label>
            </div>
            <div className="form-grid">
              <Select
                label="Satuan"
                value={line.unit}
                onChange={(v) => setLine({ ...line, unit: v })}
                options={(() => {
                  const base = item(line.stockId)?.unit;
                  return base
                    ? [{ value: base, label: base }, ...(base === "g" ? [{ value: "kg", label: "kg (1.000 g)" }] : base === "ml" ? [{ value: "l", label: "liter (1.000 ml)" }] : [])]
                    : [{ value: "", label: "Pilih bahan dulu" }];
                })()}
              />
              <label>
                Harga total baris
                <Money value={line.cost} onChange={(v) => setLine({ ...line, cost: v })} />
              </label>
            </div>
            <Button variant="secondary" disabled={!line.stockId || !line.amount} onClick={addLine}>
              <Plus size={16} /> Tambah ke PO
            </Button>
            <label className="mt">
              Catatan (opsional)
              <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="Contoh: kirim sebelum jam 9" />
            </label>
            <div className="bill-total">
              <span>Total PO</span>
              <strong>{rupiah(draft.lines.reduce((n, l) => n + l.cost, 0))}</strong>
            </div>
            <Button
              className="btn-accent full"
              loading={busy}
              disabled={busy || !draft.supplier.trim() || !draft.lines.length}
              onClick={() =>
                act(async () => {
                  const known = suppliers.find((s) => s.active && s.name.toLowerCase() === draft.supplier.trim().toLowerCase());
                  await commands.savePurchase({ ...draft, supplierId: known?.id });
                  setDraft(undefined);
                }, "PO tersimpan")
              }
            >
              Simpan PO
            </Button>
          </>
        )}
      </Dialog>
      <Dialog
        open={Boolean(paying)}
        onOpenChange={() => setPaying(undefined)}
        title="Bayar pemasok"
        description={paying && `${paying.po.number} · ${paying.po.supplier} · sisa ${rupiah(owed(paying.po))}`}
      >
        {paying && (
          <>
            <label>
              Jumlah dibayar
              <Money value={paying.amount} onChange={(v) => setPaying({ ...paying, amount: v })} />
            </label>
            <Select label="Dibayar dari" value={source} onChange={(v) => setSource(v as Source)} options={sources(false)} />
            <Button
              className="btn-accent full"
              loading={busy}
              disabled={busy || source === "unpaid" || !Number(paying.amount)}
              onClick={() =>
                act(async () => {
                  await commands.payPurchase(paying.po.id, Number(paying.amount), source as Payment["from"]);
                  setPaying(undefined);
                }, "Pembayaran ke pemasok tercatat")
              }
            >
              Simpan pembayaran
            </Button>
          </>
        )}
      </Dialog>
      <Dialog
        open={Boolean(closing)}
        onOpenChange={() => setClosing(undefined)}
        title={closing?.status === "partial" ? "Tutup sisa PO" : "Batalkan PO"}
        description={closing?.status === "partial" ? "Yang sudah diterima tetap tercatat; sisanya tidak ditunggu lagi." : closing?.number}
      >
        <label>
          Alasan wajib
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <Button
          variant="destructive"
          className="full"
          loading={busy}
          disabled={busy || !reason.trim()}
          onClick={() =>
            act(async () => {
              await commands.cancelPurchase(closing!.id, reason);
              setClosing(undefined);
            }, closing?.status === "partial" ? "Sisa PO ditutup" : "PO dibatalkan")
          }
        >
          Konfirmasi
        </Button>
      </Dialog>
      <Dialog open={Boolean(supplier)} onOpenChange={() => setSupplier(undefined)} title="Pemasok">
        {supplier && (
          <>
            <label>
              Nama pemasok
              <input value={supplier.name} onChange={(e) => setSupplier({ ...supplier, name: e.target.value })} />
            </label>
            <label>
              Nomor WhatsApp / telepon
              <input inputMode="tel" value={supplier.phone} onChange={(e) => setSupplier({ ...supplier, phone: e.target.value })} placeholder="0812 3456 7890" />
            </label>
            <label>
              Alamat
              <input value={supplier.address} onChange={(e) => setSupplier({ ...supplier, address: e.target.value })} />
            </label>
            <label>
              Catatan
              <input value={supplier.note} onChange={(e) => setSupplier({ ...supplier, note: e.target.value })} placeholder="Contoh: tempo 14 hari, kirim pagi" />
            </label>
            <label className="inline-check">
              <input type="checkbox" checked={supplier.active} onChange={(e) => setSupplier({ ...supplier, active: e.target.checked })} />
              <UserRound size={15} /> Aktif (muncul saat membuat PO)
            </label>
            <Button
              className="btn-accent full"
              loading={busy}
              disabled={busy || !supplier.name.trim()}
              onClick={() =>
                act(async () => {
                  await commands.saveSupplier(supplier);
                  setSupplier(undefined);
                }, "Pemasok tersimpan")
              }
            >
              Simpan pemasok
            </Button>
          </>
        )}
      </Dialog>
      {printing && <DocumentDialog title={printing.number} text={text(printing)} phone={contact(printing)?.phone} onClose={() => setPrinting(undefined)} />}
    </section>
  );
}
