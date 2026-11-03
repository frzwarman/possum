import { useState } from "react";
import { Navigate } from "@tanstack/react-router";
import { FileText, Plus, Trash2, Truck, UserRound } from "lucide-react";
import { useApp } from "../../app/context";
import { DocumentDialog, whatsappNumber } from "../../app/Document";
import { Button } from "../../components/ui/button";
import { Money } from "../../components/ui/money";
import { Select } from "../../components/ui/select";
import { Dialog } from "../../components/ui/dialog";
import { convert, paidValue, quantity, receivedQty, receivedValue, rupiah, when } from "../../domain/calculate";
import type { Payment, PurchaseLine, PurchaseOrder, Supplier } from "../../domain/types";
import { uid } from "../../lib/db";
const status = { ordered: "Dipesan", partial: "Sebagian diterima", received: "Selesai", cancelled: "Dibatalkan" };
type Source = Payment["from"] | "unpaid";
// Order from a supplier, receive each delivery into stock as it arrives, and pay what is owed.
export default function Purchases() {
  const { purchaseOrders, suppliers, stockItems, settings, commands, act, busy, manager, shift, setError } = useApp();
  const [tab, setTab] = useState("open");
  const [draft, setDraft] = useState<{ id?: string; supplier: string; note: string; lines: PurchaseLine[] }>();
  const [line, setLine] = useState({ stockId: "", amount: "", unit: "", cost: "" });
  const [receiving, setReceiving] = useState<{ po: PurchaseOrder; amounts: string[]; costs: string[]; complete: boolean }>();
  const [source, setSource] = useState<Source>("outside");
  const [paying, setPaying] = useState<{ po: PurchaseOrder; amount: string }>();
  const [closing, setClosing] = useState<PurchaseOrder>();
  const [reason, setReason] = useState("");
  const [supplier, setSupplier] = useState<Supplier>();
  const [printing, setPrinting] = useState<PurchaseOrder>();
  if (!manager) return <Navigate to="/pos" />;
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
  function openReceiving(po: PurchaseOrder) {
    // Prefill with what is still to come, priced pro rata from the PO.
    const left = po.lines.map((l) => Math.max(0, l.qty - receivedQty(po, l.stockId)));
    setSource("outside");
    setReceiving({ po, amounts: left.map((q) => String(q / 1000)), costs: po.lines.map((l, i) => String(Math.round((l.cost * left[i]) / l.qty))), complete: false });
  }
  async function receive() {
    if (!receiving) return;
    try {
      const lines = receiving.po.lines.flatMap((l, i) =>
        Number(receiving.amounts[i] || 0) > 0
          ? [{ stockId: l.stockId, qty: convert(receiving.amounts[i], item(l.stockId)!.unit, item(l.stockId)!.unit), cost: Number(receiving.costs[i] || 0) }]
          : [],
      );
      if (!lines.length) throw new Error("Isi jumlah yang datang, atau tutup PO");
      await act(async () => {
        await commands.receivePurchase(receiving.po.id, lines, source, receiving.complete);
        setReceiving(undefined);
      }, "Kiriman diterima dan masuk stok");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Jumlah tidak valid");
    }
  }
  return (
    <section className="page-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Dari pemasok ke dapur</p>
          <h1>Pembelian</h1>
          <p className="muted">Pesan bahan, terima kiriman ke stok, dan bayar yang masih terutang.</p>
        </div>
        {tab === "suppliers" ? (
          <Button onClick={() => setSupplier({ id: uid(), name: "", phone: "", address: "", note: "", active: true })}>
            <Plus size={17} /> Tambah pemasok
          </Button>
        ) : (
          <Button onClick={() => setDraft({ supplier: "", note: "", lines: [] })}>
            <Plus size={17} /> Buat PO
          </Button>
        )}
      </div>
      <div className="stock-summary">
        <div>
          <span className="muted">Menunggu kiriman</span>
          <strong>{purchaseOrders.filter((p) => p.status === "ordered" || p.status === "partial").length}</strong>
        </div>
        <div>
          <span className="muted">Utang ke pemasok</span>
          <strong>{rupiah(purchaseOrders.reduce((n, p) => n + owed(p), 0))}</strong>
        </div>
        <div>
          <span className="muted">Pemasok aktif</span>
          <strong>{suppliers.filter((s) => s.active).length}</strong>
        </div>
      </div>
      <div className="category-tabs">
        {[["open", "Menunggu kiriman"], ["owed", "Belum dibayar"], ["all", "Semua PO"], ["suppliers", "Pemasok"]].map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "suppliers" ? (
        <article className="panel">
          {suppliers.map((s) => (
            <div className="admin-row" key={s.id}>
              <div>
                <strong>{s.name}</strong>
                <p className="small muted">
                  {[s.phone, s.address, s.note].filter(Boolean).join(" · ") || "Belum ada kontak"}
                </p>
              </div>
              <span className="badge">{s.active ? "Aktif" : "Diarsipkan"}</span>
              {whatsappNumber(s.phone) && (
                <Button asChild variant="ghost" size="sm">
                  <a href={`https://wa.me/${whatsappNumber(s.phone)}`} target="_blank" rel="noreferrer">
                    WhatsApp
                  </a>
                </Button>
              )}
              <Button variant="secondary" onClick={() => setSupplier({ ...s })}>
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
                <span className="order-symbol">
                  <Truck />
                </span>
                <span className={`badge ${p.status === "received" && !owed(p) ? "badge-green" : ""}`}>
                  {status[p.status]}
                  {owed(p) > 0 && " · belum lunas"}
                </span>
              </div>
              <h2>{p.supplier}</h2>
              <p className="muted small">
                {p.number} · {when(p.createdAt, settings?.timezone)} · {p.receipts.length} kiriman
              </p>
              <div className="order-item-list">
                {p.lines.map((l) => (
                  <div key={l.stockId}>
                    <span>
                      {item(l.stockId)?.name} {quantity(receivedQty(p, l.stockId))}/{amount(l.stockId, l.qty)}
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
                {(p.status === "ordered" || p.status === "partial") && <Button onClick={() => openReceiving(p)}>Terima kiriman</Button>}
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
      <Dialog open={Boolean(draft)} onOpenChange={() => setDraft(undefined)} title={draft?.id ? "Ubah PO" : "PO baru"}>
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
              className="full"
              loading={busy}
              disabled={busy || !draft.supplier.trim() || !draft.lines.length}
              onClick={() =>
                void act(async () => {
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
        open={Boolean(receiving)}
        onOpenChange={() => setReceiving(undefined)}
        title="Terima kiriman"
        description={receiving && `${receiving.po.number} · ${receiving.po.supplier}`}
      >
        {receiving && (
          <>
            <p className="small muted">Isi yang datang kali ini; 0 = belum datang. Stok dan utang mengikuti angka ini.</p>
            {receiving.po.lines.map((l, i) => (
              <div className="form-grid" key={l.stockId}>
                <label>
                  {item(l.stockId)?.name} ({item(l.stockId)?.unit})
                  <input
                    inputMode="decimal"
                    value={receiving.amounts[i]}
                    onChange={(e) => setReceiving({ ...receiving, amounts: receiving.amounts.map((a, j) => (j === i ? e.target.value : a)) })}
                  />
                </label>
                <label>
                  Harga total
                  <Money value={receiving.costs[i]} onChange={(v) => setReceiving({ ...receiving, costs: receiving.costs.map((c, j) => (j === i ? v : c)) })} />
                </label>
              </div>
            ))}
            <label className="inline-check">
              <input type="checkbox" checked={receiving.complete} onChange={(e) => setReceiving({ ...receiving, complete: e.target.checked })} />
              Tidak ada kiriman lagi untuk PO ini
            </label>
            <Select label="Pembayaran kiriman ini" value={source} onChange={(v) => setSource(v as Source)} options={sources(true)} />
            <Button className="full" loading={busy} disabled={busy} onClick={() => void receive()}>
              Konfirmasi penerimaan
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
              className="full"
              loading={busy}
              disabled={busy || source === "unpaid" || !Number(paying.amount)}
              onClick={() =>
                void act(async () => {
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
            void act(async () => {
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
              className="full"
              loading={busy}
              disabled={busy || !supplier.name.trim()}
              onClick={() =>
                void act(async () => {
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
