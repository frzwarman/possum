import { useState } from "react";
import { Check, Ellipsis, Plus, Search, Trash2 } from "lucide-react";
import { useApp } from "../../app/context";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Money } from "../../components/ui/money";
import { can } from "../../domain/permissions";
import { businessDay, discountAmount, discountFor, menuType, rupiah, typeLabel, when } from "../../domain/calculate";
import type { Discount, Line, MenuType } from "../../domain/types";
import { uid } from "../../lib/db";

// Figma Manager 7 "Discounts": every saved discount and voucher in one list. The manager adds one for an event, ends or
// deletes old ones, and the cashier's list changes right away: they live in the restaurant settings and sync with them.
// An ended one stays listed so the reports that name it still make sense.
type State = "active" | "soon" | "ended";
const stateOf = (d: Discount, day: string): State => (d.ended || d.to < day ? "ended" : d.from > day ? "soon" : "active");
const stateLabel: Record<State, [string, string]> = { active: ["Aktif", "good"], soon: ["Terjadwal", "warning"], ended: ["Selesai", ""] };
const addDays = (day: string, n: number) => new Date(new Date(`${day}T12:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

export default function Discounts() {
  const { settings, orders, menu, user, commands, act, busy } = useApp();
  const tz = settings?.timezone;
  const today = businessDay(new Date().toISOString(), tz, settings?.cutoff);
  const list = settings?.discounts ?? [];
  const [show, setShow] = useState<"all" | "active" | "ended">("all");
  const [query, setQuery] = useState("");
  const [menuFor, setMenuFor] = useState<string>();
  const [removing, setRemoving] = useState<Discount>();
  const [editing, setEditing] = useState<{ d: Discount; fresh: boolean }>();
  if (!can(user.role, "settings")) return <section className="page-content"><h1>Diskon</h1><p className="muted">Hanya pemilik dan manajer yang mengatur diskon tersimpan.</p></section>;
  const short = (day: string) => when(`${day}T12:00:00Z`, tz, { day: "numeric", month: "short" });
  const used = (d: Discount) => orders.filter((o) => o.discountId === d.id && o.status !== "void").length;
  const scope = (d: Discount) => (d.scope === "order" ? "Seluruh pesanan" : d.scope === "items" ? `${d.items?.length ?? 0} menu pilihan` : typeLabel[d.scope]);
  const rules = (d: Discount) => [d.minSpend ? `Min. ${rupiah(d.minSpend)}` : "", d.approval ? "Perlu PIN manajer" : ""].filter(Boolean).join(" · ") || "Tanpa syarat";
  const count = (s: typeof show) => list.filter((d) => s === "all" || (s === "ended") === (stateOf(d, today) === "ended")).length;
  const shown = list.filter((d) => (show === "all" || (show === "ended") === (stateOf(d, today) === "ended")) && `${d.name} ${d.note}`.toLowerCase().includes(query.trim().toLowerCase()));
  const save = (next: Discount[], message: string) => act(() => commands.settings({ ...settings!, discounts: next }), message);
  if (editing) return <DiscountForm start={editing.d} fresh={editing.fresh} today={today} onCancel={() => setEditing(undefined)} onSave={async (d) => { await save(editing.fresh ? [d, ...list] : list.map((x) => (x.id === d.id ? d : x)), `${d.name} tersimpan. Langsung muncul di daftar diskon kasir.`); setEditing(undefined); }} busy={busy} menu={menu} tz={tz} />;
  return (
    <section className="page-content discounts-page">
      <div className="page-heading">
        <div><p className="crumb-text small muted">Diskon</p><h1>Diskon tersimpan</h1></div>
        <div className="discounts-tools">
          <div className="search-box"><Search size={20} aria-hidden /><input aria-label="Cari diskon" placeholder="Cari nama atau kode" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
          <Button className="btn-accent" onClick={() => setEditing({ fresh: true, d: { id: uid(), name: "", note: "", kind: "percent", value: 10, scope: "order", from: today, to: addDays(today, 6) } })}><Plus size={18} /> Diskon baru</Button>
        </div>
      </div>
      <div className="category-tabs">
        {([["all", "Semua"], ["active", "Aktif"], ["ended", "Selesai"]] as const).map(([id, label]) => <button key={id} className={show === id ? "active" : ""} aria-pressed={show === id} onClick={() => setShow(id)}>{label}<span>{count(id)}</span></button>)}
      </div>
      <div className="panel">
        {shown.length ? (
          <div className="table-scroll">
            <table className="data-table plain-table discounts-table">
              <thead><tr><th>Nama</th><th>Jumlah</th><th>Berlaku untuk</th><th>Aturan</th><th>Masa berlaku</th><th>Status</th><th className="num">Dipakai</th><th aria-label="Aksi" /></tr></thead>
              <tbody>
                {shown.map((d) => {
                  const st = stateOf(d, today);
                  return (
                    <tr key={d.id}>
                      <td><strong>{d.name}</strong>{d.note && <small>{d.note}</small>}</td>
                      <td><strong>{discountAmount(d)}</strong></td>
                      <td>{scope(d)}</td>
                      <td className="muted">{rules(d)}</td>
                      <td>{short(d.from)} – {short(d.to)}</td>
                      <td><span className={`dot-chip ${stateLabel[st][1]}`}>{stateLabel[st][0]}</span></td>
                      <td className="num">{used(d)}</td>
                      <td className="row-menu-cell">
                        <button type="button" className="row-menu-button" aria-label={`Aksi ${d.name}`} aria-expanded={menuFor === d.id} onClick={() => setMenuFor(menuFor === d.id ? undefined : d.id)}><Ellipsis size={18} /></button>
                        {menuFor === d.id && (
                          <div className="row-menu" onKeyDown={(e) => e.key === "Escape" && setMenuFor(undefined)}>
                            <button type="button" onClick={() => { setMenuFor(undefined); setEditing({ fresh: false, d: { ...d } }); }}>Ubah</button>
                            {st === "ended" ? (
                              <button type="button" onClick={() => { setMenuFor(undefined); setEditing({ fresh: false, d: { ...d, ended: false, from: today, to: addDays(today, Math.max(0, (Date.parse(d.to) - Date.parse(d.from)) / 86400000)) } }); }}>Jalankan lagi</button>
                            ) : (
                              <button type="button" onClick={() => { setMenuFor(undefined); void save(list.map((x) => (x.id === d.id ? { ...x, ended: true } : x)), `${d.name} diakhiri. Hilang dari daftar kasir.`); }}>Akhiri sekarang</button>
                            )}
                            <button type="button" className="danger" onClick={() => { setMenuFor(undefined); setRemoving(d); }}><Trash2 size={15} /> Hapus</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">{list.length ? "Tidak ada diskon yang cocok." : "Belum ada diskon tersimpan. Tambahkan untuk acara atau voucher; kasir memakainya dengan sekali ketuk."}</p>
        )}
      </div>
      <p className="small muted">Diskon aktif langsung muncul di daftar diskon kasir. Yang sudah selesai tetap di sini agar laporan tetap masuk akal.</p>
      <Dialog open={Boolean(removing)} onOpenChange={() => setRemoving(undefined)} title={`Hapus ${removing?.name ?? "diskon"}?`} description="Pesanan yang sudah memakai diskon ini tetap tercatat dengan namanya. Untuk berhenti memakainya saja, pilih Akhiri sekarang.">
        <div className="detail-actions pair">
          <Button variant="secondary" onClick={() => setRemoving(undefined)}>Batal</Button>
          <Button variant="destructive" loading={busy} onClick={async () => { const d = removing!; await save(list.filter((x) => x.id !== d.id), `${d.name} dihapus`); setRemoving(undefined); }}>Hapus</Button>
        </div>
      </Dialog>
    </section>
  );
}

// Figma "New discount": what it is, how much, when, on what, and its rules; beside it, how the cashier sees it and what it
// does to an example order made from this menu.
function DiscountForm({ start, fresh, today, onCancel, onSave, busy, menu, tz }: {
  start: Discount; fresh: boolean; today: string; onCancel: () => void; onSave: (d: Discount) => Promise<void>; busy: boolean;
  menu: ReturnType<typeof useApp>["menu"]; tz?: string;
}) {
  const [d, setD] = useState(start);
  const [pick, setPick] = useState("");
  const [min, setMin] = useState(Boolean(start.minSpend));
  const set = (p: Partial<Discount>) => setD({ ...d, ...p });
  const active = menu.filter((m) => m.active);
  const type = (l: Pick<Line, "itemId">): MenuType => { const m = menu.find((x) => x.id === l.itemId); return m ? menuType(m) : "food"; };
  const line = (id: string, qty = 1): Line => { const m = menu.find((x) => x.id === id)!; return { id, itemId: id, name: m.name, price: m.price, qty, modifiers: [], note: "", recipe: [], catalogVersion: m.version, prepared: false, cancelled: false }; };
  const hits = (id: string) => d.scope === "order" || (d.scope === "items" ? (d.items ?? []).includes(id) : type({ itemId: id }) === d.scope);
  // Example: two items it covers and one it doesn't, from this menu.
  const example = [...active.filter((m) => hits(m.id)).slice(0, 2).map((m, i) => line(m.id, i ? 1 : 2)), ...active.filter((m) => !hits(m.id)).slice(0, 1).map((m) => line(m.id))];
  const off = discountFor({ ...d, minSpend: min ? d.minSpend : undefined }, example, type);
  const valid = d.name.trim().length > 0 && d.name.length <= 60 && Number.isInteger(d.value) && d.value >= 1 && (d.kind === "percent" ? d.value <= 100 : d.value <= 1_000_000_000) && d.from && d.to && d.from <= d.to && (d.scope !== "items" || (d.items ?? []).length > 0) && (!min || (d.minSpend ?? 0) > 0);
  const scopeText = d.scope === "order" ? "seluruh pesanan" : d.scope === "items" ? `${(d.items ?? []).length} menu pilihan` : `${typeLabel[d.scope].toLowerCase()} saja`;
  const day = (s: string) => when(`${s}T12:00:00Z`, tz, { day: "numeric", month: "short" });
  return (
    <section className="page-content discounts-page">
      <div className="page-heading">
        <div><button type="button" className="crumb" onClick={onCancel}>Diskon</button><h1>{fresh ? "Diskon baru" : `Ubah ${start.name}`}</h1></div>
        <div className="discounts-tools">
          <Button variant="ghost" onClick={onCancel}>Batal</Button>
          <Button className="btn-accent" disabled={!valid || busy} onClick={() => onSave({ ...d, name: d.name.trim(), note: d.note.trim(), minSpend: min ? d.minSpend : undefined, items: d.scope === "items" ? d.items : undefined })}><Check size={18} /> Simpan diskon</Button>
        </div>
      </div>
      <div className="discount-form">
        <article className="panel">
          <label>Nama<input value={d.name} maxLength={60} placeholder="Hari Guru" onChange={(e) => set({ name: e.target.value })} /></label>
          <label>Keterangan<input value={d.note} maxLength={60} placeholder="Hari guru, kode HSMUN, tamu acara" onChange={(e) => set({ note: e.target.value })} /></label>
          <div className="field"><span className="field-label">Tipe diskon</span>
            <div className="discount-kinds">
              {(["percent", "amount"] as const).map((k) => (
                <button type="button" key={k} className={`discount-kind${d.kind === k ? " on" : ""}`} aria-pressed={d.kind === k} onClick={() => set({ kind: k, value: k === "percent" ? 10 : 25000 })}>
                  <span className={`discount-icon ${k}`} aria-hidden>{k === "percent" ? "%" : "Rp"}</span><span><strong>{k === "percent" ? "Persen" : "Rupiah"}</strong></span>
                </button>
              ))}
            </div>
          </div>
          <div className="discount-dates">
            {d.kind === "percent" ? <label>Jumlah (%)<input inputMode="numeric" value={d.value || ""} onChange={(e) => set({ value: Number(e.target.value.replace(/\D/g, "").slice(0, 3)) })} /></label> : <label>Jumlah<Money value={String(d.value || "")} onChange={(v) => set({ value: Number(v) || 0 })} /></label>}
            <label>Mulai<input type="date" value={d.from} onChange={(e) => set({ from: e.target.value })} /></label>
            <label>Sampai<input type="date" value={d.to} min={d.from} onChange={(e) => set({ to: e.target.value })} /></label>
          </div>
          <div className="field"><span className="field-label">Berlaku untuk</span>
            <div className="pill-row">
              {([["order", "Seluruh pesanan"], ["type", "Satu jenis"], ["items", "Beberapa menu"]] as const).map(([s, label]) => {
                const on = s === "type" ? !["order", "items"].includes(d.scope) : d.scope === s;
                return <button type="button" key={s} aria-pressed={on} onClick={() => set({ scope: s === "type" ? "beverage" : s })}>{label}</button>;
              })}
            </div>
          </div>
          {!["order", "items"].includes(d.scope) && (
            <div className="field"><span className="field-label">Jenis menu</span>
              <div className="pill-row">{(["beverage", "food", "snack"] as const).map((t) => <button type="button" key={t} aria-pressed={d.scope === t} onClick={() => set({ scope: t })}>{typeLabel[t]}</button>)}</div>
            </div>
          )}
          {d.scope === "items" && (
            <div className="field discount-items"><span className="field-label">Menu yang dapat diskon ({(d.items ?? []).length})</span>
              <input aria-label="Cari menu" placeholder="Cari menu" value={pick} onChange={(e) => setPick(e.target.value)} />
              <div className="discount-item-list">
                {active.filter((m) => m.name.toLowerCase().includes(pick.trim().toLowerCase())).map((m) => (
                  <label key={m.id} className="check-row"><input type="checkbox" checked={(d.items ?? []).includes(m.id)} onChange={(e) => set({ items: e.target.checked ? [...(d.items ?? []), m.id] : (d.items ?? []).filter((x) => x !== m.id) })} />{m.name}<small>{rupiah(m.price)}</small></label>
                ))}
              </div>
            </div>
          )}
          <div className="field"><span className="field-label">Aturan</span>
            <label className="switch-row"><span><strong>Minimal belanja</strong><small>{min ? "Hanya tagihan dari jumlah ini" : "Mati: tagihan berapa pun bisa"}</small></span><input type="checkbox" role="switch" checked={min} onChange={(e) => setMin(e.target.checked)} /></label>
            {min && <label>Minimal belanja<Money value={String(d.minSpend ?? "")} onChange={(v) => set({ minSpend: Number(v) || 0 })} /></label>}
            <label className="switch-row"><span><strong>Perlu persetujuan manajer di kasir</strong><small>{d.approval ? "Kasir meminta PIN manajer saat memakainya" : "Mati: kasir memakainya dengan sekali ketuk"}</small></span><input type="checkbox" role="switch" checked={Boolean(d.approval)} onChange={(e) => set({ approval: e.target.checked })} /></label>
          </div>
        </article>
        <div className="discount-preview">
          <article className="panel">
            <h2>Di tablet kasir</h2>
            <div className="discount-card on" aria-hidden>
              <span className={`discount-icon ${d.kind}`} aria-hidden>{d.kind === "percent" ? "%" : "Rp"}</span>
              <span><strong>{d.name || "Nama diskon"}</strong><small>{[d.kind === "percent" ? `${d.value}% ${scopeText}` : scopeText, min && d.minSpend ? `min. ${rupiah(d.minSpend)}` : "", d.to ? `sampai ${day(d.to)}` : ""].filter(Boolean).join(" · ")}</small></span>
              <b>−{discountAmount(d)}</b>
            </div>
            <p className="small muted">{d.approval ? "Kasir memilihnya, lalu manajer mengetik PIN." : "Sekali ketuk, keranjang langsung berubah."}{d.from > today ? ` Mulai muncul ${day(d.from)}.` : ""}</p>
          </article>
          <article className="panel">
            <h2>Contoh pesanan</h2>
            {example.length ? example.map((l) => (
              <div className="example-line" key={l.id}><span>{l.qty}× {l.name}<small>{hits(l.itemId) ? typeLabel[type(l)] : `${typeLabel[type(l)]}, tanpa diskon`}</small></span><b>{rupiah(l.price * l.qty)}</b></div>
            )) : <p className="small muted">Belum ada menu aktif untuk contoh.</p>}
            {example.length > 0 && <div className="example-line total"><span>Diskon {d.name || "ini"}</span><b>−{rupiah(off)}</b></div>}
          </article>
        </div>
      </div>
    </section>
  );
}
