import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Navigate } from "@tanstack/react-router";
import { can } from "../../domain/permissions";
import { Search, Star, Plus, Minus, ShoppingBag, Utensils, ArrowRight, ChefHat, Save, Trash2, NotebookPen, Wallet, Check, Gift, CreditCard, QrCode, Printer } from "lucide-react";
import { useApp } from "../../app/context";
import { ApprovalDialog, type ApprovalRequest } from "../../app/Approval";
import { Button } from "../../components/ui/button";
import { Money } from "../../components/ui/money";
import { Dialog } from "../../components/ui/dialog";
import { businessDay, complimentDiscount, describeDelta, itemStation, menuType, nextPager, orderTotals, rupiah, search, typeLabel } from "../../domain/calculate";
import { team } from "../auth/Login";
import type { Compliment, Draft, Line, MenuItem, MenuType, Modifier, Order } from "../../domain/types";
import { uid } from "../../lib/db";
import { Receipt } from "../orders/Receipt";
// POS-3: a new order is dine-in with the next pager number of the day; one tap switches to take away.
const fresh = (label: string): Draft => ({ id: "current", revision: 0, label, mode: "dinein", lines: [], discount: 0, discountReason: "" });
const auto = /^Pager \d+$/;
const TYPES: [MenuType | "all", string][] = [["all", "Semua"], ["food", "Makanan"], ["beverage", "Minuman"], ["snack", "Camilan"]];
export default function Pos() {
  const { menu, hydrating, settings, db, commands, shift, act, busy, user, manager, setError, orders, stockItems, canMake } = useApp();
  const saved = useLiveQuery(() => db.drafts.get("current"), [db]);
  const [draft, setDraft] = useState<Draft>(() => fresh("Pager 1"));
  const initialized = useRef(false);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<MenuType | "all">("all");
  const [cartOpen, setCartOpen] = useState(false);
  const [selected, setSelected] = useState<MenuItem>();
  const [note, setNote] = useState("");
  const [mods, setMods] = useState<string[]>([]);
  const [checkout, setCheckout] = useState<Order>();
  const [receipt, setReceipt] = useState<Order>();
  const [method, setMethod] = useState<"cash" | "qris" | "card">("cash");
  const [edc, setEdc] = useState("");
  const [approvalCode, setApprovalCode] = useState("");
  const [received, setReceived] = useState("");
  const [verified, setVerified] = useState(false);
  const [opening, setOpening] = useState("200000");
  const [openingDialog, setOpeningDialog] = useState(false);
  const [discountDialog, setDiscountDialog] = useState(false);
  const [discountValue, setDiscountValue] = useState("0");
  const [discountReason, setDiscountReason] = useState("");
  const [ask, setAsk] = useState<ApprovalRequest>();
  const [saving, setSaving] = useState(false);
  if (!can(user.role, "sell")) return <Navigate to="/station" />;
  const tablets = Boolean(settings?.stationTablets);
  // Ziggy is cashless: card or QRIS on an EDC, no float, the receipt always prints.
  const cashless = Boolean(settings?.cashless);
  const edcs = settings?.edcs?.length ? settings.edcs : ["BCA", "BRI", "Mandiri"];
  const staff = team().map((m) => m.name);
  const today = businessDay(new Date().toISOString(), settings?.timezone, settings?.cutoff);
  const pager = `Pager ${nextPager(orders.filter((o) => businessDay(o.createdAt, settings?.timezone, settings?.cutoff) === today).map((o) => o.label))}`;
  useEffect(() => {
    if (!initialized.current && saved !== undefined) {
      setDraft(saved);
      initialized.current = true;
    }
  }, [saved]);
  useEffect(() => {
    void db.drafts.get("current").then((d) => {
      if (!initialized.current) {
        setDraft(d ?? fresh(pager));
        initialized.current = true;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db]);
  // An untouched new cart follows the day's pager sequence as orders come in.
  useEffect(() => {
    if (initialized.current && !draft.orderId && !draft.lines.length && auto.test(draft.label) && draft.label !== pager) void update({ ...draft, label: pager });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pager]);
  async function update(next: Draft) {
    // A discount belongs to the order it was given for: once a new cart is emptied, drop it so it
    // cannot slide onto the next customer's order.
    if (!next.orderId && !next.lines.length) next = { ...next, discount: 0, discountReason: "", discountApproval: undefined };
    // State first, storage second: a quick second tap or keystroke must see this draft, not the
    // one from before IndexedDB answered.
    setDraft(next);
    setSaving(true);
    try {
      await db.drafts.put(next);
    } catch {
      setError("Draf gagal disimpan. Penyimpanan perangkat penuh atau tidak tersedia. Ekspor data di Lainnya.");
    } finally {
      setSaving(false);
    }
  }
  const comp = draft.mode === "compliment" ? draft.compliment : undefined;
  const drink = (l: Line) => { const m = menu.find((x) => x.id === l.itemId); return m ? menuType(m) === "beverage" : l.station === "bar"; };
  const setCompliment = (c: Compliment) => void update({ ...draft, mode: "compliment", compliment: c });
  let total = { subtotal: 0, discount: 0, service: 0, tax: 0, total: 0 };
  let invalid = "";
  if (settings)
    try {
      total = orderTotals({ lines: draft.lines, discount: comp ? complimentDiscount(draft.lines, comp.kind, drink) : draft.discount, mode: draft.mode }, settings);
    } catch (e) {
      // e.g. a discount given before a line was removed. The draft is persisted, so throwing here
      // would break every reload too: show the problem and the undiscounted bill instead.
      invalid = e instanceof Error ? e.message : "Total pesanan tidak valid";
      try {
        total = orderTotals({ lines: draft.lines, discount: 0, mode: draft.mode }, settings);
      } catch {
        // the lines themselves are out of range; keep zeros
      }
    }
  const count = draft.lines.filter((l) => !l.cancelled).reduce((n, l) => n + l.qty, 0);
  // POS-4: size, milk, sugar and extras in one sheet, defaults preselected.
  const groupsOf = (item: MenuItem) => item.groups ?? [];
  const choices = (item: MenuItem, group: string) => item.modifiers.filter((m) => m.group === group);
  const loose = (item: MenuItem) => item.modifiers.filter((m) => !m.group || !groupsOf(item).some((g) => g.id === m.group));
  function add(item: MenuItem) {
    if (item.modifiers.length) {
      setSelected(item);
      setMods(groupsOf(item).flatMap((g) => { const c = choices(item, g.id); const d = c.find((m) => m.default) ?? (g.kind !== "add" && g.required ? c[0] : undefined); return d ? [d.id] : []; }));
      setNote("");
      return;
    }
    void addLine(item, [], "");
  }
  async function addLine(item: MenuItem, ids: string[], notes: string) {
    // A base choice (Regular, Susu segar, Normal) changes nothing and stays off the ticket.
    const picked = item.modifiers.filter((m) => ids.includes(m.id) && (m.price || m.recipe.length));
    const line: Line = { id: uid(), itemId: item.id, name: item.name, price: item.price, qty: 1, modifiers: picked, note: notes, recipe: item.recipe, catalogVersion: item.version, prepared: false, cancelled: false, station: itemStation(item) };
    await update({ ...draft, lines: [...draft.lines, line] });
    setSelected(undefined);
  }
  async function save() {
    // Pesanan may have moved the order on (a station marked it ready): send the revision it has now.
    const live = orders.find((o) => o.id === draft.orderId);
    const o = await act(() => commands.save({ ...draft, revision: live?.revision ?? draft.revision }), "Pesanan tersimpan di perangkat");
    if (o) {
      // The approval went out with this save and the server accepts it once.
      await update({ ...draft, orderId: o.id, revision: o.revision, lines: o.lines, discountApproval: undefined });
      return o;
    }
  }
  async function prepare() {
    const o = await save();
    if (o) {
      const p = await act(() => commands.prepare(o.id), "Pesanan dikirim ke stasiun");
      if (p) await update({ ...draft, orderId: p.id, revision: p.revision, lines: p.lines });
    }
  }
  async function newOrder() {
    // The saved order stays in Pesanan. Save edits first so nothing typed is lost, unless there is
    // nothing savable: an emptied cart (an order needs a line), or an order no longer open because
    // it was voided from Pesanan, where saving can only fail and would trap the cart.
    const open = orders.some((o) => o.id === draft.orderId && o.status === "open");
    if (!count || !open || (await save())) await update(fresh(pager));
  }
  // Pilot: without bar and kitchen tablets the cashier tells them; stock moves when the order is paid, so
  // paying first sends every unsent line (one prepare op) and then opens the payment sheet.
  async function payStart() {
    let o = await save();
    if (o && !tablets && o.lines.some((l) => !l.prepared && !l.cancelled)) {
      const p = await act(() => commands.prepare(o!.id));
      if (!p) return;
      await update({ ...draft, orderId: p.id, revision: p.revision, lines: p.lines });
      o = p;
    }
    if (o) {
      setCartOpen(false);
      // A free compliment (owner's family) has nothing to pay: record it and print the receipt.
      if (o.mode === "compliment" && o.totals.total === 0) {
        const done = await act(() => commands.pay(o!.id, "none", 0, true), "Compliment tersimpan");
        if (done) { await update(fresh(pager)); setReceipt(done); }
        return;
      }
      setCheckout(o);
      setReceived(String(o.totals.total));
      setMethod(cashless ? "card" : "cash");
      setEdc(cashless ? edcs[0] : "");
      setApprovalCode("");
      setVerified(cashless);
    }
  }
  async function pay() {
    if (!checkout) return;
    const paid = await act(() => commands.pay(checkout.id, method, Number(received), verified, { edc: method === "cash" ? undefined : edc, approvalCode }), "Pembayaran tersimpan di perangkat");
    if (paid) {
      setCheckout(undefined);
      await update(fresh(pager));
      setReceipt(paid);
    }
  }
  const active = menu.filter((m) => m.active);
  const filtered = search(active.filter((m) => type === "all" || menuType(m) === type), query);
  const optionPrice = selected ? selected.price + selected.modifiers.filter((m) => mods.includes(m.id)).reduce((n, m) => n + m.price, 0) : 0;
  const toggle = (item: MenuItem, m: Modifier, single: boolean) => setMods((ids) => single ? [...ids.filter((id) => !choices(item, m.group!).some((c) => c.id === id)), m.id] : ids.includes(m.id) ? ids.filter((id) => id !== m.id) : [...ids, m.id]);
  const cart = (
    <>
      <div className="cart-heading">
        <div>
          <h2>Pesanan saat ini</h2>
          <span className="muted small">{draft.orderId ? "Pesanan tersimpan" : "Pesanan baru"} · {count} item</span>
        </div>
        <span className="cart-glyph"><NotebookPen size={21} /></span>
      </div>
      <div className="cart-body">
        <div className="segmented">
          <button className={draft.mode === "dinein" ? "active" : ""} onClick={() => void update({ ...draft, mode: "dinein", compliment: undefined })}><Utensils size={16} /> Makan di sini</button>
          <button className={draft.mode === "takeaway" ? "active" : ""} onClick={() => void update({ ...draft, mode: "takeaway", compliment: undefined })}><ShoppingBag size={16} /> Bungkus</button>
          <button className={draft.mode === "compliment" ? "active" : ""} onClick={() => setCompliment(draft.compliment ?? { kind: "staff", who: "" })}><Gift size={16} /> Compliment</button>
        </div>
        {comp && (
          <div className="compliment-panel">
            <span className="small muted">Compliment untuk</span>
            <div className="choice-cards">
              <button className={comp.kind === "staff" ? "active" : ""} onClick={() => setCompliment({ ...comp, kind: "staff" })}><strong>Staff meal</strong><small>Minuman gratis, makanan 50%</small></button>
              <button className={comp.kind === "family" ? "active" : ""} onClick={() => setCompliment({ ...comp, kind: "family" })}><strong>Keluarga pemilik</strong><small>Semua gratis</small></button>
            </div>
            <label className="table-label">
              {comp.kind === "staff" ? "Siapa yang makan?" : "Untuk siapa?"}
              <input aria-label="Nama penerima compliment" placeholder={comp.kind === "staff" ? "Nama staf" : "Nama keluarga"} maxLength={60} value={comp.who} onChange={(e) => setCompliment({ ...comp, who: e.target.value })} />
            </label>
            {comp.kind === "staff" && staff.length > 0 && <div className="chip-row">{staff.map((n) => <button key={n} className={comp.who === n ? "chip active" : "chip"} onClick={() => setCompliment({ ...comp, who: n })}>{n}</button>)}</div>}
          </div>
        )}
        <label className="table-label">
          Nomor pager / meja
          <input placeholder="Pager 12" maxLength={100} value={draft.label} onChange={(e) => void update({ ...draft, label: e.target.value })} />
        </label>
        <div className="cart-lines">
          {!count ? (
            <div className="cart-empty">
              <ShoppingBag size={38} strokeWidth={1.3} />
              <h3>Mulai dari satu menu</h3>
              <p>Pilih menu di samping.<br />Pesanan akan muncul di sini.</p>
            </div>
          ) : (
            draft.lines.filter((l) => !l.cancelled).map((l) => (
              <div className="cart-line" key={l.id}>
                <div className="line-heading">
                  <strong>{l.name}</strong>
                  <span>{rupiah((l.price + l.modifiers.reduce((n, m) => n + m.price, 0)) * l.qty)}</span>
                </div>
                {l.modifiers.length > 0 && <p className="small muted">{l.modifiers.map((m) => m.name).join(", ")}</p>}
                {l.note && <p className="line-note">{l.note}</p>}
                <div className="line-bottom">
                  {/* The station badge tells the cashier where the line is made, even before it is sent. */}
                  {!l.prepared && <span className={`badge badge-${l.station ?? itemStation(menu.find((m) => m.id === l.itemId) ?? { category: "" })}`}>{(l.station ?? itemStation(menu.find((m) => m.id === l.itemId) ?? { category: "" })) === "bar" ? "Bar" : "Dapur"}</span>}
                  {l.prepared ? (
                    <span className={`badge badge-${l.station ?? "kitchen"}`}><ChefHat size={13} /> Dikirim · {(l.station ?? "kitchen") === "bar" ? "bar" : "dapur"} · {l.qty}×</span>
                  ) : (
                    <div className="quantity-control">
                      <button aria-label={`Kurangi ${l.name}`} onClick={() => void update({ ...draft, lines: draft.lines.flatMap((x) => (x.id !== l.id ? [x] : x.qty > 1 ? [{ ...x, qty: x.qty - 1 }] : [])) })}><Minus size={15} /></button>
                      <span>{l.qty}</span>
                      <button aria-label={`Tambah ${l.name}`} onClick={() => void update({ ...draft, lines: draft.lines.map((x) => (x.id === l.id ? { ...x, qty: x.qty + 1 } : x)) })}><Plus size={15} /></button>
                    </div>
                  )}
                  {!l.prepared && (
                    <button className="delete-line" aria-label={`Hapus ${l.name}`} onClick={() => void update({ ...draft, lines: draft.lines.filter((x) => x.id !== l.id) })}><Trash2 size={16} /></button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      <div className="cart-footer">
        <div className="bill-row"><span>Subtotal</span><span>{rupiah(total.subtotal)}</span></div>
        {comp ? (
          <div className="bill-row"><span>{comp.kind === "staff" ? "Potongan staff meal" : "Compliment keluarga pemilik"}</span><span>−{rupiah(total.discount)}</span></div>
        ) : (
          <div className="bill-row">
            <button className="text-button" onClick={() => { setDiscountValue(String(draft.discount)); setDiscountReason(draft.discountReason); setDiscountDialog(true); }}>Tambah diskon</button>
            <span>−{rupiah(draft.discount)}</span>
          </div>
        )}
        {total.service > 0 && <div className="bill-row"><span>Layanan</span><span>{rupiah(total.service)}</span></div>}
        {total.tax > 0 && <div className="bill-row"><span>Pajak</span><span>{rupiah(total.tax)}</span></div>}
        <div className="bill-total"><strong>Total</strong><strong>{rupiah(total.total)}</strong></div>
        {invalid && <p className="error" role="alert">{invalid}</p>}
        {!shift ? (
          <Button className="full" onClick={() => setOpeningDialog(true)} disabled={!user.primary}><Wallet size={18} /> Buka sif untuk melayani</Button>
        ) : (
          <>
            <div className="cart-actions">
              <Button variant="secondary" disabled={busy || !count} onClick={() => void save()}><Save size={16} /> Simpan</Button>
              {tablets && <Button variant="secondary" disabled={busy || !count || draft.lines.every((l) => l.prepared)} onClick={() => void prepare()}><ChefHat size={16} /> Ke stasiun</Button>}
            </div>
            <Button className="full checkout-btn" disabled={busy || !count || (tablets && draft.lines.some((l) => !l.prepared && !l.cancelled))} onClick={() => void payStart()}>{comp && total.total === 0 ? "Simpan compliment" : "Lanjut pembayaran"} <ArrowRight size={18} /></Button>
            {comp && <p className="small muted center">{comp.kind === "staff" ? `${comp.who || "Staf"} membayar 50% makanan. Minuman gratis tapi tetap mengurangi stok dan masuk laporan compliment.` : "Tanpa pembayaran. Struk tercetak sebagai Compliment, stok tetap berkurang."}</p>}
            {tablets && count > 0 && draft.lines.some((l) => !l.prepared) && <p className="small muted center">Kirim ke stasiun sebelum menerima pembayaran.</p>}
            {!tablets && count > 0 && <p className="small muted center">Stok berkurang saat pembayaran dicatat.</p>}
          </>
        )}
        {draft.orderId && (
          <p className="center"><button className="text-button" disabled={busy} onClick={() => void newOrder()}>Mulai pesanan baru</button></p>
        )}
        <p className="save-status"><span className="status-dot" />{saving ? "Menyimpan…" : "Draf tersimpan di perangkat"}</p>
      </div>
    </>
  );
  return (
    <div className="pos-layout">
      <section className="menu-area">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Setiap gram tercatat</p>
            <h1>Kasir</h1>
            <p className="muted">Cari, pilih, kirim. Stok ikut sendiri.</p>
          </div>
          <span className={`badge ${shift ? "badge-green" : ""}`}><span className="status-dot" />{shift ? "Sif terbuka" : "Sif belum dibuka"}</span>
        </div>
        <div className="search-box">
          <Search size={20} />
          <input aria-label="Cari menu" placeholder="Cari nama, alias, atau tag… salah ketik tidak apa-apa" value={query} onChange={(e) => setQuery(e.target.value)} />
          <kbd>⌕</kbd>
        </div>
        <div className="category-tabs" aria-label="Jenis menu">
          {TYPES.map(([id, label]) => (
            <button key={id} className={type === id ? "active" : ""} onClick={() => setType(id)}>
              {label}{id === "all" && <span>{active.length}</span>}
            </button>
          ))}
        </div>
        <div className="section-label">
          <h2>{type === "all" ? "Semua menu" : typeLabel[type]}</h2>
          <span>{filtered.length} menu tersedia</span>
        </div>
        <div className="menu-grid">
          {hydrating
            ? [0, 1, 2, 3, 4, 5].map((i) => <div className="skeleton skeleton-card" key={i} role="status" aria-label="Memuat menu" />)
            : filtered.map((item, index) => {
                const a = canMake(item);
                return (
                  <button key={item.id} className="menu-card" disabled={a.soldOut || !user.primary} onClick={() => add(item)}>
                    <div className="menu-photo">
                      <img src={item.photo || "/menu-placeholder.svg"} alt="" loading="lazy" />
                      <span className="menu-number">{String(index + 1).padStart(2, "0")}</span>
                      {item.favorite && <Star size={16} className="favorite-star" />}
                      {a.soldOut && <span className="sold-out-label">{item.soldOut ? "Habis" : "Habis · bahan kurang"}</span>}
                      {!a.soldOut && a.low && <span className="low-label">Sisa {a.left}</span>}
                    </div>
                    <span className="menu-category">{typeLabel[menuType(item)]}{item.tags?.length ? ` · ${item.tags.join(", ")}` : ""}</span>
                    <h3>{item.name}</h3>
                    <div className="menu-card-bottom">
                      <strong>{rupiah(item.price)}</strong>
                      {/* "Left" is how many more can be made from stock on hand; the bar is left over twice the low mark. */}
                      {Number.isFinite(a.left) && (
                        <span className={`menu-level ${a.soldOut ? "empty" : a.low ? "low" : ""}`}>
                          <span className={`level ${a.soldOut ? "empty" : a.low ? "low" : ""}`}><i style={{ width: `${Math.min(100, Math.round((a.left / Math.max(1, (item.lowAt ?? settings?.lowAt ?? 5) * 2)) * 100))}%` }} /></span>
                          <small>{a.soldOut ? "Habis" : `${a.left} tersisa`}</small>
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
        </div>
        {!hydrating && !filtered.length && (
          <div className="empty-state">
            <Search size={32} />
            <h2>Menu belum ditemukan</h2>
            <p>Coba kata lain, alias, atau tag; atau tambahkan menu di Lainnya.</p>
          </div>
        )}
        <div className="menu-help"><NotebookPen size={17} /><span>Kartu abu-abu berarti bahannya habis; "Sisa N" berarti hanya N porsi lagi yang bisa dibuat.</span></div>
      </section>
      <aside className="desktop-cart">{cart}</aside>
      <button className="mobile-cart-summary" onClick={() => setCartOpen(true)}>
        <span className="mobile-cart-count">{count}</span>
        <span>Lihat pesanan<strong>{rupiah(total.total)}</strong></span>
        <ArrowRight size={22} />
      </button>
      <Dialog open={cartOpen} onOpenChange={setCartOpen} title="Keranjang pesanan" wide><div className="mobile-cart">{cart}</div></Dialog>
      <Dialog open={Boolean(selected)} onOpenChange={() => setSelected(undefined)} title={selected?.name || "Pilih menu"} description="Pilihan, tambahan, dan catatan untuk stasiun">
        {selected && (
          <>
            <img className="selected-menu-photo" src={selected.photo || "/menu-placeholder.svg"} alt="" />
            <p className="item-price">{rupiah(optionPrice)}</p>
            {groupsOf(selected).map((g) => (
              <fieldset className="option-group" key={g.id}>
                <legend>{g.name}{g.required && <small> · wajib pilih satu</small>}</legend>
                {choices(selected, g.id).map((m) => (
                  <label className="check-row" key={m.id}>
                    <input type={g.kind === "add" ? "checkbox" : "radio"} name={`opt-${g.id}`} checked={mods.includes(m.id)} onChange={() => toggle(selected, m, g.kind !== "add")} />
                    <span>{m.name}{describeDelta(m.recipe, stockItems) && <small className="muted"> · {describeDelta(m.recipe, stockItems)}</small>}</span>
                    <strong>{m.price ? `+${rupiah(m.price)}` : "—"}</strong>
                  </label>
                ))}
              </fieldset>
            ))}
            {loose(selected).length > 0 && (
              <div className="modifier-list">
                {loose(selected).map((m) => (
                  <label className="check-row" key={m.id}>
                    <input type="checkbox" checked={mods.includes(m.id)} onChange={() => toggle(selected, m, false)} />
                    <span>{m.name}{describeDelta(m.recipe, stockItems) && <small className="muted"> · {describeDelta(m.recipe, stockItems)}</small>}</span>
                    <strong>+{rupiah(m.price)}</strong>
                  </label>
                ))}
              </div>
            )}
            <label>
              Catatan persiapan
              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Contoh: tidak pedas, tanpa bawang" maxLength={300} />
            </label>
            <Button className="full btn-accent" onClick={() => void addLine(selected, mods, note)}>Tambah ke pesanan · {rupiah(optionPrice)} <Plus size={18} /></Button>
          </>
        )}
      </Dialog>
      <Dialog open={openingDialog} onOpenChange={setOpeningDialog} title="Buka sif" description={cashless ? "Tanpa tunai: periksa mesin EDC dan printer sebelum mulai." : "Hitung uang kembalian di laci sebelum mulai."}>
        {cashless ? <p className="callout">Pastikan EDC {edcs.join(", ")} menyala dan printer struk berisi kertas. Tidak ada modal kas.</p> : <label>Modal kas awal<Money value={opening} onChange={setOpening} /></label>}
        <p className="callout">Otorisasi berlaku maksimal 12 jam. Membuka sif memerlukan internet dan perangkat kasir utama.</p>
        <Button loading={busy} disabled={busy} className="full btn-accent" onClick={() => void act(async () => { await commands.openShift(cashless ? 0 : Number(opening)); setOpeningDialog(false); }, "Sif tersimpan")}>Buka sif sekarang</Button>
      </Dialog>
      <Dialog open={discountDialog} onOpenChange={setDiscountDialog} title="Diskon manajer" description={manager ? undefined : "Kasir memerlukan PIN manajer untuk memberi diskon."}>
        <label>Potongan<Money value={discountValue} onChange={setDiscountValue} /></label>
        <label>Alasan<input value={discountReason} onChange={(e) => setDiscountReason(e.target.value)} required /></label>
        <Button className="full" onClick={() => {
          const d = Number(discountValue);
          if (d < 0 || d > total.subtotal || !discountReason.trim()) { setError("Periksa jumlah dan alasan diskon"); return; }
          // Same rule as Commands.save: a cashier changing the saved order's discount needs a PIN.
          const was = orders.find((o) => o.id === draft.orderId)?.discount ?? 0;
          if (!manager && d !== was) { setAsk({ action: "discount", amount: d, what: `Diskon ${rupiah(d)} · ${discountReason.trim()}` }); return; }
          void update({ ...draft, discount: d, discountReason, discountApproval: undefined });
          setDiscountDialog(false);
        }}>Terapkan diskon</Button>
      </Dialog>
      <ApprovalDialog request={ask} onClose={() => setAsk(undefined)} onApproved={(discountApproval) => { setAsk(undefined); setDiscountDialog(false); void update({ ...draft, discount: discountApproval.amount!, discountReason, discountApproval }); }} />
      <Dialog open={Boolean(checkout)} onOpenChange={() => setCheckout(undefined)} title="Terima pembayaran" description={checkout?.label || "Pesanan tanpa label"}>
        {checkout && (
          <>
            <div className="payment-total"><span>Total tagihan</span><strong>{rupiah(checkout.totals.total)}</strong></div>
            <div className="segmented">
              {(cashless ? (["card", "qris"] as const) : (["cash", "qris", "card"] as const)).map((m) => (
                <button key={m} onClick={() => setMethod(m)} className={method === m ? "active" : ""}>{m === "cash" ? "Tunai" : m === "qris" ? <><QrCode size={16} /> QRIS</> : <><CreditCard size={16} /> Kartu</>}</button>
              ))}
            </div>
            {cashless ? (
              <>
                <span className="small muted" style={{ display: "block", marginTop: 14 }}>Mesin EDC</span>
                <div className="segmented">
                  {edcs.map((e) => <button key={e} onClick={() => setEdc(e)} className={edc === e ? "active" : ""}>EDC {e}</button>)}
                </div>
                <p className="callout">{method === "card" ? `Ketik ${rupiah(checkout.totals.total)} di EDC ${edc}, tamu tap atau masukkan kartu. Tekan Konfirmasi setelah EDC mencetak "Approved".` : `Di EDC ${edc} pilih QRIS, ketik ${rupiah(checkout.totals.total)} dan tunjukkan QR ke tamu. Tekan Konfirmasi setelah EDC mencetak "Paid".`}</p>
                <label>Kode approval di slip EDC (opsional)<input inputMode="numeric" maxLength={30} value={approvalCode} onChange={(e) => setApprovalCode(e.target.value)} placeholder="412093" /></label>
                <p className="small muted">Membantu menemukan pembayaran yang tertunda di EDC.</p>
                <p className="save-status"><Printer size={14} /> Struk tercetak saat Anda konfirmasi.</p>
              </>
            ) : method === "cash" ? (
              <>
                <label>Uang diterima<Money autoFocus value={received} onChange={setReceived} /></label>
                <div className="tender-options">
                  {[checkout.totals.total, 50000, 100000, 200000].map((n, i) => (
                    <button key={i} disabled={n < checkout.totals.total} onClick={() => setReceived(String(n))}>{i === 0 ? "Uang pas" : rupiah(n)}</button>
                  ))}
                </div>
                <div className="bill-total change-row"><span>Kembalian</span><strong>{rupiah(Math.max(0, Number(received) - checkout.totals.total))}</strong></div>
              </>
            ) : (
              <>
                <p className="callout">Pembayaran diverifikasi manual. Periksa transaksi berhasil pada aplikasi merchant / terminal kartu. Screenshot pelanggan bukan bukti penerimaan.</p>
                <label className="check-row"><input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />Saya sudah memeriksa penerimaan di akun merchant.</label>
              </>
            )}
            <Button className="full btn-accent" loading={busy} disabled={busy || (cashless ? !edc : method === "cash" ? Number(received) < checkout.totals.total : !verified)} onClick={() => void pay()}><Check size={18} /> {cashless ? `Konfirmasi: ${method === "qris" ? "QRIS " : ""}dibayar di EDC ${edc}` : "Catat pembayaran"}</Button>
          </>
        )}
      </Dialog>
      {receipt && <Receipt order={receipt} auto={cashless} onClose={() => setReceipt(undefined)} />}
    </div>
  );
}
