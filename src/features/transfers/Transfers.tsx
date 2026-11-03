import { useEffect, useState } from "react";
import { Navigate } from "@tanstack/react-router";
import { ArrowLeftRight, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useApp } from "../../app/context";
import { Button } from "../../components/ui/button";
import { Select } from "../../components/ui/select";
import { Dialog } from "../../components/ui/dialog";
import { convert, quantity, rupiah, when } from "../../domain/calculate";
import type { Transfer } from "../../domain/types";
const status = { sent: "Dalam perjalanan", received: "Diterima", cancelled: "Dibatalkan" };
// Stock leaves this outlet when sent and is in transit until the other outlet books it in.
export default function Transfers() {
  const { transfers, outlets, stockItems, user, settings, commands, act, busy, manager, setError } = useApp();
  const [tab, setTab] = useState("incoming");
  const [draft, setDraft] = useState<{ to: string; lines: { stockId: string; qty: number }[]; note: string }>();
  const [line, setLine] = useState({ stockId: "", amount: "", unit: "" });
  const [receiving, setReceiving] = useState<{ t: Transfer; rows: { target: string; amount: string }[] }>();
  const [cancelling, setCancelling] = useState<Transfer>();
  const [reason, setReason] = useState("");
  // Bootstrap only runs at sign-in; ask the server for what other outlets sent since then.
  useEffect(() => {
    commands.refreshTransfers().catch(() => undefined);
  }, [commands]);
  if (!manager) return <Navigate to="/pos" />;
  const item = (id: string) => stockItems.find((s) => s.id === id);
  const incoming = transfers.filter((t) => t.to === user.restaurantId);
  const shown = tab === "incoming" ? incoming.filter((t) => t.status === "sent") : tab === "outgoing" ? transfers.filter((t) => t.from === user.restaurantId) : transfers;
  function addLine() {
    const s = item(line.stockId);
    if (!draft || !s) return;
    try {
      const qty = convert(line.amount, line.unit || s.unit, s.unit);
      setDraft({ ...draft, lines: [...draft.lines.filter((l) => l.stockId !== s.id), { stockId: s.id, qty }] });
      setLine({ stockId: "", amount: "", unit: "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Jumlah tidak valid");
    }
  }
  function receive() {
    if (!receiving) return;
    try {
      const lines = receiving.t.lines.map((l, i) => {
        const amount = receiving.rows[i].amount.trim();
        return { stockId: l.stockId, target: receiving.rows[i].target, qty: amount === "" || amount === "0" ? 0 : convert(amount, l.unit, l.unit) };
      });
      void act(async () => {
        await commands.receiveTransfer(receiving.t.id, lines);
        setReceiving(undefined);
      }, "Transfer diterima dan masuk stok");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Jumlah tidak valid");
    }
  }
  return (
    <section className="page-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Antar-outlet</p>
          <h1>Transfer stok</h1>
          <p className="muted">Kirim bahan ke outlet lain dan terima kiriman dari mereka.</p>
        </div>
        <div className="button-row">
          <Button variant="secondary" aria-label="Muat ulang transfer" disabled={busy} onClick={() => void act(() => commands.refreshTransfers(), "Daftar transfer diperbarui")}>
            <RefreshCw size={16} />
          </Button>
          <Button disabled={!outlets.length} onClick={() => setDraft({ to: outlets[0]?.id ?? "", lines: [], note: "" })}>
            <Plus size={17} /> Kirim transfer
          </Button>
        </div>
      </div>
      {!outlets.length && (
        <p className="callout">
          Belum ada outlet lain yang terhubung. Pemilik menghubungkan outlet dari terminal: <code>pnpm staff link-outlets {user.restaurantId} &lt;id-outlet-lain&gt;</code>
        </p>
      )}
      <div className="category-tabs">
        {[["incoming", `Masuk (${incoming.filter((t) => t.status === "sent").length})`], ["outgoing", "Keluar"], ["all", "Semua"]].map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="orders-grid">
        {shown.map((t) => {
          const mine = t.from === user.restaurantId;
          return (
            <article className="order-card" key={t.id}>
              <div className="order-card-heading">
                <span className="order-symbol">
                  <ArrowLeftRight />
                </span>
                <span className={`badge ${t.status === "received" ? "badge-green" : ""}`}>{status[t.status]}</span>
              </div>
              <h2>{mine ? `Ke ${t.toName}` : `Dari ${t.fromName}`}</h2>
              <p className="muted small">
                {t.number} · {when(t.sentAt, settings?.timezone)}
              </p>
              <div className="order-item-list">
                {t.lines.map((l) => (
                  <div key={l.stockId}>
                    <span>
                      {l.name} {quantity(l.qty)} {l.unit}
                    </span>
                    {l.value > 0 && <small>{rupiah(l.value)}</small>}
                  </div>
                ))}
              </div>
              {t.note && <p className="small muted">{t.note}</p>}
              {t.cancelReason && <p className="small muted">Dibatalkan: {t.cancelReason}</p>}
              {t.status === "sent" && !mine && (
                <Button
                  className="full mt"
                  onClick={() =>
                    setReceiving({
                      t,
                      rows: t.lines.map((l) => ({ target: item(l.stockId)?.unit === l.unit ? l.stockId : "", amount: String(l.qty / 1000) })),
                    })
                  }
                >
                  Terima transfer
                </Button>
              )}
              {t.status === "sent" && mine && (
                <Button
                  className="full mt"
                  variant="ghost"
                  onClick={() => {
                    setReason("");
                    setCancelling(t);
                  }}
                >
                  Batalkan transfer
                </Button>
              )}
            </article>
          );
        })}
      </div>
      {!shown.length && (
        <div className="empty-state">
          <ArrowLeftRight size={42} strokeWidth={1.3} />
          <h2>{tab === "incoming" ? "Tidak ada kiriman yang menunggu" : "Belum ada transfer"}</h2>
          <p>Stok berkurang di outlet pengirim saat dikirim dan bertambah di outlet tujuan saat diterima.</p>
        </div>
      )}
      <Dialog open={Boolean(draft)} onOpenChange={() => setDraft(undefined)} title="Kirim transfer">
        {draft && (
          <>
            <Select label="Outlet tujuan" value={draft.to} onChange={(v) => setDraft({ ...draft, to: v })} options={outlets.map((o) => ({ value: o.id, label: o.name }))} />
            {draft.lines.map((l) => (
              <div className="bill-row" key={l.stockId}>
                <span>
                  {item(l.stockId)?.name} {quantity(l.qty)} {item(l.stockId)?.unit}
                </span>
                <button className="text-button" aria-label={`Hapus ${item(l.stockId)?.name}`} onClick={() => setDraft({ ...draft, lines: draft.lines.filter((x) => x.stockId !== l.stockId) })}>
                  <Trash2 size={15} />
                </button>
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
                Jumlah ({item(line.stockId)?.unit ?? "satuan dasar"})
                <input inputMode="decimal" value={line.amount} onChange={(e) => setLine({ ...line, amount: e.target.value })} placeholder="0" />
              </label>
            </div>
            <Button variant="secondary" disabled={!line.stockId || !line.amount} onClick={addLine}>
              <Plus size={16} /> Tambah bahan
            </Button>
            <label className="mt">
              Catatan (opsional)
              <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="Contoh: dibawa kurir pagi" />
            </label>
            <Button
              className="full"
              loading={busy}
              disabled={busy || !draft.to || !draft.lines.length}
              onClick={() =>
                void act(async () => {
                  await commands.sendTransfer(outlets.find((o) => o.id === draft.to)!, draft.lines, draft.note);
                  setDraft(undefined);
                  setTab("outgoing");
                }, "Transfer dikirim; stok outlet ini berkurang")
              }
            >
              Kirim sekarang
            </Button>
          </>
        )}
      </Dialog>
      <Dialog open={Boolean(receiving)} onOpenChange={() => setReceiving(undefined)} title="Terima transfer" description={receiving && `${receiving.t.number} dari ${receiving.t.fromName}`}>
        {receiving && (
          <>
            <p className="small muted">Pilih bahan di outlet ini untuk setiap baris dan isi yang benar-benar datang; 0 = hilang di jalan.</p>
            {receiving.t.lines.map((l, i) => (
              <div className="form-grid" key={l.stockId}>
                <Select
                  label={`${l.name} (${l.unit}) masuk ke`}
                  value={receiving.rows[i].target}
                  onChange={(v) => setReceiving({ ...receiving, rows: receiving.rows.map((r, j) => (j === i ? { ...r, target: v } : r)) })}
                  options={[{ value: "", label: "Pilih bahan" }, ...stockItems.filter((s) => s.unit === l.unit).map((s) => ({ value: s.id, label: s.name }))]}
                />
                <label>
                  Diterima ({l.unit})
                  <input
                    inputMode="decimal"
                    value={receiving.rows[i].amount}
                    onChange={(e) => setReceiving({ ...receiving, rows: receiving.rows.map((r, j) => (j === i ? { ...r, amount: e.target.value } : r)) })}
                  />
                </label>
              </div>
            ))}
            <Button className="full" loading={busy} disabled={busy} onClick={receive}>
              Konfirmasi penerimaan
            </Button>
          </>
        )}
      </Dialog>
      <Dialog open={Boolean(cancelling)} onOpenChange={() => setCancelling(undefined)} title="Batalkan transfer" description="Bahan kembali ke stok outlet ini.">
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
              await commands.cancelTransfer(cancelling!.id, reason);
              setCancelling(undefined);
            }, "Transfer dibatalkan; stok kembali")
          }
        >
          Konfirmasi pembatalan
        </Button>
      </Dialog>
    </section>
  );
}
