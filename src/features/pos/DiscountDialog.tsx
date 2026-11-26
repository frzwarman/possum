import { useState } from "react";
import { Search } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Money } from "../../components/ui/money";
import { businessDay, discountAmount, discountFor, discountRunning, orderTotals, rupiah, when } from "../../domain/calculate";
import type { Discount, DiscountRule, Draft, Line, MenuType, Settings } from "../../domain/types";

// What the cashier chose; the till decides whether a manager's PIN is needed before it lands on the cart.
export type DiscountPick = { discountId?: string; discount: number; reason: string; rule?: DiscountRule };
const scopeText: Record<Discount["scope"], string> = { order: "seluruh pesanan", beverage: "minuman saja", food: "makanan saja", snack: "camilan saja", items: "menu pilihan" };
const REASONS = ["Pelanggan tetap", "Komplain", "Acara", "Lainnya"];

// Figma Cashier 2 "Discount: one tap for a saved one, or manual with Toper's OK": the saved discounts running today, each
// one tap (the cart changes right away); or a manual one by percent or rupiah, on the whole order or one type, with a
// reason, for a manager's PIN.
export function DiscountDialog({ open, onClose, draft, settings, manager, type, onPick }: {
  open: boolean;
  onClose: () => void;
  draft: Draft;
  settings?: Settings;
  manager: boolean;
  type: (l: Line) => MenuType;
  onPick: (pick: DiscountPick) => void;
}) {
  const today = businessDay(new Date().toISOString(), settings?.timezone, settings?.cutoff);
  const running = (settings?.discounts ?? []).filter((d) => discountRunning(d, today));
  const [tab, setTab] = useState<"saved" | "manual">(running.length ? "saved" : "manual");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Discount["kind"]>("percent");
  const [value, setValue] = useState("10");
  const [scope, setScope] = useState<"order" | "beverage" | "food">("order");
  const [reason, setReason] = useState(REASONS[0]);
  const [other, setOther] = useState("");
  const bill = (discount: number) => orderTotals({ lines: draft.lines, discount, mode: draft.mode }, settings ?? { taxBps: 0, serviceBps: 0 });
  const subtotal = bill(0).subtotal;
  const day = (d: string) => when(`${d}T12:00:00Z`, settings?.timezone, { day: "numeric", month: "short" });
  const describe = (d: Discount) => [d.note, d.kind === "percent" ? `${d.value}% ${scopeText[d.scope]}` : scopeText[d.scope], d.minSpend ? `min. ${rupiah(d.minSpend)}` : "", d.approval ? "perlu PIN manajer" : "", `sampai ${day(d.to)}`].filter(Boolean).join(" · ");
  const shown = running.filter((d) => `${d.name} ${d.note}`.toLowerCase().includes(query.trim().toLowerCase()));
  const manual = discountFor({ id: "", name: "", note: "", kind, value: Number(value) || 0, scope, from: "", to: "" }, draft.lines, type);
  const why = reason === "Lainnya" ? other.trim() : reason;
  const applied = draft.discount > 0 || Boolean(draft.discountId);
  return (
    <Dialog open={open} onOpenChange={onClose} title="Diskon" description={`${draft.lines.filter((l) => !l.cancelled).length} menu · ${rupiah(subtotal)} sebelum pajak`} className="discount-dialog">
      <div className="segmented discount-tabs" role="group" aria-label="Jenis diskon">
        <button type="button" className={tab === "saved" ? "active" : ""} aria-pressed={tab === "saved"} onClick={() => setTab("saved")}>Tersimpan {running.length}</button>
        <button type="button" className={tab === "manual" ? "active" : ""} aria-pressed={tab === "manual"} onClick={() => setTab("manual")}>Manual</button>
      </div>
      {tab === "saved" ? (
        <>
          <label className="discount-search">
            <Search size={16} aria-hidden />
            <input aria-label="Cari diskon" placeholder="Cari diskon atau kode voucher" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="discount-list">
            {shown.map((d) => {
              const amount = discountFor(d, draft.lines, type);
              const on = draft.discountId === d.id;
              return (
                <button type="button" key={d.id} className={`discount-card${on ? " on" : ""}`} aria-pressed={on} disabled={!amount} onClick={() => onPick({ discountId: d.id, discount: amount, reason: d.name })}>
                  <span className={`discount-icon ${d.kind}`} aria-hidden>{d.kind === "percent" ? "%" : "Rp"}</span>
                  <span>
                    <strong>{d.name}</strong>
                    <small>{amount ? describe(d) : d.minSpend && subtotal < d.minSpend ? `Belum mencapai minimal ${rupiah(d.minSpend)}` : "Tidak ada menu yang termasuk"}</small>
                  </span>
                  <b>−{discountAmount(d)}</b>
                </button>
              );
            })}
            {!running.length && <p className="small muted">Belum ada diskon tersimpan yang berlaku hari ini. Manajer menambahkannya di menu Diskon.</p>}
            {running.length > 0 && !shown.length && <p className="small muted">Tidak ada diskon yang cocok.</p>}
          </div>
          <p className="small muted">Ketuk diskon tersimpan, keranjang langsung berubah. Diskon manual perlu persetujuan manajer.</p>
        </>
      ) : (
        <>
          <div className="discount-kinds" role="group" aria-label="Tipe diskon">
            {(["percent", "amount"] as const).map((k) => (
              <button type="button" key={k} className={`discount-kind${kind === k ? " on" : ""}`} aria-pressed={kind === k} onClick={() => { setKind(k); setValue(k === "percent" ? "10" : "10000"); }}>
                <span className={`discount-icon ${k}`} aria-hidden>{k === "percent" ? "%" : "Rp"}</span>
                <span><strong>{k === "percent" ? "Persen" : "Rupiah"}</strong><small>{k === "percent" ? "mis. 10% off" : "mis. Rp10.000 off"}</small></span>
              </button>
            ))}
          </div>
          {kind === "percent" ? (
            <>
              <label>Diskon (%)<input inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, "").slice(0, 3))} /></label>
              <div className="pill-row" role="group" aria-label="Persen cepat">
                {[5, 10, 15, 20].map((p) => <button type="button" key={p} aria-pressed={value === String(p)} onClick={() => setValue(String(p))}>{p}%</button>)}
              </div>
            </>
          ) : (
            <label>Potongan<Money value={value} onChange={setValue} /></label>
          )}
          <div className="field"><span className="field-label">Berlaku untuk</span>
            <div className="pill-row">
              {([["order", "Seluruh pesanan"], ["beverage", "Minuman"], ["food", "Makanan"]] as const).map(([s, label]) => <button type="button" key={s} aria-pressed={scope === s} onClick={() => setScope(s)}>{label}</button>)}
            </div>
          </div>
          <div className="field"><span className="field-label">Alasan</span>
            <div className="pill-row">
              {REASONS.map((r) => <button type="button" key={r} aria-pressed={reason === r} onClick={() => setReason(r)}>{r}</button>)}
            </div>
          </div>
          {reason === "Lainnya" && <label>Alasan lain<input value={other} maxLength={60} onChange={(e) => setOther(e.target.value)} /></label>}
          <div className="discount-sum">
            <span>Diskon, {scope === "order" ? "seluruh pesanan" : scope === "beverage" ? "minuman" : "makanan"}{kind === "percent" ? ` ${Number(value) || 0}%` : ""}</span><b>−{rupiah(manual)}</b>
            <span>Total baru, termasuk pajak</span><strong>{rupiah(bill(manual).total)}</strong>
          </div>
          {!manager && <p className="small muted">Diskon manual perlu persetujuan manajer: PIN-nya di kasir, atau lewat Telegram bila tidak di tempat. Sama seperti pembatalan.</p>}
          <Button className="full" disabled={!manual || !why || (kind === "percent" && Number(value) > 100)} onClick={() => onPick({ discount: manual, reason: why, rule: { kind, value: Math.min(Number(value), 1e9), scope } })}>
            {manager ? "Terapkan diskon" : "Minta persetujuan manajer"}
          </Button>
        </>
      )}
      {applied && (
        <Button variant="ghost" className="full" onClick={() => onPick({ discount: 0, reason: "Diskon dilepas" })}>
          Lepas diskon {draft.discountReason}
        </Button>
      )}
    </Dialog>
  );
}
