import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Link, Navigate, useNavigate } from "@tanstack/react-router";
import { can } from "../../domain/permissions";
import { Search, Info, Plus, Minus, ShoppingBag, ArrowRight, ChefHat, Save, Wallet, Ellipsis, Percent, FilePlus, Eraser, Check, Banknote, QrCode, Printer, ReceiptText, TriangleAlert, NotebookPen } from "lucide-react";
import { useApp } from "../../app/context";
import { ApprovalDialog, type ApprovalRequest } from "../../app/Approval";
import { Button } from "../../components/ui/button";
import { Money } from "../../components/ui/money";
import { Dialog } from "../../components/ui/dialog";
import { businessDay, complimentDiscount, discountFor, tills, describeDelta, itemStation, lineUse, menuType, nextPager, orderTotals, quantity, rupiah, search } from "../../domain/calculate";
import { team } from "../auth/Login";
import { menuPicture } from "../../lib/menu-photo";
import type { Compliment, Draft, Line, MenuItem, MenuType, Modifier, OptionGroup, Order } from "../../domain/types";
import { uid } from "../../lib/db";
import { Receipt } from "../orders/Receipt";
import { DiscountDialog, type DiscountPick } from "./DiscountDialog";
// POS-3: a new order is dine-in with the next pager number of the day; one tap switches to take away.
const fresh = (label: string): Draft => ({ id: "current", revision: 0, label, mode: "dinein", lines: [], discount: 0, discountReason: "" });
const auto = /^Pager \d+$/;
// A draft without the name of the window that wrote it.
const bare = ({ by: _, ...d }: Draft) => JSON.stringify(d);
const TYPES: [MenuType | "all", string][] = [["all", "Semua"], ["food", "Makanan"], ["beverage", "Minuman"], ["snack", "Camilan"]];
export default function Pos() {
  const { menu, hydrating, settings, db, commands, shift, act, busy, user, manager, setError, setNotice, orders, stockItems, canMake, outbox } = useApp();
  // This window's name on the drafts it writes (TILL-09): another window of the same till follows a draft that is not its own.
  const me = useRef(uid()).current;
  const refused = outbox.find((o) => o.state === "rejected");
  const saved = useLiveQuery(() => db.drafts.get("current"), [db]);
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Draft>(() => fresh("Pager 1"));
  const initialized = useRef(false);
  // STN-02: the cart as it is now. Every await in the send, new-order and pay flows folds its result into this, not into the copy the tap captured.
  const latest = useRef(draft);
  latest.current = draft;
  // TILL-01: whether Bayar is already working.
  const going = useRef(false);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<MenuType | "all">("all");
  const [cartOpen, setCartOpen] = useState(false);
  const [selected, setSelected] = useState<MenuItem>();
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [pick, setPick] = useState(1);
  const [mods, setMods] = useState<string[]>([]);
  const [checkout, setCheckout] = useState<Order>();
  const [receipt, setReceipt] = useState<Order>();
  const [method, setMethod] = useState<"cash" | "qris" | "card">("cash");
  const [edc, setEdc] = useState("");
  const [approvalCode, setApprovalCode] = useState("");
  const [received, setReceived] = useState("");
  const [verified, setVerified] = useState(false);
  // TILL-01: the pay sheet takes no confirmation for its first half second, so the second tap of a double tap on Bayar lands on a disabled button.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    if (!checkout) return;
    const t = setTimeout(() => setArmed(true), 500);
    return () => clearTimeout(t);
  }, [checkout]);
  const [discountDialog, setDiscountDialog] = useState(false);
  // A discount waiting for a manager's PIN: what the cashier picked in the discount dialog.
  const [pending, setPending] = useState<DiscountPick>();
  const [ask, setAsk] = useState<ApprovalRequest>();
  const [moreOpen, setMoreOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  // The order menu closes on any tap outside it, like a native menu.
  useEffect(() => {
    if (!moreOpen) return;
    const away = (e: PointerEvent) => { if (!(e.target as Element).closest?.(".cart-more")) setMoreOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [moreOpen]);
  if (!can(user.role, "sell")) return <Navigate to="/station" />;
  const tablets = Boolean(settings?.stationTablets);
  // The store's payment paths: cash (a float and a drawer), EDC machines for card and QRIS, or both.
  // With an EDC the receipt prints by itself (pilot PRD: no print switch).
  const { cash, edcs, edc: edcMode } = tills(settings);
  const viaEdc = method !== "cash" && edcMode;
  // One device per store sells (kasir utama): receipts and shifts never clash. Any other device says why it cannot.
  const notTill = !user.primary && !user.demo;
  const pairedAs = user.mode === "office" ? "back office (laptop)" : user.mode === "station" ? "stasiun dapur/bar" : "belum dipasangkan";
  // Figma C2c/C2d: who the compliment is for, as pills. Staff meals list the team; the owner's family lists the
  // owners, the family names set under Lainnya → Restoran, and a family guest. "Lainnya" (or an empty team) types the name.
  const people = team();
  const staff = people.filter((m) => m.role !== "owner").map((m) => m.name);
  const family = [...new Set([...people.filter((m) => m.role === "owner").map((m) => m.name), ...(settings?.family ?? []), "Tamu keluarga"])];
  const today = businessDay(new Date().toISOString(), settings?.timezone, settings?.cutoff);
  // QA PERF-5: a business day began less than 36 h ago; a string compare drops the older orders before the zone arithmetic (a tap re-rendered all 500).
  const since = new Date(Date.now() - 36 * 36e5).toISOString();
  const pager = `Pager ${nextPager(orders.filter((o) => o.createdAt >= since && businessDay(o.createdAt, settings?.timezone, settings?.cutoff) === today).map((o) => o.label))}`;
  useEffect(() => {
    if (!initialized.current && saved !== undefined) {
      setDraft(saved);
      initialized.current = true;
    }
  }, [saved]);
  // TILL-09, STN-09, SYNC-15: one till, one cart. A draft another window of this till wrote replaces this window's copy, so
  // neither sells the same cart twice, drops the other's lines or hands out the same pager number. A deleted draft
  // (the other window saved the cart) is not followed: its saved order arrives as the next draft.
  useEffect(() => {
    if (!initialized.current || !saved || saved.by === me) return;
    if (bare(saved) !== bare(draft)) setDraft(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // A saved order voided or paid elsewhere (from Pesanan, or on another device) has nothing left to edit or pay:
  // the cart lets go of it instead of failing with "Pesanan sudah berubah" on every try.
  const gone = orders.find((o) => o.id === draft.orderId && o.status !== "open");
  useEffect(() => {
    if (initialized.current && gone) {
      // STN-09: lines added here after the other window paid or voided the order are not lost: they become a new cart.
      const kept = draft.lines.filter((l) => !l.cancelled && !gone.lines.some((x) => x.id === l.id));
      void update(kept.length ? { ...fresh(pager), lines: kept } : fresh(pager));
      if (kept.length) setNotice(`Pesanan itu sudah ${gone.status === "void" ? "dibatalkan" : "dibayar"} dari jendela lain. Tambahan ${kept.length} menu dipindah ke pesanan baru.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gone?.id, gone?.status]);
  // A line's menu type, for compliments and discounts that cover one type (Commands.save reads it the same way): the type
  // of the version it was rung up from, or for an older line the item's current one.
  const lineType = (l: Line): MenuType => { const m = menu.find((x) => x.id === l.itemId); return l.type ?? (m ? menuType(m) : l.station === "bar" ? "beverage" : "food"); };
  // Figma Cashier 2: a saved discount goes on in one tap. A manual one, a saved one the manager marked, or taking the discount
  // off an order already saved needs a manager's PIN from a cashier (Commands.save asks the same).
  function pickDiscount(p: DiscountPick) {
    const was = orders.find((o) => o.id === draft.orderId);
    const needs = p.discountId ? Boolean(settings?.discounts?.find((d) => d.id === p.discountId)?.approval) && p.discountId !== was?.discountId : Boolean(p.rule) || p.discount !== (was?.discount ?? 0);
    if (!manager && needs) { setPending(p); setAsk({ action: "discount", amount: p.discount, what: `Diskon ${rupiah(p.discount)} · ${p.reason}` }); return; }
    void update({ ...draft, discountId: p.discountId, discountRule: p.rule, discount: p.discount, discountReason: p.reason, discountApproval: undefined });
    setDiscountDialog(false);
  }
  async function update(next: Draft) {
    // A discount belongs to the order it was given for: once a new cart is emptied, drop it so it
    // cannot slide onto the next customer's order.
    if (!next.orderId && !next.lines.length) next = { ...next, discount: 0, discountReason: "", discountApproval: undefined, discountId: undefined, discountRule: undefined };
    // A saved discount follows the cart by its own rule, priced the same way Commands.save and the server price it. One
    // deleted meanwhile comes off a new cart; a saved order keeps it until the cashier picks another or takes it off
    // (Commands.save says so), since taking it off a saved order needs a reason and, from a cashier, a manager's PIN.
    // A manual discount follows the cart by its rule the same way (TILL-02).
    if (next.discountId) {
      const saved = settings?.discounts?.find((d) => d.id === next.discountId);
      next = saved ? { ...next, discount: discountFor(saved, next.lines, lineType), discountReason: saved.name } : next.orderId ? next : { ...next, discountId: undefined, discount: 0, discountReason: "" };
    } else if (next.discountRule) next = { ...next, discount: discountFor({ ...next.discountRule, id: "", name: "", note: "", from: "", to: "" }, next.lines, lineType) };
    // The manager's approval covers the discount up to its amount, under the same rule or saved discount, and a rupiah
    // rule only while the cart does not shrink (Commands.save and the server say the same): past that, ask again now
    // rather than fail at Ke stasiun or Bayar (DSC-2, TILL-05).
    if (!manager && next.discount > 0 && (next.discountRule || (next.discountId && settings?.discounts?.find((d) => d.id === next.discountId)?.approval))) {
      const was = orders.find((o) => o.id === next.orderId), same = was && (next.discountId ? was.discountId === next.discountId : JSON.stringify(was.discountRule) === JSON.stringify(next.discountRule));
      const covers = next.discountApproval?.amount ?? (same ? was.discountApproved ?? (was.discountApprovedBy ? Infinity : undefined) : undefined);
      const shrunk = next.discountRule?.kind === "amount" && orderTotals({ lines: next.lines, discount: 0, mode: "dinein" }, { taxBps: 0, serviceBps: 0 }).subtotal < orderTotals({ lines: draft.lines, discount: 0, mode: "dinein" }, { taxBps: 0, serviceBps: 0 }).subtotal;
      if (covers !== undefined && (next.discount > covers || shrunk)) {
        next = { ...next, discountApproval: undefined };
        setPending({ discountId: next.discountId, rule: next.discountRule, discount: next.discount, reason: next.discountReason });
        setAsk({ action: "discount", amount: next.discount, what: `Diskon ${rupiah(next.discount)} · ${next.discountReason}` });
      }
    }
    // State first, storage second: a quick second tap or keystroke must see this draft, not the
    // one from before IndexedDB answered.
    next = { ...next, by: me };
    latest.current = next;
    setDraft(next);
    try {
      await db.drafts.put(next);
    } catch {
      setError("Draf gagal disimpan. Penyimpanan perangkat penuh atau tidak tersedia. Ekspor data di Lainnya.");
    }
  }
  // What the order holds after a send, folded into the cart as it is now: sent lines come from the order, lines the cashier
  // changed or added meanwhile stay as they are (STN-02).
  const merge = (o: Order): Draft => {
    const now = latest.current, mine = new Map(now.lines.map((l) => [l.id, l]));
    return { ...now, orderId: o.id, revision: o.revision, lines: [...o.lines.flatMap((l) => (l.prepared || l.cancelled ? [l] : mine.has(l.id) ? [mine.get(l.id)!] : [])), ...now.lines.filter((l) => !o.lines.some((x) => x.id === l.id))], discountApproval: undefined };
  };
  // Lines tapped while the order was being closed out belong to the next order.
  const rest = (o: Order) => latest.current.lines.filter((l) => !l.cancelled && !o.lines.some((x) => x.id === l.id));
  const following = (o: Order) => { const kept = rest(o); return kept.length ? { ...fresh(pager), lines: kept } : fresh(pager); };
  // TILL-08: the cart is what the saved order already holds, so paying it needs no save (a save after the 12-hour limit is refused, cash is not).
  const unchanged = (d: Draft, o: Order) =>
    d.revision === o.revision && d.mode === o.mode && d.label === o.label && (d.name?.trim() ?? "") === (o.name ?? "") && d.discount === o.discount && d.discountReason === o.discountReason && d.discountId === o.discountId
    && JSON.stringify([d.discountRule?.kind, d.discountRule?.value, d.discountRule?.scope, d.discountRule?.items]) === JSON.stringify([o.discountRule?.kind, o.discountRule?.value, o.discountRule?.scope, o.discountRule?.items])
    && JSON.stringify([d.compliment?.kind, d.compliment?.who.trim()]) === JSON.stringify([o.compliment?.kind, o.compliment?.who])
    && d.lines.length === o.lines.length && d.lines.every((l) => { const x = o.lines.find((y) => y.id === l.id); return x && x.qty === l.qty && x.note === l.note && x.prepared === l.prepared && x.cancelled === l.cancelled && x.modifiers.map((m) => m.id).join() === l.modifiers.map((m) => m.id).join(); });
  const comp = draft.mode === "compliment" ? draft.compliment : undefined;
  const saved_ = orders.find((o) => o.id === draft.orderId);
  const clock = (iso: string) => new Date(iso).toLocaleTimeString("id-ID", { timeZone: settings?.timezone, hour: "2-digit", minute: "2-digit" });
  const drink = (l: Line) => lineType(l) === "beverage";
  const setCompliment = (c: Compliment) => void update({ ...draft, mode: "compliment", compliment: c });
  const names = comp?.kind === "staff" ? staff : family;
  const other = Boolean(comp) && (typing || !names.length || (comp!.who !== "" && !names.includes(comp!.who)));
  const lineValue = (l: Line) => (l.price + l.modifiers.reduce((n, m) => n + m.price, 0)) * l.qty;
  // What the line costs under the compliment rule (the order total stays the authority): free, or food at half.
  const compPrice = (l: Line) => (comp?.kind === "family" || drink(l) ? 0 : lineValue(l) - Math.floor(lineValue(l) / 2));
  // Figma C2: options read as one phrase, "Large +Rp5.000, oat milk +Rp5.000, less sugar".
  const options = (l: Line) => l.modifiers.map((m, i) => { const n = i && /^[A-Z][a-z]/.test(m.name) ? m.name[0].toLowerCase() + m.name.slice(1) : m.name; return m.price ? `${n} +${rupiah(m.price)}` : n; }).join(", ");
  // Figma C4: "Pager 12, Indra, makan di sini, 4 item. Ziggy Lounge tanpa tunai."
  const payNote = (o: Order) => `${[/^\d+$/.test(o.label) ? `Pager ${o.label}` : o.label, o.compliment?.who ?? o.name, o.mode === "dinein" ? "makan di sini" : o.mode === "takeaway" ? "bungkus" : "compliment", `${o.lines.filter((l) => !l.cancelled).reduce((n, l) => n + l.qty, 0)} item`].filter(Boolean).join(", ")}.${cash ? "" : ` ${settings?.name || "Toko ini"} tanpa tunai.`}`;
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
      // menu/F4: a paid add-on never starts ticked, whatever "default" a menu saved while its group was "pilih satu" still carries.
      setMods(groupsOf(item).flatMap((g) => { const c = choices(item, g.id); const d = g.kind === "add" ? undefined : c.find((m) => m.default) ?? (g.required ? c[0] : undefined); return d ? [d.id] : []; }));
      setNote("");
      setNoteOpen(false);
      setPick(1);
      return;
    }
    void addLine(item, [], "");
  }
  async function addLine(item: MenuItem, ids: string[], notes: string, n = 1) {
    // A group's base choice (Regular, Susu segar, Normal) changes nothing and stays off the ticket; a free option the cashier
    // picked on purpose (a kitchen instruction such as "Tidak pedas") stays on the line, the ticket and the receipt (STN-07).
    const base = (m: Modifier) => { const g = groupsOf(item).find((x) => x.id === m.group); const c = g ? choices(item, g.id) : []; return Boolean(g) && g!.kind !== "add" && m === (c.find((x) => x.default) ?? (g!.required ? c[0] : undefined)); };
    const picked = item.modifiers.filter((m) => ids.includes(m.id) && (m.price || m.recipe.length || !base(m)));
    // The same item with the same options and note, not yet sent, is one line with a higher quantity.
    const key = (ms: Modifier[]) => ms.map((m) => m.id).sort().join("|");
    const cur = latest.current;
    const same = cur.lines.find((l) => !l.prepared && !l.cancelled && l.itemId === item.id && l.catalogVersion === item.version && l.note === notes && key(l.modifiers) === key(picked) && l.qty < 999);
    if (!same && cur.lines.length >= 200) { setError("Maksimal 200 menu per pesanan"); setSelected(undefined); return; }
    if (same) await update({ ...cur, lines: cur.lines.map((l) => (l === same ? { ...l, qty: Math.min(999, l.qty + n) } : l)) });
    else {
      const line: Line = { id: uid(), itemId: item.id, name: item.name, price: item.price, qty: n, modifiers: picked, note: notes, recipe: item.recipe, catalogVersion: item.version, prepared: false, cancelled: false, station: itemStation(item), type: menuType(item) };
      await update({ ...cur, lines: [...cur.lines, line] });
    }
    setSelected(undefined);
  }
  async function save() {
    // The revision this cart was made from, not the latest local one (TILL-09, STN-09): a copy another window already moved on
    // is refused ("Pesanan sudah berubah") instead of replacing the other window's lines.
    // A window that has not caught up with the stored cart does not save its older copy over it.
    const stored = await db.drafts.get("current");
    if (stored && stored.by !== me && bare(stored) !== bare(draft)) {
      setDraft(stored);
      setError("Keranjang baru diubah dari jendela lain. Periksa isinya, lalu coba lagi.");
      return;
    }
    // Commands.save drops the stored cart and update() writes it back from the saved order: the message waits for that, so a
    // reload right after it finds the cart (it is not only a race for a fast test: the write queues behind other storage work).
    const o = await act(async () => { const o = await commands.save(draft); await update(merge(o)); return o; }, "Pesanan tersimpan di perangkat");
    // The approval went out with this save and the server accepts it once.
    if (o) return o;
  }
  async function prepare() {
    const o = await save();
    if (o) {
      const p = await act(() => commands.prepare(o.id), "Pesanan dikirim ke stasiun");
      if (p) await update(merge(p));
    }
  }
  async function newOrder() {
    // The saved order stays in Pesanan. Save edits first so nothing typed is lost, unless there is
    // nothing savable: an emptied cart (an order needs a line), or an order no longer open because
    // it was voided from Pesanan, where saving can only fail and would trap the cart.
    const open = orders.some((o) => o.id === draft.orderId && o.status === "open");
    if (!count || !open) await update(fresh(pager));
    else {
      const o = await save();
      if (o) await update(following(o));
    }
  }
  // Pilot: without bar and kitchen tablets the cashier tells them; stock moves when the order is paid, so the
  // lines go out together with the payment (Commands.pay, send), not when the sheet opens: closing the sheet leaves the cart editable.
  async function payStart() {
    if (going.current) return;
    going.current = true;
    try {
      const was = orders.find((o) => o.id === draft.orderId && o.status === "open");
      const o = was && unchanged(draft, was) ? was : await save();
      if (o) {
        setCartOpen(false);
        // A free compliment (owner's family) has nothing to pay: record it and print the receipt.
        if (o.mode === "compliment" && o.totals.total === 0) {
          const done = await act(() => commands.pay(o.id, "none", 0, true, { send: !tablets }), "Compliment tersimpan");
          if (done) { await update(following(done)); setReceipt(done); }
          return;
        }
        setCheckout(o);
        setReceived(String(o.totals.total));
        setMethod(cash ? "cash" : "card");
        setEdc(edcs[0] ?? "");
        setApprovalCode("");
        setVerified(edcMode);
      }
    } finally {
      going.current = false;
    }
  }
  async function pay() {
    // TILL-01: the tap that opened this sheet, or its double, is not a confirmation.
    if (!checkout || !armed) return;
    const paid = await act(() => commands.pay(checkout.id, method, Number(received), verified, { edc: viaEdc ? edc : undefined, approvalCode: viaEdc ? approvalCode : undefined, send: !tablets }), "Pembayaran tersimpan di perangkat");
    if (paid) {
      setCheckout(undefined);
      await update(following(paid));
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
          <h2>{draft.orderId ? "Pesanan tersimpan" : "Pesanan baru"}</h2>
          <span className="muted small">{saved_ ? `#${saved_.receiptId.slice(-6).toUpperCase()}, ${saved_.cashier}, ${clock(saved_.createdAt)}` : `${user.name}, ${clock(new Date().toISOString())}`}</span>
        </div>
        {/* Figma C2: the footer carries only the bill and one pay button; keeping a tab open, a manager's discount
            and starting the next order live behind this menu. */}
        <div className="cart-more" onKeyDown={(e) => { if (e.key === "Escape") setMoreOpen(false); }}>
          {/* Reviewer, 17 Nov: the discount gets its own entry point on the order, not only behind the menu. */}
          {!comp && <button className="cart-discount" aria-label="Diskon" aria-pressed={draft.discount > 0} onClick={() => setDiscountDialog(true)}><Percent size={18} /></button>}
          <button className="cart-glyph" aria-label="Opsi pesanan" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}><Ellipsis size={20} /></button>
          {moreOpen && (
            <div className="cart-menu">
              <button disabled={busy || !count || !shift} onClick={() => { setMoreOpen(false); void save(); }}><Save size={16} /> Simpan pesanan</button>
              {!comp && <button onClick={() => { setMoreOpen(false); setDiscountDialog(true); }}><Percent size={16} /> Diskon</button>}
              {draft.orderId && <button disabled={busy} onClick={() => { setMoreOpen(false); void newOrder(); }}><FilePlus size={16} /> Mulai pesanan baru</button>}
              {/* A new order not saved yet is only a draft: empty it in one go, with the next free pager. */}
              {!draft.orderId && count > 0 && <button onClick={() => { setMoreOpen(false); void update(fresh(pager)); }}><Eraser size={16} /> Kosongkan pesanan</button>}
            </div>
          )}
        </div>
      </div>
      <div className="cart-body">
        <div className="segmented mode-switch">
          <button className={draft.mode === "dinein" ? "active" : ""} aria-pressed={draft.mode === "dinein"} onClick={() => void update({ ...draft, mode: "dinein", compliment: undefined })}>Makan di sini</button>
          <button className={draft.mode === "takeaway" ? "active" : ""} aria-pressed={draft.mode === "takeaway"} onClick={() => void update({ ...draft, mode: "takeaway", compliment: undefined })}>Bungkus</button>
          <button className={draft.mode === "compliment" ? "active" : ""} aria-pressed={draft.mode === "compliment"} onClick={() => { setTyping(false); setCompliment(draft.compliment ?? { kind: "staff", who: "" }); }}>Compliment</button>
        </div>
        {comp && (
          <div className="compliment-panel">
            <span className="comp-label">Compliment untuk</span>
            <div className="choice-cards">
              <button className={comp.kind === "staff" ? "active" : ""} aria-pressed={comp.kind === "staff"} onClick={() => setCompliment({ ...comp, kind: "staff" })}><strong>Staff meal</strong><small>Minum gratis, makan 50%</small></button>
              <button className={comp.kind === "family" ? "active" : ""} aria-pressed={comp.kind === "family"} onClick={() => setCompliment({ ...comp, kind: "family" })}><strong>Keluarga pemilik</strong><small>Semua gratis</small></button>
            </div>
            <span className="comp-label">{comp.kind === "staff" ? "Siapa yang makan?" : "Untuk siapa?"}</span>
            {names.length > 0 && (
              <div className="person-pills" role="group" aria-label={comp.kind === "staff" ? "Siapa yang makan?" : "Untuk siapa?"}>
                {names.map((n) => <button key={n} className={comp.who === n && !typing ? "on" : ""} aria-pressed={comp.who === n && !typing} onClick={() => { setTyping(false); setCompliment({ ...comp, who: n }); }}>{n}</button>)}
                <button className={other ? "on" : ""} aria-pressed={other} onClick={() => { setTyping(true); setCompliment({ ...comp, who: names.includes(comp.who) ? "" : comp.who }); }}>Lainnya</button>
              </div>
            )}
            {other && <input className="comp-who" aria-label="Nama penerima compliment" autoFocus={typing} placeholder={comp.kind === "staff" ? "Nama staf" : "Nama keluarga"} maxLength={60} value={comp.who} onChange={(e) => setCompliment({ ...comp, who: e.target.value })} />}
          </div>
        )}
        {/* Figma C2: the pager the guest takes, and their name if they give one, side by side. A compliment (C2c/C2d)
            names its person above instead and keeps the pager it has. The field is labelled Pager, so it shows "12"
            while the order keeps "Pager 12" for tickets, receipts and the day's pager count; a table stays as typed. */}
        {!comp && <div className="order-who">
          <label className="table-label">
            Pager
            <input aria-label="Nomor pager / meja" placeholder="12" maxLength={100} value={draft.label.replace(/^Pager (?=\d+$)/, "")} onChange={(e) => { const label = /^\d+$/.test(e.target.value) ? `Pager ${e.target.value}` : e.target.value; if (label.length <= 100) void update({ ...draft, label }); }} />
          </label>
          <label className="table-label">
            Nama (opsional)
            <input placeholder="Nama tamu" maxLength={60} value={draft.name ?? ""} onChange={(e) => void update({ ...draft, name: e.target.value })} />
          </label>
        </div>}
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
                  <span>{comp ? (compPrice(l) ? rupiah(compPrice(l)) : "Gratis") : rupiah(lineValue(l))}</span>
                </div>
                {l.modifiers.length > 0 && <p className="line-options">{options(l)}</p>}
                {comp && <p className="line-options">{comp.kind === "family" ? "Keluarga pemilik: gratis" : drink(l) ? "Minuman staf: gratis" : "Makanan staf: 50%"}</p>}
                {l.note && <p className="line-note">{l.note}</p>}
                <div className="line-bottom">
                  {/* The station badge tells the cashier where the line is made, even before it is sent. */}
                  {!l.prepared && <span className={`badge badge-${l.station ?? itemStation(menu.find((m) => m.id === l.itemId) ?? { category: "" })}`}>{(l.station ?? itemStation(menu.find((m) => m.id === l.itemId) ?? { category: "" })) === "bar" ? "Bar" : "Dapur"}</span>}
                  {l.prepared ? (
                    <span className={`badge badge-${l.station ?? "kitchen"}`}><ChefHat size={13} /> Dikirim · {(l.station ?? "kitchen") === "bar" ? "bar" : "dapur"} · {l.qty}×</span>
                  ) : (
                    <div className="quantity-control">
                      <button aria-label={`${l.qty > 1 ? "Kurangi" : "Hapus"} ${l.name}`} onClick={() => void update({ ...draft, lines: draft.lines.flatMap((x) => (x.id !== l.id ? [x] : x.qty > 1 ? [{ ...x, qty: x.qty - 1 }] : [])) })}><Minus size={20} strokeWidth={1.6} /></button>
                      <span>{l.qty}</span>
                      <button aria-label={`Tambah ${l.name}`} disabled={l.qty >= 999} onClick={() => void update({ ...draft, lines: draft.lines.map((x) => (x.id === l.id ? { ...x, qty: x.qty + 1 } : x)) })}><Plus size={20} strokeWidth={1.6} /></button>
                    </div>
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
          <div className="bill-row"><span>{comp.kind === "staff" ? "Diskon staff meal" : "Compliment keluarga pemilik"}</span><span>−{rupiah(total.discount)}</span></div>
        ) : draft.discount > 0 && (
          <div className="bill-row"><span>Diskon · {draft.discountReason}</span><span>−{rupiah(draft.discount)}</span></div>
        )}
        {total.service > 0 && <div className="bill-row"><span>Layanan {((settings?.serviceBps ?? 0) / 100).toLocaleString("id-ID")}%</span><span>{rupiah(total.service)}</span></div>}
        {total.tax > 0 && <div className="bill-row"><span>Pajak {((settings?.taxBps ?? 0) / 100).toLocaleString("id-ID")}%</span><span>{rupiah(total.tax)}</span></div>}
        <div className="bill-total"><strong>Total</strong><strong>{rupiah(total.total)}</strong></div>
        {invalid && <p className="error" role="alert">{invalid}</p>}
        {!shift ? (
          notTill ? (
            <p className="callout small"><span>Penjualan hanya di perangkat kasir utama. <Link to="/settings" className="text-button">Atur di Lainnya</Link></span></p>
          ) : (
            <Button className="full" onClick={() => navigate({ to: "/sif/buka" })} disabled={!user.primary}><Wallet size={18} /> Buka sif untuk melayani</Button>
          )
        ) : (
          <>
            {tablets && <Button variant="secondary" className="full station-btn" disabled={busy || !count || draft.lines.every((l) => l.prepared)} onClick={() => prepare()}><ChefHat size={16} /> Ke stasiun</Button>}
            <Button className="full checkout-btn" disabled={busy || !count || (tablets && draft.lines.some((l) => !l.prepared && !l.cancelled))} onClick={() => payStart()}>{comp && total.total === 0 ? "Simpan compliment" : `Bayar ${rupiah(total.total)}`}</Button>
            {comp && <p className="small muted center">{comp.kind === "staff" ? `${comp.who || "Staf"} bayar 50% untuk makanan. Minuman gratis tapi tetap mengurangi stok dan masuk laporan compliment.` : "Tanpa pembayaran. Struk tercetak sebagai Compliment, stok tetap berkurang."}</p>}
            {tablets && count > 0 && draft.lines.some((l) => !l.prepared) && <p className="small muted center">Kirim ke stasiun sebelum menerima pembayaran.</p>}
            {!tablets && !comp && <p className="small muted center">Beri tahu bar dan dapur apa yang dibuat. Stok berkurang saat pesanan dibayar.</p>}
          </>
        )}
      </div>
    </>
  );
  return (
    <div className="pos-layout">
      <section className="menu-area">
        {/* Figma C2 opens on the search: the heading and shift state stay for screen readers only. */}
        <div className="page-heading sr-only">
          <div>
            <p className="eyebrow">Setiap gram tercatat</p>
            <h1>Kasir</h1>
            <p className="muted">Cari, pilih, kirim. Stok ikut sendiri.</p>
          </div>
          <span className={`badge ${shift ? "badge-green" : ""}`}><span className="status-dot" />{shift ? "Sif terbuka" : "Sif belum dibuka"}</span>
        </div>
        {refused && !user.demo && (
          <p className="callout" role="alert">
            <Info size={17} />
            <span>Server menolak satu operasi ({refused.error || refused.kind}). Penjualan tetap tercatat di tablet ini, tetapi belum sampai ke server sampai operasi itu dibuang. Buka <Link to="/settings" className="text-button">Lainnya → Sinkron &amp; backup</Link>.</span>
          </p>
        )}
        {notTill && (
          <p className="callout till-only" role="status">
            <Info size={17} />
            <span>Perangkat ini dipasangkan sebagai <strong>{pairedAs}</strong>, jadi menu hanya bisa dilihat. Penjualan berjalan di satu perangkat kasir utama per toko. Untuk berjualan di sini, pemilik membuka <Link to="/settings" className="text-button">Lainnya → Printer &amp; perangkat</Link> lalu memilih "Jadikan perangkat ini kasir utama".</span>
          </p>
        )}
        <div className="search-box">
          <Search size={20} />
          <input aria-label="Cari menu" placeholder="Cari menu, mis. americano" value={query} onChange={(e) => setQuery(e.target.value)} />
          <kbd>⌕</kbd>
        </div>
        <div className="category-tabs" aria-label="Jenis menu">
          {TYPES.map(([id, label]) => (
            <button key={id} className={type === id ? "active" : ""} aria-pressed={type === id} onClick={() => setType(id)}>
              {label}<span>{id === "all" ? active.length : active.filter((m) => menuType(m) === id).length}</span>
            </button>
          ))}
        </div>
        
        <div className="menu-grid">
          {hydrating
            ? [0, 1, 2, 3, 4, 5].map((i) => <div className="skeleton skeleton-card" key={i} role="status" aria-label="Memuat menu" />)
            : filtered.map((item) => {
                const a = canMake(item);
                return (
                  <button key={item.id} className={`menu-card ${notTill && !a.soldOut ? "view-only" : ""}`} disabled={a.soldOut || !user.primary} onClick={() => add(item)}>
                    <div className="menu-photo">
                      <img src={menuPicture(item)} alt="" loading="lazy" />
                      {a.soldOut && <span className="sold-out-label">Habis</span>}
                      {!a.soldOut && a.low && <span className="low-label">Hampir habis</span>}
                    </div>
                    <h3>{item.name}</h3>
                    <div className="menu-card-bottom">
                      <strong>{rupiah(item.price)}</strong>
                      {/* "Left" is how many more can be made from stock on hand; the bar is left over twice the low mark. */}
                      {Number.isFinite(a.left) && (
                        <span className={`menu-level ${a.soldOut ? "empty" : a.low ? "low" : ""}`}>
                          <span className={`level ${a.soldOut ? "empty" : a.low ? "low" : ""}`}><i style={{ width: `${Math.min(100, Math.round((a.left / Math.max(1, (item.lowAt ?? settings?.lowAt ?? 5) * 2)) * 100))}%` }} /></span>
                          <small>{a.soldOut ? (item.soldOut ? "Habis" : "Bahan habis") : `${a.left} tersisa`}</small>
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
        
      </section>
      <aside className="desktop-cart">{cart}</aside>
      <button className="mobile-cart-summary" onClick={() => setCartOpen(true)}>
        <span className="mobile-cart-count">{count}</span>
        <span>Lihat pesanan<strong>{rupiah(total.total)}</strong></span>
        <ArrowRight size={22} />
      </button>
      <Dialog open={cartOpen} onOpenChange={setCartOpen} title="Keranjang pesanan" wide><div className="mobile-cart">{cart}</div></Dialog>
      {/* Figma C3: the photo and what it costs, where it is made and how many are left; options as pills; what the
          chosen cup takes from stock; how many, then add. */}
      <Dialog open={Boolean(selected)} onOpenChange={() => setSelected(undefined)} className="item-dialog" title={selected?.name || "Pilih menu"} media={selected && <img className="item-thumb" src={menuPicture(selected)} alt="" />}
        description={selected ? [rupiah(selected.price), itemStation(selected) === "bar" ? "Bar" : "Dapur", (() => { const a = canMake(selected); return a.left === Infinity ? "" : a.soldOut ? "habis" : `sisa ${a.left} hari ini`; })()].filter(Boolean).join(", ") : undefined}>
        {selected && (() => {
          const chosen = selected.modifiers.filter((m) => mods.includes(m.id));
          const uses = lineUse({ recipe: selected.recipe, modifiers: chosen, qty: 1 }).flatMap((r) => { const s = stockItems.find((x) => x.id === r.stockId); return s ? [`${quantity(r.qty)}${s.unit === "pcs" ? "" : ` ${s.unit}`} ${s.name.toLowerCase()}`] : []; });
          const hint: Record<string, string> = { size: "Wajib", swap: "Mengganti bahan di resep", level: "Mengurangi bahan di resep", add: "Opsional" };
          // Figma C3 explains a swap or a level beside its name ("Swaps the milk in the recipe"): here, what the chosen
          // option does to the recipe ("ganti Susu segar → Susu oat"). Sizes and extras show in the sentence below.
          const effect = (g: OptionGroup) => (g.kind === "swap" || g.kind === "level" ? choices(selected, g.id).filter((m) => mods.includes(m.id)).map((m) => describeDelta(m.recipe, stockItems)).filter(Boolean).join(", ") : "");
          const pill = (m: Modifier, single: boolean, group?: string) => (
            <label className={`opt-pill ${mods.includes(m.id) ? "on" : ""}`} key={m.id}>
              <input type={single ? "radio" : "checkbox"} name={group ? `opt-${group}` : undefined} checked={mods.includes(m.id)} onChange={() => toggle(selected, m, single)} />
              {m.name}{m.price > 0 && <small>+{rupiah(m.price)}</small>}
            </label>
          );
          // The options scroll between the heading and the footer, so "Tambah ke pesanan" stays on screen. A prep note
          // is not on the Figma: it opens from the footer and then stays.
          return <>
            <div className="item-options">
              {groupsOf(selected).map((g) => (
                <fieldset className="option-group" key={g.id}>
                  <legend>{g.name}<small>{effect(g) || (g.required && g.kind === "size" ? "Wajib" : hint[g.kind] ?? (g.required ? "Wajib" : "Opsional"))}</small></legend>
                  <div className="opt-pills">{choices(selected, g.id).map((m) => pill(m, g.kind !== "add", g.id))}</div>
                </fieldset>
              ))}
              {loose(selected).length > 0 && (
                <fieldset className="option-group"><legend>Tambahan<small>Opsional</small></legend><div className="opt-pills">{loose(selected).map((m) => pill(m, false))}</div></fieldset>
              )}
              {uses.length > 0 && <p className="recipe-note"><ReceiptText size={20} /><span>{menuType(selected) === "beverage" ? "Minuman ini" : "Menu ini"} memakai {uses.length > 1 ? `${uses.slice(0, -1).join(", ")} dan ${uses.at(-1)}` : uses[0]}.</span></p>}
              {noteOpen && <label className="note-field">Catatan persiapan<input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="Contoh: tidak pedas, tanpa bawang" maxLength={300} /></label>}
            </div>
            <div className="option-footer">
              <div className="qty-stepper"><button type="button" aria-label="Kurangi jumlah" disabled={pick <= 1} onClick={() => setPick(pick - 1)}><Minus size={20} strokeWidth={1.6} /></button><span aria-live="polite">{pick}</span><button type="button" className="plus" aria-label="Tambah jumlah" disabled={pick >= 99} onClick={() => setPick(pick + 1)}><Plus size={20} strokeWidth={1.6} /></button></div>
              <Button className="btn-accent" onClick={() => addLine(selected, mods, note, pick)}>Tambah ke pesanan, {rupiah(optionPrice * pick)}</Button>
              {!noteOpen && <Button variant="ghost" className="note-toggle" onClick={() => setNoteOpen(true)}><NotebookPen size={18} /> Tambah catatan</Button>}
            </div>
          </>;
        })()}
      </Dialog>
      {discountDialog && <DiscountDialog open onClose={() => setDiscountDialog(false)} draft={draft} settings={settings} manager={manager} type={lineType} onPick={pickDiscount} />}
      <ApprovalDialog request={ask} onClose={() => setAsk(undefined)} onApproved={(discountApproval) => { setAsk(undefined); setDiscountDialog(false); void update({ ...draft, discountId: pending?.discountId, discountRule: pending?.rule, discount: discountApproval.amount!, discountReason: pending?.reason ?? "", discountApproval }); }} />
      {/* Figma C4/C4b: the total, how the guest pays, which EDC, what to do on it, the slip's code, then one confirm.
          Stores that take cash keep the cash and manual-check paths in the same layout. */}
      <Dialog open={Boolean(checkout)} onOpenChange={() => { if (armed) setCheckout(undefined); }} className="pay-dialog" title="Terima pembayaran" description={checkout ? payNote(checkout) : undefined}>
        {checkout && (
          <>
            <div className="payment-total"><span>Total tagihan</span><strong>{rupiah(checkout.totals.total)}</strong></div>
            <span className="pay-label">Bagaimana tamu membayar?</span>
            <div className="segmented pay-methods">
              {([...(cash ? (["cash"] as const) : []), "card", "qris"] as const).map((m) => (
                <button key={m} onClick={() => setMethod(m)} className={method === m ? "active" : ""} aria-pressed={method === m}>{m === "cash" ? <><Banknote size={18} /> Tunai</> : m === "qris" ? <><QrCode size={18} /> QRIS</> : <><Wallet size={18} /> Kartu</>}</button>
              ))}
            </div>
            {viaEdc ? (
              <>
                <span className="pay-label">Mesin EDC mana?</span>
                <div className="segmented edc-choice">
                  {edcs.map((e) => <button key={e} onClick={() => setEdc(e)} className={edc === e ? "active" : ""} aria-pressed={edc === e}>EDC {e}</button>)}
                </div>
                <p className="pay-info"><TriangleAlert size={20} /><span>{method === "card" ? `Ketik ${rupiah(checkout.totals.total)} di EDC ${edc}, tamu tap atau masukkan kartu. Tekan Konfirmasi setelah EDC mencetak "Approved".` : `Di EDC ${edc} pilih QRIS, ketik ${rupiah(checkout.totals.total)} dan tunjukkan QR ke tamu. Tekan Konfirmasi setelah EDC mencetak "Paid".`}</span></p>
                <label className="pay-field">Kode approval di slip EDC (opsional)<input inputMode="numeric" maxLength={30} value={approvalCode} onChange={(e) => setApprovalCode(e.target.value)} placeholder="412093" aria-describedby="pay-help" /></label>
                <p className="pay-help" id="pay-help">Membantu menemukan pembayaran yang tertunda di EDC.</p>
                <p className="pay-print"><Printer size={20} /> Struk tercetak saat Anda konfirmasi.</p>
              </>
            ) : method === "cash" ? (
              <>
                <label className="pay-field">Uang diterima<Money autoFocus value={received} onChange={setReceived} /></label>
                <div className="tender-options">
                  {[checkout.totals.total, 50000, 100000, 200000].map((n, i) => (
                    <button key={i} disabled={n < checkout.totals.total} onClick={() => setReceived(String(n))}>{i === 0 ? "Uang pas" : rupiah(n)}</button>
                  ))}
                </div>
                <div className="bill-total change-row"><span>Kembalian</span><strong>{rupiah(Math.max(0, Number(received) - checkout.totals.total))}</strong></div>
              </>
            ) : (
              <>
                <p className="pay-info"><TriangleAlert size={20} /><span>Pembayaran diverifikasi manual. Periksa transaksi berhasil pada aplikasi merchant / terminal kartu. Screenshot pelanggan bukan bukti penerimaan.</span></p>
                <label className="check-row"><input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />Saya sudah memeriksa penerimaan di akun merchant.</label>
              </>
            )}
            <Button className="full btn-accent pay-confirm" loading={busy} disabled={busy || !armed || (viaEdc ? !edc : method === "cash" ? Number(received) < checkout.totals.total : !verified)} onClick={() => pay()}><Check size={20} /> {viaEdc ? `Konfirmasi: ${method === "qris" ? "QRIS " : ""}dibayar di EDC ${edc}` : "Catat pembayaran"}</Button>
          </>
        )}
      </Dialog>
      {receipt && <Receipt order={receipt} auto={edcMode} onClose={() => setReceipt(undefined)} />}
    </div>
  );
}
