import { useState } from "react";
import { Navigate } from "@tanstack/react-router";
import { CalendarClock, FileText, Plus, Trash2 } from "lucide-react";
import { useApp } from "../../app/context";
import { DocumentDialog } from "../../app/Document";
import { Button } from "../../components/ui/button";
import { Money } from "../../components/ui/money";
import { Select } from "../../components/ui/select";
import { Dialog } from "../../components/ui/dialog";
import { paidValue, rupiah, totals, when } from "../../domain/calculate";
import type { Payment, SalesLine, SalesOrder } from "../../domain/types";
import { uid } from "../../lib/db";
const status = { confirmed: "Dikonfirmasi", delivered: "Terkirim", cancelled: "Dibatalkan" };
type Draft = { id?: string; name: string; phone: string; address: string; deliverAt: string; lines: SalesLine[]; discount: string; note: string; dp: string };
// <input type="datetime-local"> speaks local wall-clock time without a zone.
const localInput = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
// Catering and B2B orders: a customer, a delivery time, a down payment now and the rest later.
// Delivery takes the menu recipes out of stock; until the balance is paid the order stays owed.
export default function Catering() {
  const { salesOrders, menu, settings, commands, act, busy, manager, shift } = useApp();
  const [tab, setTab] = useState("upcoming");
  const [draft, setDraft] = useState<Draft>();
  const [pick, setPick] = useState({ itemId: "", qty: "", price: "" });
  const [source, setSource] = useState<Payment["from"]>("outside");
  const [paying, setPaying] = useState<{ so: SalesOrder; amount: string }>();
  const [delivering, setDelivering] = useState<SalesOrder>();
  const [cancelling, setCancelling] = useState<{ so: SalesOrder; reason: string; refund: string }>();
  const [printing, setPrinting] = useState<SalesOrder>();
  if (!manager) return <Navigate to="/pos" />;
  const balance = (so: SalesOrder) => (so.status === "cancelled" ? 0 : so.totals.total - paidValue(so));
  const shown = salesOrders.filter((so) =>
    tab === "upcoming" ? so.status === "confirmed" : tab === "owed" ? so.status === "delivered" && balance(so) > 0 : true,
  );
  const customers = [...new Map(salesOrders.map((so) => [so.customer.name, so.customer])).values()];
  const sources = [
    { value: "drawer", label: shift ? "Tunai ke laci kas sif aktif" : "Tunai ke laci (buka sif dulu)", disabled: !shift },
    { value: "outside", label: "Transfer / QRIS / di luar laci" },
  ];
  let preview = { subtotal: 0, discount: 0, service: 0, tax: 0, total: 0 };
  let invalid = "";
  if (draft && settings)
    try {
      preview = totals(draft.lines.map((l) => ({ ...l, modifiers: [], cancelled: false })), Number(draft.discount || 0), settings);
    } catch (e) {
      invalid = e instanceof Error ? e.message : "Total tidak valid";
    }
  const text = (so: SalesOrder) =>
    [
      `PESANAN ${so.number}`,
      settings?.name,
      settings?.address,
      `Pelanggan: ${so.customer.name}${so.customer.phone ? ` (${so.customer.phone})` : ""}`,
      so.customer.address && `Alamat kirim: ${so.customer.address}`,
      `Dikirim: ${when(so.deliverAt, settings?.timezone)}`,
      "--------------------------------",
      ...so.lines.map((l) => `${l.qty}× ${l.name} @${rupiah(l.price)}\n   ${rupiah(l.qty * l.price)}`),
      "--------------------------------",
      so.totals.discount > 0 && `Diskon: −${rupiah(so.totals.discount)}`,
      so.totals.service > 0 && `Layanan: ${rupiah(so.totals.service)}`,
      so.totals.tax > 0 && `Pajak: ${rupiah(so.totals.tax)}`,
      `Total: ${rupiah(so.totals.total)}`,
      `Sudah dibayar: ${rupiah(paidValue(so))}`,
      `Sisa: ${rupiah(balance(so))}`,
      so.note && `Catatan: ${so.note}`,
      settings?.footer,
    ]
      .filter(Boolean)
      .join("\n");
  function addLine() {
    const m = menu.find((x) => x.id === pick.itemId);
    if (!draft || !m || !Number(pick.qty)) return;
    setDraft({ ...draft, lines: [...draft.lines, { id: uid(), itemId: m.id, name: m.name, qty: Number(pick.qty), price: Number(pick.price || 0), catalogVersion: m.version }] });
    setPick({ itemId: "", qty: "", price: "" });
  }
  function save() {
    if (!draft) return;
    const dp = Number(draft.dp || 0);
    void act(async () => {
      const so = await commands.saveSalesOrder({
        id: draft.id,
        customer: { name: draft.name, phone: draft.phone, address: draft.address },
        deliverAt: draft.deliverAt,
        lines: draft.lines,
        discount: Number(draft.discount || 0),
        note: draft.note,
      });
      if (dp > 0) await commands.paySalesOrder(so.id, dp, source);
      setDraft(undefined);
    }, dp > 0 ? "Pesanan dan DP tersimpan" : "Pesanan tersimpan");
  }
  return (
    <section className="page-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Katering & B2B</p>
          <h1>Pesanan katering</h1>
          <p className="muted">Pesanan besar dengan tanggal kirim, uang muka, dan pelunasan.</p>
        </div>
        <Button
          onClick={() => {
            setSource("outside");
            setDraft({ name: "", phone: "", address: "", deliverAt: localInput(new Date(Date.now() + 86400000).toISOString()), lines: [], discount: "", note: "", dp: "" });
          }}
        >
          <Plus size={17} /> Pesanan baru
        </Button>
      </div>
      <div className="stock-summary">
        <div>
          <span className="muted">Akan dikirim</span>
          <strong>{salesOrders.filter((so) => so.status === "confirmed").length}</strong>
        </div>
        <div>
          <span className="muted">Belum dibayar pelanggan</span>
          <strong>{rupiah(salesOrders.reduce((n, so) => n + balance(so), 0))}</strong>
        </div>
        <div>
          <span className="muted">Uang muka diterima</span>
          <strong>{rupiah(salesOrders.filter((so) => so.status === "confirmed").reduce((n, so) => n + paidValue(so), 0))}</strong>
        </div>
      </div>
      <div className="category-tabs">
        {[["upcoming", "Akan dikirim"], ["owed", "Belum lunas"], ["all", "Semua"]].map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="orders-grid">
        {shown.map((so) => (
          <article className="order-card" key={so.id}>
            <div className="order-card-heading">
              <span className="order-symbol">
                <CalendarClock />
              </span>
              <span className={`badge ${so.status !== "cancelled" && !balance(so) ? "badge-green" : ""}`}>
                {status[so.status]}
                {so.status !== "cancelled" && (balance(so) ? " · belum lunas" : " · lunas")}
              </span>
            </div>
            <h2>{so.customer.name}</h2>
            <p className="muted small">
              {so.number} · kirim {when(so.deliverAt, settings?.timezone)}
            </p>
            <div className="order-item-list">
              {so.lines.map((l) => (
                <div key={l.id}>
                  <strong>{l.qty}×</strong>
                  <span>
                    {l.name}
                    <small>@{rupiah(l.price)}</small>
                  </span>
                </div>
              ))}
            </div>
            <div className="bill-total">
              <span>Total</span>
              <strong>{rupiah(so.totals.total)}</strong>
            </div>
            <p className="small muted">
              Dibayar {rupiah(paidValue(so))}
              {balance(so) > 0 && ` · sisa ${rupiah(balance(so))}`}
              {so.cancelReason && ` · batal: ${so.cancelReason}`}
            </p>
            <div className="button-row">
              {so.status === "confirmed" && <Button onClick={() => setDelivering(so)}>Tandai terkirim</Button>}
              {balance(so) > 0 && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSource("outside");
                    setPaying({ so, amount: String(balance(so)) });
                  }}
                >
                  Terima pembayaran
                </Button>
              )}
              {so.status === "confirmed" && (
                <Button
                  variant="secondary"
                  onClick={() =>
                    setDraft({ id: so.id, ...so.customer, deliverAt: localInput(so.deliverAt), lines: so.lines, discount: String(so.discount || ""), note: so.note, dp: "" })
                  }
                >
                  Ubah
                </Button>
              )}
              <Button variant="ghost" aria-label={`Cetak atau kirim ${so.number}`} onClick={() => setPrinting(so)}>
                <FileText size={17} />
              </Button>
              {so.status === "confirmed" && (
                <Button variant="ghost" onClick={() => setCancelling({ so, reason: "", refund: String(paidValue(so) || "") })}>
                  Batalkan
                </Button>
              )}
            </div>
          </article>
        ))}
      </div>
      {!shown.length && (
        <div className="empty-state">
          <CalendarClock size={42} strokeWidth={1.3} />
          <h2>{tab === "upcoming" ? "Tidak ada pesanan yang menunggu dikirim" : "Belum ada pesanan di sini"}</h2>
          <p>Catat pesanan nasi kotak, tumpeng, atau langganan kantor beserta uang mukanya.</p>
        </div>
      )}
      <Dialog open={Boolean(draft)} onOpenChange={() => setDraft(undefined)} title={draft?.id ? "Ubah pesanan" : "Pesanan katering baru"}>
        {draft && (
          <>
            <label>
              Pelanggan / perusahaan
              <input
                list="meja-customers"
                value={draft.name}
                onChange={(e) => {
                  const known = customers.find((c) => c.name === e.target.value);
                  setDraft({ ...draft, name: e.target.value, ...(known && !draft.phone && !draft.address && { phone: known.phone, address: known.address }) });
                }}
              />
              <datalist id="meja-customers">
                {customers.map((c) => (
                  <option key={c.name} value={c.name} />
                ))}
              </datalist>
            </label>
            <div className="form-grid">
              <label>
                Nomor WhatsApp / telepon
                <input inputMode="tel" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
              </label>
              <label>
                Dikirim pada
                <input type="datetime-local" value={draft.deliverAt} onChange={(e) => setDraft({ ...draft, deliverAt: e.target.value })} />
              </label>
            </div>
            <label>
              Alamat kirim
              <input value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
            </label>
            {draft.lines.map((l) => (
              <div className="bill-row" key={l.id}>
                <span>
                  {l.qty}× {l.name} @{rupiah(l.price)}
                </span>
                <span>
                  {rupiah(l.qty * l.price)}{" "}
                  <button className="text-button" aria-label={`Hapus ${l.name}`} onClick={() => setDraft({ ...draft, lines: draft.lines.filter((x) => x.id !== l.id) })}>
                    <Trash2 size={15} />
                  </button>
                </span>
              </div>
            ))}
            <Select
              label="Menu"
              value={pick.itemId}
              onChange={(v) => setPick({ ...pick, itemId: v, price: String(menu.find((m) => m.id === v)?.price ?? "") })}
              options={[{ value: "", label: "Pilih menu" }, ...menu.filter((m) => m.active).map((m) => ({ value: m.id, label: `${m.name} · ${rupiah(m.price)}` }))]}
            />
            <div className="form-grid">
              <label>
                Jumlah porsi
                <input type="number" inputMode="numeric" min={1} max={999} value={pick.qty} onChange={(e) => setPick({ ...pick, qty: e.target.value })} />
              </label>
              <label>
                Harga per porsi
                <Money value={pick.price} onChange={(v) => setPick({ ...pick, price: v })} />
              </label>
            </div>
            <Button variant="secondary" disabled={!pick.itemId || !Number(pick.qty)} onClick={addLine}>
              <Plus size={16} /> Tambah menu
            </Button>
            <div className="form-grid mt">
              <label>
                Diskon
                <Money value={draft.discount} onChange={(v) => setDraft({ ...draft, discount: v })} />
              </label>
              {!draft.id && (
                <label>
                  Uang muka (DP)
                  <Money value={draft.dp} onChange={(v) => setDraft({ ...draft, dp: v })} />
                </label>
              )}
            </div>
            {!draft.id && Number(draft.dp) > 0 && <Select label="DP diterima sebagai" value={source} onChange={(v) => setSource(v as Payment["from"])} options={sources} />}
            <label>
              Catatan
              <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="Contoh: 2 tumpeng, sendok garpu disertakan" />
            </label>
            <div className="bill-total">
              <span>Total</span>
              <strong>{rupiah(preview.total)}</strong>
            </div>
            {invalid && (
              <p className="error" role="alert">
                {invalid}
              </p>
            )}
            <Button className="full" loading={busy} disabled={busy || !draft.name.trim() || !draft.lines.length || Boolean(invalid)} onClick={save}>
              Simpan pesanan
            </Button>
          </>
        )}
      </Dialog>
      <Dialog
        open={Boolean(paying)}
        onOpenChange={() => setPaying(undefined)}
        title="Terima pembayaran"
        description={paying && `${paying.so.number} · ${paying.so.customer.name} · sisa ${rupiah(balance(paying.so))}`}
      >
        {paying && (
          <>
            <label>
              Jumlah diterima
              <Money value={paying.amount} onChange={(v) => setPaying({ ...paying, amount: v })} />
            </label>
            <Select label="Diterima sebagai" value={source} onChange={(v) => setSource(v as Payment["from"])} options={sources} />
            <Button
              className="full"
              loading={busy}
              disabled={busy || !Number(paying.amount)}
              onClick={() =>
                void act(async () => {
                  await commands.paySalesOrder(paying.so.id, Number(paying.amount), source);
                  setPaying(undefined);
                }, "Pembayaran pesanan tercatat")
              }
            >
              Simpan pembayaran
            </Button>
          </>
        )}
      </Dialog>
      <Dialog open={Boolean(delivering)} onOpenChange={() => setDelivering(undefined)} title="Tandai terkirim" description={delivering && `${delivering.number} · ${delivering.customer.name}`}>
        <p className="callout">Bahan sesuai resep menu dikurangi dari stok. Sisa tagihan tetap tercatat sampai dibayar.</p>
        <Button
          className="full"
          loading={busy}
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await commands.deliverSalesOrder(delivering!.id);
              setDelivering(undefined);
            }, "Pesanan terkirim; stok diperbarui")
          }
        >
          Konfirmasi pengiriman
        </Button>
      </Dialog>
      <Dialog open={Boolean(cancelling)} onOpenChange={() => setCancelling(undefined)} title="Batalkan pesanan" description={cancelling?.so.number}>
        {cancelling && (
          <>
            <label>
              Alasan wajib
              <textarea value={cancelling.reason} onChange={(e) => setCancelling({ ...cancelling, reason: e.target.value })} />
            </label>
            {paidValue(cancelling.so) > 0 && (
              <>
                <label>
                  Uang muka dikembalikan (0 = hangus)
                  <Money value={cancelling.refund} onChange={(v) => setCancelling({ ...cancelling, refund: v })} />
                </label>
                {Number(cancelling.refund) > 0 && <Select label="Dikembalikan dari" value={source} onChange={(v) => setSource(v as Payment["from"])} options={sources} />}
              </>
            )}
            <Button
              variant="destructive"
              className="full"
              loading={busy}
              disabled={busy || !cancelling.reason.trim()}
              onClick={() =>
                void act(async () => {
                  await commands.cancelSalesOrder(cancelling.so.id, cancelling.reason, Number(cancelling.refund || 0), source);
                  setCancelling(undefined);
                }, "Pesanan dibatalkan")
              }
            >
              Konfirmasi pembatalan
            </Button>
          </>
        )}
      </Dialog>
      {printing && <DocumentDialog title={printing.number} text={text(printing)} phone={printing.customer.phone} onClose={() => setPrinting(undefined)} />}
    </section>
  );
}
