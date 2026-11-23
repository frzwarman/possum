import { Fragment, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Download,
  RefreshCw,
  Printer,
  Plus,
  LogOut,
  Check,
  Upload,
  Store,
  AlertTriangle,
  UserCog,
  Image as ImageIcon,
  Trash2,
  KeyRound,
  X,
  ArrowRight,
  Laptop,
  Tablet,
  MonitorSmartphone,
  Wallet,
  ChartColumn,
  Percent,
} from "lucide-react";
import { useApp, logout, signOutBlockers } from "../../app/context";
import { Button } from "../../components/ui/button";
import { Money } from "../../components/ui/money";
import { Select } from "../../components/ui/select";
import { SkeletonRows } from "../../components/ui/loading";
import { Dialog } from "../../components/ui/dialog";
import { csv, download, exportData, uid } from "../../lib/db";
import {
  parseCSV,
  menuImportSchema,
  stockImportSchema,
} from "../../lib/import";
import { readSheet, type SheetMenu } from "../../lib/sheet";
import { BahanPicker } from "./BahanPicker";
import type { Ingredient, MenuItem, MenuType, OptionGroup, Pack, Role, Station, StockItem } from "../../domain/types";
import { convert, describeDelta, itemStation, menuType, quantity, rupiah, typeLabel, when } from "../../domain/calculate";
import { can, roleLabel } from "../../domain/permissions";
import { ApprovalDialog, type ApprovalRequest } from "../../app/Approval";
import { supabase } from "../../lib/supabase";
import { demoApprovers } from "../../lib/commands";
import { compressLogo, compressMenuPhoto, menuPicture } from "../../lib/menu-photo";
import { bootstrap, pinHash, team } from "../auth/Login";
import { SESSION_GONE, signInAgain } from "../../lib/sync";
import { roleTitle } from "../../domain/permissions";
import { TelegramLink } from "./TelegramLink";
// Download links for the Android apps (twa/ and mobile/), set in .env at build time; an empty one hides its button.
// Shown to the owner (super admin) only.
const posApk = import.meta.env.VITE_POS_APK_URL || "";
const stokApk = import.meta.env.VITE_STOK_APK_URL || "";
const schema = z.object({
  appName: z.string().min(1).max(30),
  name: z.string().min(1).max(100),
  tagline: z.string().trim().max(60, "Maksimal 60 karakter"),
  address: z.string().max(200),
  phone: z.string().max(40),
  footer: z.string().max(150),
  // Intl accepts any letter case ("asia/jakarta"); the server checks the exact IANA name, so
  // store the canonical form.
  timezone: z.string().transform((v, ctx) => {
    try {
      return new Intl.DateTimeFormat("id", { timeZone: v }).resolvedOptions()
        .timeZone;
    } catch {
      ctx.addIssue({ code: "custom", message: "Zona waktu tidak valid" });
      return z.NEVER;
    }
  }),
  cutoff: z.coerce.number<number>().int().min(0).max(23),
  taxBps: z.coerce.number<number>().int().min(0).max(10000),
  serviceBps: z.coerce.number<number>().int().min(0).max(10000),
  goLive: z.string().min(10),
  printableWidth: z.coerce.number<number>().min(32).max(76),
  // Takar: station targets in minutes, the cash gap a cashier may close without a PIN, "running low" portions.
  stationTablets: z.boolean(),
  // Payment paths: cash in a drawer, EDC machines for card and QRIS (comma separated), or both. Plus the monthly
  // compliment budget and the idle-lock minutes.
  cash: z.boolean(),
  lockMinutes: z.coerce.number<number>().int().min(0).max(120),
  edcs: z.string().refine((v) => { const list = v.split(",").map((x) => x.trim()).filter(Boolean); return list.length <= 10 && list.every((x) => x.length <= 30); }, "Maksimal 10 EDC, nama maksimal 30 karakter"),
  complimentBudget: z.coerce.number<number>().int().min(0).max(1000000000),
  family: z.string().max(600),
  kitchenTarget: z.coerce.number<number>().int().min(1).max(600),
  barTarget: z.coerce.number<number>().int().min(1).max(600),
  varianceLimit: z.coerce.number<number>().int().min(0).max(1000000000),
  lowAt: z.coerce.number<number>().int().min(0).max(999),
});
const SIGNS = [{ value: "add", label: "tambah" }, { value: "remove", label: "kurangi / ganti" }];
const KINDS: [OptionGroup["kind"], string][] = [["add", "Tambahan (boleh beberapa)"], ["swap", "Ganti (pilih satu)"], ["level", "Tingkat (pilih satu)"], ["size", "Ukuran (pilih satu)"]];
const words = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
// Figma M7 option rows carry their group's kind as a chip; a loose add-on reads as "Tambah".
const KIND_CHIP: Record<OptionGroup["kind"], string> = { add: "Tambah", swap: "Ganti", level: "Level", size: "Ukuran" };
// Figma M8 puts what a person does under their name; here it is what the role may do (the access table).
const ROLE_NOTE: Record<Role, string> = { owner: "Pemilik, semua akses", manager: "Menyetujui pembatalan, diskon, dan selisih", admin: "Bahan, pembelian, dan hitung stok", chef: "Menu, resep, dan prep", cashier: "Kasir, pembayaran, dan stok harian", barista: "Stasiun bar", kitchen: "Stasiun dapur", accountant: "Akuntansi, catat biaya, dan log audit" };
const initials = (n: string) => n.split(/\s+/).slice(0, 2).map((w) => w[0] ?? "").join("").toUpperCase();
// Chips inside one field (Figma M7 tags): Enter or a comma adds what was typed, Backspace on an empty field drops the last.
function ChipBox({ values, onChange, label, placeholder, list }: { values: string[]; onChange: (v: string[]) => void; label: string; placeholder: string; list?: string }) {
  const [draft, setDraft] = useState("");
  const add = (v: string) => { const next = [...new Set([...values, ...words(v)])]; if (next.length !== values.length) onChange(next); setDraft(""); };
  return (
    <div className="chip-box">
      {values.map((t) => <button type="button" key={t} className="dot-chip" aria-label={`Hapus ${t}`} onClick={() => onChange(values.filter((x) => x !== t))}>{t}</button>)}
      <input aria-label={label} list={list} value={draft} placeholder={values.length ? "" : placeholder}
        onChange={(e) => (e.target.value.includes(",") ? add(e.target.value) : setDraft(e.target.value))}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(draft); } else if (e.key === "Backspace" && !draft && values.length) onChange(values.slice(0, -1)); }}
        onBlur={() => { if (draft) add(draft); }} />
    </div>
  );
}
// Figma M7 and M8 give "Menu & resep" and "Tim & perangkat" their own pages in the back-office nav (/menu, /team):
// the same tab, without the Lainnya tab bar.
export default function SettingsPage({ only }: { only?: "menu" | "team" } = {}) {
  const {
    settings,
    menu,
    stockItems,
    db,
    logo,
    orders,
    salesOrders,
    commands,
    user,
    manager,
    costs,
    shift,
    act,
    outbox,
    sync,
    setError,
    busy,
    gone,
  } = useApp();
  // Owner and manager tune the restaurant; chef and admin keep menu and ingredients; everyone has sync and device.
  const tillLocked = user.primary && Boolean(shift);
  const settingsRole = can(user.role, "settings") && !tillLocked, catalogRole = can(user.role, "catalog") && !tillLocked;
  const [tab, setTab] = useState<string>((only === "menu" ? catalogRole : only) ? only! : settingsRole ? "restaurant" : catalogRole ? "menu" : "sync");
  const [recipeUnit, setRecipeUnit] = useState("");
  const [effectFor, setEffectFor] = useState<number>();
  const [effect, setEffect] = useState({ stockId: "", amount: "", unit: "", sign: "add" });
  const [pack, setPack] = useState({ name: "", amount: "", unit: "" });
  const [ask, setAsk] = useState<ApprovalRequest>();
  const [mode, setMode] = useState<"pos" | "station" | "office">(user.role === "owner" ? "pos" : "station");
  const areas = [...new Set(stockItems.map((x) => x.area).filter((a): a is string => Boolean(a)))];
  const tags = [...new Set(menu.flatMap((m) => m.tags ?? []))];
  const [storage, setStorage] = useState("Belum diperiksa");
  const [item, setItem] = useState<MenuItem>();
  const [stock, setStock] = useState<StockItem>();
  const [width, setWidth] = useState<58 | 80>(settings?.receiptWidth || 80);
  const [importType, setImportType] = useState<"menu" | "stock">("menu");
  const [preview, setPreview] = useState<Record<string, string>[]>([]);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  // Recipe entry by keyboard: a picked bahan moves to Jumlah, Enter adds the line and returns to the search.
  const qtyRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  // "Belum ada? Tambah bahan baru" in a bahan search opens the bahan form with the typed name; once saved, the search takes it.
  const afterStockSave = useRef<(id: string) => void>(undefined);
  const newBahan = (name: string, pick: (id: string) => void) => {
    afterStockSave.current = pick;
    setStock({ id: uid(), name, unit: "pcs", threshold: 0, aliases: [], area: "", packs: [] });
  };
  // A file from the owner's own sheet: what the reader says about it, and for a COGS tab each row's recipe.
  const [sheet, setSheet] = useState<{ note: string; lines?: SheetMenu["lines"][] }>();
  // A recipe name with no bahan of that name or "nama lain" → the bahan the owner picked for it ("" = leave it out).
  const [links, setLinks] = useState<Record<string, string>>({});
  const key = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const bahan = new Map(stockItems.flatMap((s) => [s.name, ...(s.aliases ?? [])].map((n) => [key(n), s] as const)));
  const linked = (n: string) => bahan.get(key(n)) ?? bahan.get(key(links[key(n)] ?? ""));
  const unknown = Object.values(links).filter((v) => v.trim() && !bahan.has(key(v)));
  // Menus this import adds with no recipe line at all: a chef or admin needs a manager's PIN for those (MENU-7).
  const bare = importType !== "menu" ? 0 : sheet?.lines ? sheet.lines.filter((ls) => !ls.some((l) => linked(l.name))).length : preview.length;
  const [recipeStock, setRecipeStock] = useState("");
  const [recipeQty, setRecipeQty] = useState("");
  const [signout, setSignout] = useState(false);
  // Before signing out: send what can be sent, then list what would be stranded (open shift, new cart, unsent work).
  const [blockers, setBlockers] = useState<string[] | null>(null);
  async function openSignout() {
    setBlockers(null);
    setSignout(true);
    await sync().catch(() => undefined);
    const b = await signOutBlockers(db, user);
    setBlockers([
      ...(b.shift ? ["Sif Anda masih terbuka. Tutup sif dulu di Sif. Untuk istirahat, cukup kunci layar."] : []),
      ...(b.cart ? ["Ada pesanan baru di keranjang. Simpan atau kosongkan dulu di Kasir."] : []),
      ...(b.unsent ? [`${b.unsent} operasi belum terkirim ke server. Sambungkan internet dan tunggu sampai tersinkron.`] : []),
    ]);
  }
  // Menu items with a sale (till or catering) can only be switched off; the rest can be removed for good.
  const [removing, setRemoving] = useState<MenuItem>();
  const sold = new Set([...orders.flatMap((o) => o.lines.map((l) => l.itemId)), ...salesOrders.flatMap((o) => o.lines.map((l) => l.itemId))]);
  const [claim, setClaim] = useState(false);
  const [testPrint, setTestPrint] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [pinDialog, setPinDialog] = useState(false);
  // Two different PINs: "PIN masuk" is this account's sign-in on the shared tablet (the account password);
  // "PIN persetujuan" is a manager's PIN for approving a cashier's void, discount or gap.
  const [pinKind, setPinKind] = useState<"login" | "approve">("approve");
  const [bomStock, setBomStock] = useState("");
  const [bomQty, setBomQty] = useState("");
  const [pin, setPin] = useState("");
  const [pinAgain, setPinAgain] = useState("");
  // Figma M7 editor page: whether the recipe row form is open, and which option is unfolded for editing.
  const [adding, setAdding] = useState(false);
  const [openOpt, setOpenOpt] = useState<string>();
  // Figma M8: the team as the server lists it (the demo has its own two approvers), and the two "how to add" notes.
  const [members, setMembers] = useState<{ id: string; name: string; role: Role; active: boolean }[]>();
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [help, setHelp] = useState<"person" | "device">();
  useEffect(() => {
    if (tab !== "team" || user.demo || !supabase || !can(user.role, "team")) return;
    let live = true;
    setLoadingMembers(true);
    void supabase.from("memberships").select("user_id,name,role,active").order("name").then(({ data }) => { if (live && data) setMembers(data.map((m) => ({ id: m.user_id, name: m.name, role: m.role as Role, active: m.active }))); }, () => undefined).then(() => { if (live) setLoadingMembers(false); });
    return () => { live = false; };
  }, [tab, user.demo, user.role]);
  // Opening or leaving the editor starts its little forms afresh, at the top of the page.
  function edit(next?: MenuItem) {
    setItem(next);
    setAdding(false);
    setOpenOpt(undefined);
    setRecipeStock("");
    setRecipeQty("");
    setRecipeUnit("");
    // The shell's <main> is what scrolls, not the window.
    document.getElementById("main")?.scrollTo({ top: 0 });
  }
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    values: settings && { ...settings, tagline: settings.tagline ?? "", stationTablets: Boolean(settings.stationTablets), cash: !settings.cashless, edcs: (settings.edcs ?? []).join(", "), lockMinutes: settings.lockMinutes ?? 2, complimentBudget: settings.complimentBudget ?? 0, family: (settings.family ?? []).join(", "), kitchenTarget: settings.stations?.kitchen ?? 15, barTarget: settings.stations?.bar ?? 8, varianceLimit: settings.varianceLimit ?? 10000, lowAt: settings.lowAt ?? 5 },
  });
  const errors = form.formState.errors;
  async function saveSettings(values: z.infer<typeof schema>) {
    if (!settings) return;
    if (values.printableWidth > width - 4) {
      setError("Lebar area cetak harus lebih kecil dari lebar kertas");
      return;
    }
    const { kitchenTarget, barTarget, varianceLimit, lowAt, stationTablets, cash, edcs, complimentBudget, lockMinutes, family, ...rest } = values;
    const machines = words(edcs);
    if (!cash && !machines.length) {
      setError("Tanpa tunai, isi minimal satu mesin EDC untuk kartu dan QRIS");
      return;
    }
    await act(
      () => commands.settings({ ...settings, ...rest, receiptWidth: width, stations: { kitchen: kitchenTarget, bar: barTarget }, varianceLimit, lowAt, stationTablets, cashless: !cash, edcs: machines, complimentBudget, lockMinutes, family: [...new Set(words(family).filter((n) => n.length <= 60))].slice(0, 20) }),
      "Pengaturan tersimpan",
    );
  }
  // MENU-1 / MENU-7: one form publishes at once; a chef or admin needs a manager's PIN when an active item has no recipe.
  async function saveItem(approval?: import("../../domain/types").Approval) {
    if (!item) return;
    if (!Number.isInteger(item.price) || item.price < 0) { setError("Harga tidak valid"); return; }
    const next = { ...item, category: typeLabel[menuType(item)], version: item.version + 1 };
    const catalog = [...menu.filter((m) => m.id !== item.id), next];
    if (!manager && !approval && catalog.some((m) => m.active && !m.recipe.length)) {
      setAsk({ action: "publish", what: `Terbitkan menu dengan ${catalog.filter((m) => m.active && !m.recipe.length).length} menu aktif tanpa resep` });
      return;
    }
    await act(async () => {
      await commands.publish(catalog, stockItems, approval);
      setItem(undefined);
    }, "Versi menu tersimpan; struk lama tidak berubah");
  }
  // MENU-3: cost, margin and food-cost % from each ingredient's latest purchase price.
  const recipeCost = (recipe: Ingredient[]) => recipe.every((r) => costs.has(r.stockId)) ? Math.round(recipe.reduce((n, r) => n + r.qty * costs.get(r.stockId)!, 0)) : undefined;
  const unitsFor = (s?: StockItem) => s ? [{ value: s.unit, label: s.unit }, ...(s.unit === "g" ? [{ value: "kg", label: "kg" }] : s.unit === "ml" ? [{ value: "l", label: "liter" }] : []), ...(s.packs ?? []).map((pk) => ({ value: pk.name, label: `${pk.name} (${quantity(pk.qty)} ${s.unit})` }))] : [{ value: "", label: "Pilih bahan dulu" }];
  function template() {
    download(
      `meja-template-${importType}.csv`,
      importType === "menu"
        ? csv([
            ["name", "type", "price"],
            ["Nasi kuning", "food", 18000],
            ["Es teh", "beverage", 8000],
          ])
        : csv([
            ["name", "unit", "quantity", "threshold", "area", "pack_name", "pack_qty"],
            ["Beras", "g", 10000, 2000, "Dry store", "karung", 25000],
          ]),
      "text/csv",
    );
  }
  async function readFile(file: File) {
    try {
      // A dropped file skips the picker's .csv filter: an Excel file or a photo is turned away here.
      if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") throw new Error("Pilih berkas CSV. Di Google Sheets: File → Download → Comma-separated values (.csv).");
      if (file.size > 200000) throw new Error("CSV maksimal 200 KB");
      const text = await file.text();
      // The owner's own sheet (a market list or a COGS tab, downloaded as CSV) is read as laid out; anything else
      // follows the template.
      const found = readSheet(text, file.name);
      const rows: Record<string, string>[] =
        found?.kind === "menu" ? found.menus.map((m) => ({ name: m.name, category: m.category, type: m.type, price: String(m.price) })) : found ? found.rows : parseCSV(text);
      setSheet(
        found?.kind === "menu"
          ? {
              lines: found.menus.map((m) => m.lines),
              note: [
                'Resep ikut dari COGS; baris "Others" tidak dihitung.',
                found.skipped.length ? `Tanpa harga jual, dilewati: ${found.skipped.join(", ")}.` : "",
                stockItems.length ? "" : "Belum ada bahan: impor market list dulu supaya resep tersambung.",
              ].filter(Boolean).join(" "),
            }
          : found && {
              note: `Satuan ditebak dari nama dan kategori: periksa sekarang, sesudah impor tidak bisa diubah. ${found.skipped} baris tanpa isi kemasan (judul kategori atau bahan yang belum ada harganya) dilewati. Stok awal 0; isi lewat Hitung stok.`,
            },
      );
      // A name of two words or more that all sit in exactly one bahan's name ("oat milk" → "Oat Milk 1L") is filled in.
      const parts = (s: string) => key(s).split(/[^a-z0-9]+/).filter(Boolean);
      const next: Record<string, string> = {};
      if (found?.kind === "menu")
        for (const n of found.menus.flatMap((m) => m.lines.map((l) => key(l.name))))
          if (!bahan.has(n) && !(n in next)) {
            const hits = parts(n).length > 1 ? stockItems.filter((s) => parts(n).every((w) => parts(s.name).includes(w))) : [];
            next[n] = hits.length === 1 ? hits[0].name : "";
          }
      setLinks(next);
      // The columns say which template a file follows: a bahan file picked while "Menu" is selected switches over
      // instead of failing every row on a missing price.
      const head = Object.keys(rows[0] ?? {});
      const type: typeof importType = head.includes("price") ? "menu" : head.includes("unit") && head.includes("quantity") ? "stock" : importType;
      if (type !== importType) setImportType(type);
      const errs: string[] = [];
      rows.forEach((r, i) => {
        const parsed = (
          type === "menu" ? menuImportSchema : stockImportSchema
        ).safeParse(r);
        if (!parsed.success)
          errs.push(
            `Baris ${i + 2}: ${parsed.error.issues.map((x) => x.path.join(".") + " " + x.message).join("; ")}`,
          );
      });
      if (new Set(rows.map((r) => r.name.toLowerCase())).size !== rows.length)
        errs.push("Nama duplikat dalam impor");
      const taken = rows.filter((r) => (type === "menu" ? menu : stockItems).some((m) => m.name.toLowerCase() === r.name.toLowerCase())).map((r) => r.name);
      if (taken.length) errs.push(`Nama sudah ada: ${taken.join(", ")}. Edit menu/bahan yang ada; impor hanya menambah.`);
      setPreview(rows);
      setImportErrors(errs);
    } catch (e) {
      setImportErrors([String(e)]);
      setPreview([]);
      setSheet(undefined);
    }
  }
  async function applyImport(approval?: import("../../domain/types").Approval) {
    await act(async () => {
      if (importErrors.length || !preview.length)
        throw new Error("Perbaiki CSV dahulu");
      if (importType === "menu") {
        const added = preview.map((r, i) => {
          const parsed = menuImportSchema.parse(r);
          // Two sheet lines that land on one bahan (Milk and Steam Milk → Fresh Milk) add up to one recipe line.
          const recipe = new Map<string, number>();
          for (const l of sheet?.lines?.[i] ?? []) {
            const s = linked(l.name);
            if (s) recipe.set(s.id, (recipe.get(s.id) ?? 0) + Math.round(l.qty * 1000));
          }
          return {
            id: uid(),
            name: r.name,
            category: typeLabel[parsed.type],
            type: parsed.type,
            station: itemStation({ type: parsed.type, category: "" }),
            tags: sheet?.lines && r.category ? [r.category.slice(0, 50)] : [],
            aliases: [],
            groups: [],
            lowAt: settings?.lowAt ?? 5,
            price: Number(r.price),
            active: true,
            soldOut: false,
            favorite: false,
            version: 1,
            modifiers: [],
            recipe: [...recipe].filter(([, qty]) => qty > 0).map(([stockId, qty]) => ({ stockId, qty })),
          };
        });
        // Each name linked in the preview becomes that bahan's "nama lain", so the next COGS file finds it by itself.
        const stock = stockItems.map((s) => {
          const more = Object.entries(links).filter(([n, v]) => n.length <= 50 && bahan.get(key(v))?.id === s.id).map(([n]) => n);
          return more.length ? { ...s, aliases: [...new Set([...(s.aliases ?? []), ...more])].slice(0, 20) } : s;
        });
        await commands.publish([...menu, ...added], stock, approval);
      } else {
        // "0" and "10,5" are amounts the file may hold; convert() takes only a positive one.
        const positive = (v: string) => Number(v.replace(",", ".")) > 0;
        const added = preview.map((r) => ({
          id: uid(),
          name: r.name,
          unit: r.unit as StockItem["unit"],
          threshold: positive(r.threshold) ? convert(r.threshold, r.unit, r.unit) : 0,
          area: r.area || "",
          aliases: [],
          packs: r.pack_name ? [{ name: r.pack_name, qty: convert(r.pack_qty, r.unit, r.unit) }] : [],
        }));
        await commands.publish(menu, [...stockItems, ...added]);
        for (let i = 0; i < added.length; i++)
          if (positive(preview[i].quantity))
            await commands.stockRecord(
              added[i].id,
              "opening",
              convert(preview[i].quantity, added[i].unit, added[i].unit),
              "Impor saldo awal",
            );
      }
      setPreview([]);
      setSheet(undefined);
      setLinks({});
    }, "Impor tersimpan. Periksa sinkronisasi sebelum impor berikutnya.");
  }
  function addRecipe() {
    if (!item || !recipeStock || !recipeQty) return;
    const s = stockItems.find((s) => s.id === recipeStock)!;
    try {
      const r: Ingredient = {
        stockId: s.id,
        qty: convert(recipeQty, recipeUnit || s.unit, s.unit, s.packs),
      };
      setItem({
        ...item,
        // A changed amount keeps its row where it was.
        recipe: item.recipe.some((x) => x.stockId === s.id) ? item.recipe.map((x) => (x.stockId === s.id ? r : x)) : [...item.recipe, r],
      });
      setRecipeStock("");
      setRecipeQty("");
      setRecipeUnit("");
      // The search stays open for the next bahan (Batal closes it).
      setAdding(true);
      pickRef.current?.focus();
    } catch (e) {
      setError(String(e));
    }
  }
  // The store's logo: shrunk on this device, saved on the server (owner or manager), kept here for offline receipts.
  async function setLogo(file?: File) {
    await act(async () => {
      const image = file ? await compressLogo(file) : "";
      if (!user.demo) {
        const { error } = await supabase!.rpc("set_logo", { image });
        if (error) throw new Error(error.message.includes("Manager required") ? "Hanya pemilik atau manajer yang dapat mengganti logo" : error.message);
      }
      if (image) await db.meta.put({ id: "logo", value: image });
      else await db.meta.delete("logo");
    }, file ? "Logo tersimpan. Tampil di struk dan sidebar." : "Logo dihapus");
  }
  async function choosePhoto(file: File) {
    if (!item) return;
    setPhotoBusy(true);
    setError("");
    try {
      setItem({ ...item, photo: await compressMenuPhoto(file) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Foto tidak dapat diproses");
    } finally {
      setPhotoBusy(false);
    }
  }
  const pending = outbox.filter((o) => o.state !== "synced");
  // M7: the published version beside the draft, for the version chips and the cost tile.
  const live = item && menu.find((m) => m.id === item.id);
  const cost = item?.recipe.length ? recipeCost(item.recipe) : undefined;
  const liveCost = live?.recipe.length ? recipeCost(live.recipe) : undefined;
  // M8: the demo knows only its two approvers; a real restaurant lists its memberships. You come first.
  const me = { id: user.id, name: user.name, role: user.role, active: true };
  const people = user.demo
    ? [me, ...demoApprovers.filter((a) => a.id !== user.id).map((a) => ({ ...a, role: a.id.slice(5) as Role, active: true }))]
    : [me, ...(members ?? []).filter((m) => m.id !== user.id)];
  const activeMenu = menu.filter((m) => m.active), unrecipied = activeMenu.filter((m) => !m.recipe.length).length;
  // Lainnya: each tab has its own title and line, like the separate Figma pages it stands in for.
  const head: Record<string, [string, string]> = {
    restaurant: ["Restoran", "Nama dan alamat di struk, pajak, cara bayar, dan aturan sif."],
    menu: ["Menu & resep", `${activeMenu.length} menu aktif${unrecipied ? `, ${unrecipied} belum punya resep` : ", semua dengan resep"}.`],
    stock: ["Daftar bahan", `${stockItems.length} bahan dalam satuan dasar, ${stockItems.filter((s) => s.production).length} dibuat sendiri.`],
    import: ["Impor CSV", "Tambah menu atau bahan dari template. Data yang sudah ada tidak berubah."],
    sync: ["Sinkron & backup", user.demo ? "Demo lokal: semua data hanya ada di perangkat ini." : pending.length ? `${pending.length} operasi menunggu dikirim ke server.` : "Semua operasi sudah terkirim ke server."],
    team: ["Tim & perangkat", `Di ${settings?.name || "restoran ini"}, ${settings?.stationTablets ? "tablet kasir menerima pesanan, dapur dan bar menerima tiket di tablet stasiun." : "satu tablet kasir menerima pesanan dan menampilkan stok. Bar dan dapur tanpa layar."}`],
  };
  const [title, sub] = head[tab] ?? head.sync;
  return (
    <section className={`page-content settings-page${only ? ` only-${only}` : ""}`}>
      {/* Figma M7: one menu item as a page of its own (details and options left, recipe and its cost right). */}
      {item ? (
        <section className="menu-edit" aria-label={item.version ? "Edit menu" : "Tambah menu"}>
          <div className="page-heading">
            <div>
              <button type="button" className="crumb" onClick={() => edit()}>Menu & resep</button>
              <div className="set-title">
                <h1>{item.name || "Menu baru"}</h1>
                {live ? (
                  <>
                    <span className={`dot-chip ${live.active ? "good" : ""}`}>{live.active ? "Live" : "Nonaktif"} v{live.version}</span>
                    <span className="dot-chip info">Mengedit v{live.version + 1}</span>
                  </>
                ) : (
                  <span className="dot-chip info">Belum terbit</span>
                )}
              </div>
            </div>
            <div className="button-row">
              <button type="button" className="set-discard" onClick={() => edit()}>Buang perubahan</button>
              <Button className="btn-accent" loading={busy} disabled={busy || !item.name} onClick={() => saveItem()}>
                <Check size={20} /> Simpan versi menu
              </Button>
            </div>
          </div>
          <div className="menu-edit-grid">
            <div className="menu-edit-col">
              <article className="panel menu-basics">
                <div className="menu-photo-box">
                  <img src={menuPicture(item)} alt="Pratinjau foto menu" />
                  <div className="menu-photo-actions">
                    <label className="photo-upload" title="JPG, PNG, atau WebP hingga 10 MB. Takar memperkecil foto untuk penggunaan offline.">
                      <ImageIcon size={16} />
                      {photoBusy ? "Memperkecil foto…" : item.photo ? "Ganti foto" : "Unggah foto (opsional)"}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        capture="environment"
                        disabled={photoBusy}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void choosePhoto(file);
                          event.currentTarget.value = "";
                        }}
                      />
                    </label>
                    {item.photo && (
                      <button type="button" className="photo-upload" onClick={() => setItem({ ...item, photo: undefined })}>
                        <Trash2 size={15} /> Pakai gambar standar
                      </button>
                    )}
                  </div>
                </div>
                <label>
                  Nama menu
                  <input value={item.name} onChange={(e) => setItem({ ...item, name: e.target.value })} />
                </label>
                <div className="set-field" role="radiogroup" aria-labelledby="menu-type">
                  <span className="set-label" id="menu-type">Jenis</span>
                  <div className="opt-pills">
                    {(Object.keys(typeLabel) as MenuType[]).map((t) => (
                      <label key={t} className={`opt-pill ${menuType(item) === t ? "on" : ""}`}>
                        <input type="radio" name="menu-type" checked={menuType(item) === t} onChange={() => setItem({ ...item, type: t, category: typeLabel[t], station: t === "beverage" ? "bar" : "kitchen" })} />
                        {typeLabel[t]}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="set-field">
                  <span className="set-label">Tag (dicari di kasir)</span>
                  <ChipBox label="Tag baru" list="takar-tags" placeholder="Signature, Kopi" values={item.tags ?? []} onChange={(t) => setItem({ ...item, tags: t })} />
                  <datalist id="takar-tags">{tags.map((t) => <option key={t} value={t} />)}</datalist>
                </div>
                <div className="menu-price-row">
                  <label>
                    Harga
                    <Money value={String(item.price)} onChange={(v) => setItem({ ...item, price: Number(v || 0) })} />
                  </label>
                  <div className="set-field" role="radiogroup" aria-labelledby="menu-station">
                    <span className="set-label" id="menu-station">Dibuat di</span>
                    <div className="opt-pills">
                      {(["kitchen", "bar"] as Station[]).map((s) => (
                        <label key={s} className={`opt-pill ${itemStation(item) === s ? "on" : ""}`}>
                          <input type="radio" name="menu-station" checked={itemStation(item) === s} onChange={() => setItem({ ...item, station: s })} />
                          {s === "bar" ? "Bar" : "Dapur"}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              </article>
              <article className="panel menu-options">
                <div className="panel-heading">
                  <h2>Pilihan</h2>
                  <button type="button" className="set-add" onClick={() => { const id = uid(); setItem({ ...item, modifiers: [...item.modifiers, { id, name: "", price: 0, recipe: [] }] }); setOpenOpt(id); }}>
                    <Plus size={16} /> Tambah pilihan
                  </button>
                </div>
                {item.modifiers.map((m, i) => {
                  const g = item.groups?.find((x) => x.id === m.group), open = openOpt === m.id;
                  return (
                    <Fragment key={m.id}>
                      <button type="button" className={`option-row ${open ? "on" : ""}`} aria-expanded={open} onClick={() => setOpenOpt(open ? undefined : m.id)}>
                        <span className="dot-chip">{KIND_CHIP[g?.kind ?? "add"]}</span>
                        <span className="option-name">
                          {g && g.kind !== "add" && g.name ? `${g.name}: ` : ""}{m.name || "Tanpa nama"}
                          {m.default && <small> · bawaan</small>}
                        </span>
                        <strong>{m.price ? `+${rupiah(m.price)}` : "Gratis"}</strong>
                      </button>
                      {open && (
                        <div className="modifier-editor">
                          <div className="form-grid">
                            <label>
                              Nama tambahan
                              <input value={m.name} onChange={(e) => setItem({ ...item, modifiers: item.modifiers.map((v, j) => (j === i ? { ...v, name: e.target.value } : v)) })} />
                            </label>
                            <label>
                              Harga tambahan
                              <Money value={String(m.price)} onChange={(value) => setItem({ ...item, modifiers: item.modifiers.map((mod, j) => (j === i ? { ...mod, price: Number(value || 0) } : mod)) })} />
                            </label>
                          </div>
                          {(item.groups ?? []).length > 0 && (
                            <Select
                              label="Grup"
                              value={m.group ?? ""}
                              onChange={(value) => setItem({ ...item, modifiers: item.modifiers.map((mod, j) => (j === i ? { ...mod, group: value || undefined } : mod)) })}
                              options={[{ value: "", label: "Tanpa grup (tambahan lepas)" }, ...(item.groups ?? []).map((gr) => ({ value: gr.id, label: gr.name || "(grup tanpa nama)" }))]}
                            />
                          )}
                          {m.group && g?.kind !== "add" && (
                            <label className="inline-check">
                              <input type="checkbox" checked={Boolean(m.default)} onChange={(e) => setItem({ ...item, modifiers: item.modifiers.map((mod, j) => (j === i ? { ...mod, default: e.target.checked } : mod.group === m.group && e.target.checked ? { ...mod, default: false } : mod)) })} />
                              Pilihan bawaan
                            </label>
                          )}
                          <p className="small muted">Efek ke stok: {describeDelta(m.recipe, stockItems) || "tidak ada"}</p>
                          {m.recipe.map((r) => (
                            <div className="bill-row" key={r.stockId}>
                              <span>{r.qty > 0 ? "+" : "−"}{quantity(Math.abs(r.qty))} {stockItems.find((s) => s.id === r.stockId)?.unit} {stockItems.find((s) => s.id === r.stockId)?.name}</span>
                              <button className="text-button" onClick={() => setItem({ ...item, modifiers: item.modifiers.map((mod, j) => (j === i ? { ...mod, recipe: mod.recipe.filter((x) => x.stockId !== r.stockId) } : mod)) })}>Hapus</button>
                            </div>
                          ))}
                          {effectFor === i ? (
                            <div className="form-grid">
                              <BahanPicker items={stockItems} value={effect.stockId} costs={costs} onChange={(v) => setEffect({ ...effect, stockId: v, unit: stockItems.find((s) => s.id === v)?.unit ?? "" })} />
                              <Select label="Efek" value={effect.sign} onChange={(v) => setEffect({ ...effect, sign: v })} options={SIGNS} />
                              <label>
                                Jumlah
                                <input inputMode="decimal" value={effect.amount} onChange={(e) => setEffect({ ...effect, amount: e.target.value })} />
                              </label>
                              <Select label="Satuan" value={effect.unit} onChange={(v) => setEffect({ ...effect, unit: v })} options={unitsFor(stockItems.find((s) => s.id === effect.stockId))} />
                              <Button
                                variant="secondary"
                                disabled={!effect.stockId || !effect.amount}
                                onClick={() => {
                                  const s = stockItems.find((x) => x.id === effect.stockId)!;
                                  try {
                                    const qty = convert(effect.amount, effect.unit || s.unit, s.unit, s.packs) * (effect.sign === "add" ? 1 : -1);
                                    setItem({ ...item, modifiers: item.modifiers.map((mod, j) => (j === i ? { ...mod, recipe: [...mod.recipe.filter((x) => x.stockId !== s.id), { stockId: s.id, qty }] } : mod)) });
                                    setEffect({ stockId: "", amount: "", unit: "", sign: "add" });
                                    setEffectFor(undefined);
                                  } catch (e) {
                                    setError(e instanceof Error ? e.message : "Jumlah tidak valid");
                                  }
                                }}
                              >
                                Simpan efek
                              </Button>
                            </div>
                          ) : (
                            <button className="text-button" onClick={() => { setEffectFor(i); setEffect({ stockId: "", amount: "", unit: "", sign: "add" }); }}>Tambah efek bahan</button>
                          )}
                          <button className="text-button" onClick={() => { setItem({ ...item, modifiers: item.modifiers.filter((_, j) => j !== i) }); setOpenOpt(undefined); }}>
                            Hapus tambahan
                          </button>
                        </div>
                      )}
                    </Fragment>
                  );
                })}
                <div className="group-head">
                  <h3>Grup pilihan</h3>
                  <button type="button" className="set-add" onClick={() => setItem({ ...item, groups: [...(item.groups ?? []), { id: uid(), name: "", kind: "add" }] })}>
                    <Plus size={16} /> Tambah grup pilihan
                  </button>
                </div>
                <p className="small muted">Ukuran, susu, gula, tambahan. Pilihan "ganti" dan "tingkat" mengurangi bahan dasar, "tambahan" menambah.</p>
                {(item.groups ?? []).map((g, gi) => (
                  <div className="group-row" key={g.id}>
                    <input aria-label="Nama grup" placeholder="Nama grup, mis. Susu" value={g.name} onChange={(e) => setItem({ ...item, groups: item.groups!.map((x, j) => (j === gi ? { ...x, name: e.target.value } : x)) })} />
                    <Select ariaLabel="Jenis grup" value={g.kind} onChange={(v) => setItem({ ...item, groups: item.groups!.map((x, j) => (j === gi ? { ...x, kind: v as OptionGroup["kind"], required: v !== "add" } : x)) })} options={KINDS.map(([value, label]) => ({ value, label }))} />
                    <button type="button" className="row-remove" aria-label={`Hapus grup ${g.name}`.trim()} onClick={() => setItem({ ...item, groups: item.groups!.filter((_, j) => j !== gi), modifiers: item.modifiers.map((m) => (m.group === g.id ? { ...m, group: undefined } : m)) })}>
                      <X size={16} />
                    </button>
                  </div>
                ))}
              </article>
            </div>
            <div className="menu-edit-col">
              <article className="panel recipe-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Resep per porsi</h2>
                    <p className="small muted">{settings?.stationTablets ? "Stok berkurang saat pesanan dikirim ke stasiun" : "Stok berkurang saat pesanan dibayar"}</p>
                  </div>
                </div>
                {item.recipe.length > 0 ? (
                  <div className="table-scroll">
                    <table className="data-table plain-table recipe-table">
                      <thead>
                        <tr><th>Bahan</th><th>Jumlah</th><th className="num">Biaya</th></tr>
                      </thead>
                      <tbody>
                        {item.recipe.map((r) => {
                          const s = stockItems.find((x) => x.id === r.stockId);
                          return (
                            <tr key={r.stockId} className={adding && recipeStock === r.stockId ? "editing" : ""}>
                              <td>
                                <button type="button" className="recipe-name" title="Ubah jumlah" onClick={() => { setAdding(true); setRecipeStock(r.stockId); setRecipeUnit(""); setRecipeQty(String(r.qty / 1000).replace(".", ",")); }}>{s?.name ?? "Bahan dihapus"}</button>
                                {s?.production && <span className="dot-chip">Prep</span>}
                              </td>
                              <td>{quantity(r.qty)} {s?.unit}</td>
                              <td className="num"><strong>{costs.has(r.stockId) ? rupiah(Math.round(r.qty * costs.get(r.stockId)!)) : "—"}</strong></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="small muted">Kosong = tidak dilacak. Minuman botol: pilih bahan botol, jumlah 1. Batch matang: lacak porsi, bukan asumsi hasil bahan mentah.</p>
                )}
                {adding || !item.recipe.length ? (
                  <div className="recipe-add">
                    <BahanPicker items={stockItems} value={recipeStock} costs={costs} inputRef={pickRef} used={item.recipe.map((r) => r.stockId).filter((x) => x !== recipeStock)} onChange={(v) => { setRecipeStock(v); setRecipeUnit(""); if (v) qtyRef.current?.focus(); }} onNew={(name) => newBahan(name, (id) => { setRecipeStock(id); setRecipeUnit(""); })} />
                    <label>
                      Jumlah
                      <input ref={qtyRef} inputMode="decimal" value={recipeQty} onChange={(e) => setRecipeQty(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRecipe(); } }} />
                    </label>
                    <Select label="Satuan" value={recipeUnit || stockItems.find((s) => s.id === recipeStock)?.unit || ""} onChange={setRecipeUnit} options={unitsFor(stockItems.find((s) => s.id === recipeStock))} />
                    {/* Figma M7 draws the recipe without a delete column: a row is removed from its edit form. */}
                    <div className="recipe-add-actions">
                      {item.recipe.some((r) => r.stockId === recipeStock) && (
                        <button type="button" className="set-remove" onClick={() => { setItem({ ...item, recipe: item.recipe.filter((x) => x.stockId !== recipeStock) }); setRecipeStock(""); setRecipeQty(""); setRecipeUnit(""); }}>
                          <Trash2 size={16} /> Hapus dari resep
                        </button>
                      )}
                      {item.recipe.length > 0 && (
                        <Button variant="ghost" onClick={() => { setAdding(false); setRecipeStock(""); setRecipeQty(""); setRecipeUnit(""); }}>
                          Batal
                        </Button>
                      )}
                      <Button variant="secondary" onClick={addRecipe}>
                        {item.recipe.some((r) => r.stockId === recipeStock) ? "Simpan jumlah" : "Tambah bahan resep"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="set-add muted-add" onClick={() => setAdding(true)}>
                    <Plus size={16} /> Tambah bahan atau prep
                  </button>
                )}
              </article>
              <div className="metrics menu-cost">
                <article className="metric tone-lavender">
                  <span><Wallet size={16} /> Biaya per porsi</span>
                  <strong>{cost === undefined ? "—" : rupiah(cost)}</strong>
                  <small>{!item.recipe.length ? "belum ada resep" : cost === undefined ? "harga sebagian bahan belum tercatat" : live && liveCost !== undefined && liveCost !== cost ? `${rupiah(liveCost)} di v${live.version}` : "dari harga beli terakhir"}</small>
                </article>
                <article className="metric tone-mint">
                  <span><ChartColumn size={16} /> Margin</span>
                  <strong>{cost === undefined ? "—" : rupiah(item.price - cost)}</strong>
                  <small>{cost !== undefined && item.price ? `${Math.round(((item.price - cost) / item.price) * 100)}% dari harga` : "harga jual dikurangi biaya"}</small>
                </article>
                <article className="metric tone-sky">
                  <span><Percent size={16} /> Food cost</span>
                  <strong>{cost !== undefined && item.price ? `${((cost / item.price) * 100).toFixed(1).replace(".", ",")}%` : "—"}</strong>
                  <small>biaya bahan dibagi harga</small>
                </article>
              </div>
              {item.active && !item.recipe.length && (
                <p className="callout">
                  <AlertTriangle size={18} /> Menu aktif tanpa resep tidak memotong stok. {manager ? "" : "Menerbitkannya perlu PIN manajer."}
                </p>
              )}
              {/* Not on the Figma card, kept from the old editor: how the item behaves on the till. */}
              <article className="panel menu-till">
                <div className="panel-heading">
                  <h2>Di kasir</h2>
                </div>
                <div className="opt-pills" role="group" aria-label="Status di kasir">
                  {([["active", "Aktif"], ["soldOut", "Habis"], ["favorite", "Favorit"], ["ignoreStock", "Tetap jual walau bahan habis"]] as const).map(([key, label]) => (
                    <label key={key} className={`opt-pill ${item[key] ? "on" : ""}`}>
                      <input type="checkbox" checked={Boolean(item[key])} onChange={(e) => setItem({ ...item, [key]: e.target.checked })} />
                      {label}
                    </label>
                  ))}
                </div>
                <div className="menu-till-grid">
                  <div className="set-field">
                    <span className="set-label">Nama lain untuk pencarian</span>
                    <ChipBox label="Nama lain baru" placeholder="americano panas, kopi hitam" values={item.aliases ?? []} onChange={(a) => setItem({ ...item, aliases: a })} />
                  </div>
                  <label>
                    "Hampir habis" di bawah (porsi)
                    <input type="number" inputMode="numeric" value={item.lowAt ?? settings?.lowAt ?? 5} onChange={(e) => setItem({ ...item, lowAt: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
                  </label>
                </div>
              </article>
            </div>
          </div>
        </section>
      ) : (
      <>
      {!only && <div className="category-tabs settings-tabs">
        {[
          ...(settingsRole ? [["restaurant", "Restoran"]] : []),
          ...(catalogRole
            ? [
                ["menu", "Menu & resep"],
                ["stock", "Daftar bahan"],
                ["import", "Impor CSV"],
              ]
            : []),
          ["sync", "Sinkron & backup"],
          ["team", "Tim & perangkat"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>}
      <div className="page-heading">
        <div>
          <h1>{title}</h1>
          <p className="muted">{sub}</p>
        </div>
        {tab === "menu" && catalogRole && (
          <Button
            className="btn-accent"
            onClick={() =>
              edit({
                id: uid(),
                name: "",
                category: "Makanan",
                type: "food",
                station: "kitchen",
                tags: [],
                aliases: [],
                groups: [],
                lowAt: settings?.lowAt ?? 5,
                price: 0,
                active: true,
                soldOut: false,
                favorite: false,
                recipe: [],
                modifiers: [],
                version: 0,
              })
            }
          >
            <Plus size={18} /> Tambah menu
          </Button>
        )}
        {tab === "stock" && catalogRole && (
          <Button className="btn-accent" onClick={() => setStock({ id: uid(), name: "", unit: "pcs", threshold: 0, aliases: [], area: "", packs: [] })}>
            <Plus size={18} /> Tambah bahan
          </Button>
        )}
        {tab === "team" && manager && (
          <Button className="btn-accent" onClick={() => setHelp("person")}>
            <Plus size={22} /> Tambah orang
          </Button>
        )}
      </div>
      {/* Only here: the back-office tabs are missing on the cashier device while a shift is open, so say why. */}
      {tillLocked && (can(user.role, "settings") || can(user.role, "catalog")) && (
        <p className="callout">
          <AlertTriangle size={16} />
          <span>Restoran, menu, dan bahan tertutup selama sif terbuka di kasir ini. Tutup sif dulu, atau buka dari laptop.</span>
        </p>
      )}
      {settingsRole && tab === "restaurant" && (
        <div className="settings-columns">
          <form className="panel" onSubmit={form.handleSubmit(saveSettings)}>
            <h2>Identitas restoran</h2>
            <div className="logo-field">
              <span className="logo-preview">{logo ? <img src={logo} alt="Logo restoran" /> : <Store size={22} />}</span>
              <div>
                <strong>Logo</strong>
                <p className="small muted">Tampil di atas struk (dicetak hitam-putih) dan di sidebar. PNG dengan latar transparan paling rapi.</p>
                <div className="button-row">
                  <label className="btn btn-secondary btn-sm">
                    <Upload size={15} /> {logo ? "Ganti logo" : "Unggah logo"}
                    <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void setLogo(f); }} />
                  </label>
                  {logo && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setLogo()}>Hapus logo</Button>}
                </div>
              </div>
            </div>
            <div className="form-grid">
              <label>
                Nama aplikasi
                <input {...form.register("appName")} />
              </label>
              <label>
                Nama restoran
                <input {...form.register("name")} />
              </label>
            </div>
            <label>
              Keterangan di bawah nama (opsional)
              <input placeholder="Contoh: Kopi & makan siang, lantai 2" maxLength={60} {...form.register("tagline")} />
              <small className="muted">Tampil di sidebar di bawah nama restoran. Kosongkan bila tidak perlu.</small>
            </label>
            <label>
              Alamat di struk
              <input {...form.register("address")} />
            </label>
            <label>
              Telepon (opsional)
              <input {...form.register("phone")} />
            </label>
            <label>
              Pesan penutup struk
              <input {...form.register("footer")} />
            </label>
            <div className="form-grid">
              <label>
                Zona waktu
                <input {...form.register("timezone")} />
              </label>
              <label>
                Jam pergantian hari (0–23)
                <input type="number" {...form.register("cutoff")} />
              </label>
            </div>
            <label>
              Mulai pencatatan operasional
              <input type="date" {...form.register("goLive")} />
            </label>
            <div className="form-grid">
              <label>
                Pajak (basis poin)
                <input type="number" {...form.register("taxBps")} />
              </label>
              <label>
                Layanan (basis poin)
                <input type="number" {...form.register("serviceBps")} />
              </label>
            </div>
            <p className="small muted">
              0 = nonaktif. 100 basis poin = 1%. Pajak dihitung setelah diskon
              dan layanan; pembulatan setengah ke atas per tagihan.
            </p>
            <div className="form-grid">
              <Select
                label="Kertas struk"
                value={String(width)}
                onChange={(v) => setWidth(Number(v) as 58 | 80)}
                options={[
                  { value: "58", label: "58 mm" },
                  { value: "80", label: "80 mm" },
                ]}
              />
              <label>
                Area cetak (mm)
                <input type="number" {...form.register("printableWidth")} />
              </label>
            </div>
            <div className="form-grid">
              <label>
                Target dapur (menit)
                <input type="number" {...form.register("kitchenTarget")} />
              </label>
              <label>
                Target bar (menit)
                <input type="number" {...form.register("barTarget")} />
              </label>
            </div>
            <label className="inline-check">
              <input type="checkbox" {...form.register("stationTablets")} />
              Tablet dapur & bar menerima tiket (tanpa ini kasir memberi tahu, dan stok berkurang saat bayar)
            </label>
            <label className="inline-check">
              <input type="checkbox" {...form.register("cash")} />
              Terima tunai: modal kas saat buka sif, laci dihitung saat tutup sif
            </label>
            <div className="form-grid">
              <label>
                Mesin EDC untuk kartu & QRIS
                <input placeholder="BCA, BRI, Mandiri" {...form.register("edcs")} />
                <small className="muted">Pisahkan dengan koma. Slip settlement tiap EDC dicocokkan saat tutup sif. Kosongkan bila tanpa EDC.</small>
              </label>
              <label>
                Anggaran compliment per bulan (Rp)
                <input type="number" {...form.register("complimentBudget")} />
              </label>
              <label>
                Keluarga pemilik
                <input placeholder="Bu Rina, Kevin, Oma" {...form.register("family")} />
                <small className="muted">Pisahkan dengan koma. Muncul sebagai pilihan sekali ketuk saat kasir mencatat compliment keluarga pemilik, setelah nama pemilik.</small>
              </label>
            </div>
            <div className="form-grid three">
              <label>
                Selisih tanpa PIN (Rp)
                <input type="number" {...form.register("varianceLimit")} />
              </label>
              <label>
                Hampir habis (porsi)
                <input type="number" {...form.register("lowAt")} />
              </label>
              <label>
                Kunci layar (menit)
                <input type="number" min={0} max={120} {...form.register("lockMinutes")} />
              </label>
            </div>
            <p className="small muted">
              Tiket berubah merah setelah target stasiun. Kasir menutup sif tanpa PIN selama selisih kas atau EDC di bawah batas. Kunci layar 0 berarti tablet tidak pernah dikunci.
            </p>
            {Object.entries(errors).map(([key, e]) => (
              <p className="error" key={key}>
                {key}: {e?.message}
              </p>
            ))}
            <Button className="form-submit" loading={busy} disabled={busy}>
              Simpan pengaturan
            </Button>
          </form>
          <div>
            <article className="panel setup-guide">
              <h2>Langkah pertama</h2>
              <ol>
                <li>
                  <strong>Kenalkan restoran Anda</strong>
                  <p>Nama, alamat, dan tanggal mulai pencatatan.</p>
                </li>
                <li>
                  <strong>Siapkan menu</strong>
                  <p>Harga, tambahan, dan resep dapat diubah bertahap.</p>
                </li>
                <li>
                  <strong>Hitung stok awal</strong>
                  <p>Catat saldo awal di Stok atau impor CSV.</p>
                </li>
                <li>
                  <strong>Uji satu struk</strong>
                  <p>Sesuaikan 58 / 80 mm dengan printer sebenarnya.</p>
                </li>
                <li>
                  <strong>Buka sif pertama</strong>
                  <p>Hitung modal laci, lalu mulai dari Kasir.</p>
                </li>
              </ol>
              <p className="callout">
                Laporan dimulai pada tanggal operasional. Meja tidak membuat
                riwayat penjualan sebelum tanggal tersebut.
              </p>
            </article>
            <article className="panel mt">
              <h2>Kemasan bungkus</h2>
              <p className="small muted">
                Dikonsumsi per porsi/menu saat persiapan bungkus.
              </p>
              <Select
                ariaLabel="Bahan kemasan"
                value={settings?.packaging[0]?.stockId || ""}
                onChange={(v) =>
                  settings &&
                  void act(
                    () =>
                      commands.settings({
                        ...settings,
                        packaging: v ? [{ stockId: v, qty: 1000 }] : [],
                      }),
                    "Kemasan diperbarui",
                  )
                }
                options={[
                  { value: "", label: "Tanpa pelacakan kemasan" },
                  ...stockItems
                    .filter((s) => s.unit === "pcs")
                    .map((s) => ({
                      value: s.id,
                      label: `${s.name} (1 per item)`,
                    })),
                ]}
              />
            </article>
          </div>
        </div>
      )}
      {catalogRole && tab === "menu" && (
        <article className="panel set-list">
          {menu.map((m) => (
            <div className="admin-row" key={m.id}>
              <img
                className="admin-menu-thumb"
                src={menuPicture(m)}
                alt=""
              />
              <div>
                <strong>{m.name}</strong>
                <p className="small muted">
                  {typeLabel[menuType(m)]} · {itemStation(m) === "bar" ? "Bar" : "Dapur"} · {rupiah(m.price)} ·{" "}
                  {m.photo ? "Dengan foto" : "Gambar standar"}
                  {m.tags?.length ? ` · ${m.tags.join(", ")}` : ""} · v{m.version}
                </p>
              </div>
              {!m.recipe.length && m.active && <span className="dot-chip warning">Belum ada resep</span>}
              <span className={`dot-chip ${!m.active ? "" : m.soldOut ? "critical" : "good"}`}>
                {!m.active ? "Nonaktif" : m.soldOut ? "Habis" : "Aktif"}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => edit(structuredClone(m))}
              >
                Edit
              </Button>
              {manager && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Hapus ${m.name}`}
                  title={sold.has(m.id) ? "Sudah terjual: nonaktifkan lewat Edit" : "Hapus menu ini"}
                  disabled={sold.has(m.id)}
                  onClick={() => setRemoving(m)}
                >
                  <Trash2 size={16} />
                </Button>
              )}
            </div>
          ))}
        </article>
      )}
      {catalogRole && tab === "stock" && (
        <article className="panel set-list">
          {stockItems.map((s) => (
            <div className="admin-row" key={s.id}>
              <div>
                <strong>{s.name}</strong>
                {s.production && <span className="dot-chip">Prep</span>}
                <p className="small muted">
                  {s.unit} · par {quantity(s.threshold)} {s.unit}{s.area ? ` · ${s.area}` : ""}
                  {s.packs?.length ? ` · ${s.packs.map((pk) => `1 ${pk.name} = ${quantity(pk.qty)} ${s.unit}`).join(", ")}` : ""}
                  {s.production ? " · bahan olahan" : ""}
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => setStock({ ...s })}>
                Edit
              </Button>
            </div>
          ))}
        </article>
      )}
      {catalogRole && tab === "import" && (
        <article className="panel">
          <h2>Impor dengan pratinjau</h2>
          <p className="muted">
            Tambahkan data dari template, atau langsung dari sheet market list dan COGS (unduh tab-nya sebagai CSV). Tidak mengubah data yang sudah ada.
          </p>
          <Select
            label="Jenis data"
            value={importType}
            onChange={(v) => {
              setImportType(v as typeof importType);
              setPreview([]);
              setImportErrors([]);
              setSheet(undefined);
              setLinks({});
            }}
            options={[
              { value: "menu", label: "Menu" },
              { value: "stock", label: "Bahan & saldo awal" },
            ]}
          />
          <Button variant="secondary" onClick={template}>
            <Download size={16} /> Unduh template CSV
          </Button>
          {/* Click to pick a file, or drop one anywhere on the field (dropping elsewhere would open it in the tab). */}
          <label
            className={`upload-label${dragging ? " dragging" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setDragging(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files[0];
              if (f) void readFile(f);
            }}
          >
            <Upload size={20} /> {dragging ? "Lepas untuk membaca berkas" : "Pilih atau seret berkas CSV ke sini"}
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                // Cleared after each pick, so choosing the same file again (after a fix or a type change) reads it again.
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void readFile(f);
              }}
            />
          </label>
          {importErrors.map((e) => (
            <p className="error" key={e}>
              {e}
            </p>
          ))}
          {preview.length > 0 && (
            <>
              <h3>{preview.length} baris diperiksa</h3>
              {sheet && <p className="muted">{sheet.note}</p>}
              <div className="import-preview">
                {preview.map((r, i) =>
                  !sheet ? (
                    <div key={i}>{Object.values(r).join(" · ")}</div>
                  ) : sheet.lines ? (
                    <div key={i}>
                      {r.name} · {rupiah(Number(r.price))} · {r.category || typeLabel[r.type as MenuType]} · {sheet.lines[i].length} bahan
                    </div>
                  ) : (
                    <div key={i} className="import-row">
                      <span>
                        {r.name}
                        {r.pack_qty && <small className="muted"> · pak {r.pack_qty} {r.unit}</small>}
                      </span>
                      <div className="segmented" role="group" aria-label={`Satuan ${r.name}`}>
                        {["g", "ml", "pcs"].map((u) => (
                          <button key={u} type="button" className={r.unit === u ? "active" : ""} aria-pressed={r.unit === u} onClick={() => setPreview(preview.map((x, j) => (j === i ? { ...x, unit: u } : x)))}>
                            {u}
                          </button>
                        ))}
                      </div>
                    </div>
                  ),
                )}
              </div>
              {sheet?.lines && Object.keys(links).length > 0 && (
                <div className="import-links">
                  <h3>{Object.keys(links).length} nama bahan di resep belum ada di Stok</h3>
                  <p className="muted">Ketik lalu pilih bahan yang sama dari Stok; nama di resep disimpan sebagai nama lain bahan itu. Biarkan kosong untuk melewati baris resepnya.</p>
                  <datalist id="import-bahan">
                    {stockItems.map((s) => (
                      <option key={s.id} value={s.name} />
                    ))}
                  </datalist>
                  {Object.entries(links).map(([n, v]) => (
                    <label key={n} className="import-row">
                      <span>
                        {n}
                        <small className="muted"> · {sheet.lines!.filter((ls) => ls.some((l) => key(l.name) === n)).length} menu</small>
                      </span>
                      <input list="import-bahan" value={v} placeholder="Lewati" aria-invalid={Boolean(v.trim()) && !bahan.has(key(v))} onChange={(e) => setLinks({ ...links, [n]: e.target.value })} />
                    </label>
                  ))}
                </div>
              )}
              {unknown.length > 0 && <p className="error">Tidak ada di Stok: {unknown.join(", ")}. Pilih dari daftar atau kosongkan.</p>}
              <Button
                loading={busy}
                disabled={busy || importErrors.length > 0 || unknown.length > 0}
                onClick={() => (!manager && bare ? setAsk({ action: "publish", what: bare < preview.length ? `Impor ${preview.length} menu, ${bare} tanpa resep` : `Impor ${preview.length} menu tanpa resep` }) : void applyImport())}
              >
                Konfirmasi impor {preview.length} baris
              </Button>
            </>
          )}
        </article>
      )}
      {tab === "sync" && (
        <>
          <div className="settings-columns">
            <article className="panel">
              <div className="panel-heading">
                <h2>Antrean sinkronisasi</h2>
                <span className="badge">{pending.length} operasi</span>
              </div>
              <p className="muted">
                {user.demo
                  ? "Demo lokal tidak mengirim data ke server. Operasi demo tetap tersedia untuk diperiksa."
                  : "Urutan operasi dipertahankan. Konflik menghentikan antrean agar transaksi berikutnya tidak salah diterapkan."}
              </p>
              <Button
                variant="secondary"
                onClick={() =>
                  act(
                    async () => {
                      await db.outbox
                        .where("state")
                        .equals("pending")
                        .modify({ nextAttempt: 0 });
                      await sync();
                    },
                    user.demo
                      ? "Demo lokal: tidak ada server tujuan"
                      : "Percobaan sinkronisasi selesai; periksa status antrean",
                  )
                }
              >
                <RefreshCw size={16} /> Coba sinkronkan
              </Button>
              <div className="sync-list">
                {pending.slice(0, 50).map((o) => (
                  <div key={o.id}>
                    <div>
                      <strong>{o.kind}</strong>
                      <span
                        className={`badge ${o.state === "rejected" ? "badge-warning" : ""}`}
                      >
                        {o.state === "rejected"
                          ? "Perlu diperiksa"
                          : "Belum tersinkron"}
                      </span>
                    </div>
                    <small>
                      {when(o.occurredAt, settings?.timezone)} ·{" "}
                      {o.id.slice(0, 8)}
                    </small>
                    {o.error && <p className="error">{o.error}</p>}
                    {o.state === "rejected" && (
                      <p className="small">
                        Ekspor pemulihan. Pemilik perlu membandingkan ID operasi
                        dengan server, memperbaiki penyebab (misalnya hak akun),
                        lalu mencoba payload asli kembali. Jangan membuat ulang
                        pembayaran.
                      </p>
                    )}
                    {/* Every queued operation is this person's: whoever owns it may send it again; the server decides. */}
                    {o.state === "rejected" && (
                      <Button
                        variant="secondary"
                        onClick={() =>
                          act(async () => {
                            await db.outbox.update(o.id, {
                              state: "pending",
                              nextAttempt: 0,
                            });
                            await sync();
                          })
                        }
                      >
                        Coba ulang operasi asli
                      </Button>
                    )}
                    {o.state === "rejected" && manager && (
                      <Button
                        variant="destructive"
                        onClick={() =>
                          act(async () => {
                            download("takar-pemulihan.json", JSON.stringify(await exportData(db, true), null, 2));
                            await db.outbox.delete(o.id);
                            await sync();
                          }, "Operasi dibuang; catatan lokalnya tetap ada di ekspor pemulihan")
                        }
                      >
                        Buang operasi ini
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </article>
            <article className="panel">
              <h2>Ekspor & pemulihan</h2>
              <p className="muted">
                Ekspor tidak menyertakan token, kata sandi, atau kunci rahasia.
              </p>
              <div className="button-stack">
                <Button
                  variant="secondary"
                  onClick={() =>
                    act(async () =>
                      download(
                        "meja-backup-lokal.json",
                        JSON.stringify(await exportData(db), null, 2),
                      ),
                    )
                  }
                >
                  <Download size={17} /> Backup data yang ada di perangkat
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    act(async () =>
                      download(
                        "meja-pemulihan.json",
                        JSON.stringify(await exportData(db, true), null, 2),
                      ),
                    )
                  }
                >
                  <Download size={17} /> Ekspor pemulihan operasi
                </Button>
              </div>
              <p className="callout">
                Ini bukan backup lengkap database restoran. Pemilik perlu backup
                database terpisah sesuai panduan administrator. Ingat ekspor
                saat menutup sif.
              </p>
              <p className="small muted">
                Jika perangkat rusak: gunakan kertas bernomor, catat waktu,
                menu, pembayaran dan kas. Jangan mengaktifkan kasir offline
                kedua. Rekonsiliasi sebelum serah terima perangkat.
              </p>
            </article>
          </div>
        </>
      )}
      {/* Figma M8: the team on the left, this device and how to pair another on the right. The app keeps no presence
          or pairing codes, so a person shows "Aktif sekarang" only for you and devices list only this one. */}
      {tab === "team" && (
        <div className="team-grid">
          <div className="team-col">
            {can(user.role, "team") && (
              <article className="panel team-panel">
                <div className="panel-heading">
                  <h2>Tim</h2>
                  <span className="muted">{people.filter((p) => p.active).length} orang</span>
                </div>
                <div className="team-list">
                  {people.map((p) => {
                    const self = p.id === user.id, owner = user.role === "owner" && !user.demo && !self;
                    const body = (
                      <>
                        <span className="avatar">{initials(p.name)}</span>
                        <span>
                          <strong>{p.name}</strong>
                          <small>{p.active ? ROLE_NOTE[p.role] : "Nonaktif: ditolak server saat masuk"}</small>
                        </span>
                        <span className={`dot-chip ${p.role === "owner" || p.role === "manager" ? "info" : ""}`}>{roleLabel[p.role]}</span>
                        <span className={`team-status ${p.active ? "" : "off"}`}>{self ? "Aktif sekarang" : p.active ? "" : "Nonaktif"}</span>
                        <span className="team-go" aria-hidden>{owner && <ArrowRight size={16} />}</span>
                      </>
                    );
                    // The owner changes roles and access in the owner area; everyone else only sees the list.
                    return owner ? (
                      <a key={p.id} href="/admin" className="person-row team-row" title="Ubah peran di area pemilik">{body}</a>
                    ) : (
                      <div key={p.id} className="person-row team-row">{body}</div>
                    );
                  })}
                </div>
                {!user.demo && !members && (loadingMembers ? <SkeletonRows label="Memuat anggota tim" /> : <p className="small muted">Daftar lengkap tampil saat perangkat online.</p>)}
              </article>
            )}
            <article className="panel">
              <div className="panel-heading">
                <h2>Printer struk</h2>
                <span className="dot-chip warning">Printer fisik belum diverifikasi</span>
              </div>
              <p className="muted">
                Lewat dialog cetak browser atau sistem. Cetak dipicu oleh operator; dialog browser tidak membuktikan
                kertas tercetak.
              </p>
            <Button
              className="full mt"
              variant="secondary"
              onClick={() => setTestPrint(true)}
            >
              <Printer size={17} /> Buka tes cetak {settings?.receiptWidth} mm
            </Button>
            <details className="printer-checks">
              <summary>Daftar uji printer</summary>
            <ul className="checklist">
              <li>Pasangkan printer melalui sistem operasi.</li>
              <li>Periksa nama printer dan ukuran kertas.</li>
              <li>Uji teks, lebar, margin, dan pesanan panjang.</li>
              <li>Uji pembatalan, kertas habis, dan cetak ulang.</li>
              <li>
                Catat model Android, browser, printer, dan sambungan yang
                berhasil.
              </li>
            </ul>
            <p className="small muted">
              Bluetooth ESC/POS, cetak diam-diam, dan pemotong otomatis tidak
              dijamin oleh PWA.
            </p>
            </details>
            </article>
          </div>
          <div className="team-col">
            <article className="panel device-panel">
              <div className="panel-heading">
                <h2>Perangkat</h2>
                {manager && <button type="button" className="dark-button" onClick={() => setHelp("device")}>Tambah perangkat</button>}
              </div>
              <div className="person-row device-row">
                <span className="device-icon">{user.mode === "office" ? <Laptop size={18} /> : user.primary || user.mode ? <Tablet size={18} /> : <MonitorSmartphone size={18} />}</span>
                <span>
                  <strong>{user.primary ? "Kasir utama" : user.mode === "station" ? "Tablet stasiun" : user.mode === "office" ? "Back office" : "Belum dipasangkan"}</strong>
                  <small>{user.primary ? "Pesanan, bayar, stok" : user.mode === "station" ? "Tiket dapur dan bar" : user.mode === "office" ? "Laporan, menu, stok" : "Hanya membaca"}</small>
                </span>
                <span className="dot-chip">Perangkat ini</span>
              </div>
            {manager && !user.demo && (
              <>
                <Select
                  label="Pasangkan perangkat ini sebagai"
                  value={mode}
                  onChange={(v) => setMode(v as typeof mode)}
                  options={[{ value: "station", label: "Stasiun (tablet dapur / bar)" }, { value: "office", label: "Back office (laptop)" }, ...(user.role === "owner" ? [{ value: "pos", label: "Kasir utama" }] : [])]}
                />
                {mode !== "pos" && (
                  <Button
                    className="full"
                    loading={busy}
                    onClick={() =>
                      act(async () => {
                        const { error } = await supabase!.rpc("enroll_device", { device_id: user.deviceId, mode });
                        if (error) throw error;
                        localStorage.setItem("meja-identity", JSON.stringify(await bootstrap(user.id, user.deviceId)));
                        location.reload();
                      })
                    }
                  >
                    Pasangkan sebagai {mode === "station" ? "stasiun" : "back office"}
                  </Button>
                )}
              </>
            )}
            {user.role === "owner" ? (
              <>
                {!user.primary && !user.demo && mode === "pos" && (
                  <Button className="full mt" onClick={() => setClaim(true)}>
                    Jadikan perangkat ini kasir utama
                  </Button>
                )}
                <p className="small muted">
                  Pemilik dapat memindahkan kasir utama kapan saja ke perangkat
                  mana pun. Perangkat lama langsung dicabut, jadi sinkronkan
                  dulu dari sana. Perpindahan tercatat di riwayat serah terima.
                </p>
              </>
            ) : (
              <p className="small muted">
                Perangkat kasir utama ditentukan pemilik restoran.
              </p>
            )}
            </article>
          {user.role === "owner" && (posApk || stokApk) && (
            <article className="panel">
              <h2>Aplikasi Android</h2>
              <p className="muted">Unduh di tablet atau ponsel, buka file APK-nya, lalu izinkan pemasangan bila diminta.</p>
              <div className="callout">
                <AlertTriangle size={18} /> Aplikasi ini belum tersedia di Play Store.
              </div>
              {posApk && (
                <Button asChild className="full">
                  <a href={posApk} target="_blank" rel="noopener noreferrer"><Download size={17} /> Unduh aplikasi kasir (POS)</a>
                </Button>
              )}
              {stokApk && (
                <Button asChild variant="secondary" className="full mt">
                  <a href={stokApk} target="_blank" rel="noopener noreferrer"><Download size={17} /> Unduh aplikasi stok (Takar Stok)</a>
                </Button>
              )}
            </article>
          )}
          <article className="panel">
            <h2>Penyimpanan perangkat</h2>
            <p className="muted">{storage}</p>
            <Button
              variant="secondary"
              onClick={() =>
                act(async () => {
                  const granted = await navigator.storage?.persist?.();
                  const estimate = await navigator.storage?.estimate?.();
                  setStorage(
                    `${granted ? "Penyimpanan persisten diberikan" : "Persistensi tidak diberikan; data masih dapat dihapus browser"}. Terpakai ${Math.round((estimate?.usage || 0) / 1024 / 1024)} MB.`,
                  );
                })
              }
            >
              Minta penyimpanan persisten
            </Button>
            <p className="callout">
              <AlertTriangle size={18} /> Jangan gunakan mode privat atau hapus
              data situs pada kasir. Penyimpanan browser tetap dapat hilang.
              Ekspor secara berkala.
            </p>
          </article>
          </div>
        </div>
      )}
      {/* A session ended elsewhere (revoked, expired for good): this person's work waits on this device until they sign in again here. */}
      {!only && gone && (
        <form
          className="callout"
          onSubmit={(e) => {
            e.preventDefault();
            const secret = String(new FormData(e.currentTarget).get("secret") ?? "");
            void act(async () => {
              if (!(await signInAgain(db, user, team().find((m) => m.id === user.id)?.login, secret))) throw new Error("PIN atau kata sandi salah, atau server belum terjangkau");
            }, "Masuk lagi berhasil; antrean dikirim");
          }}
        >
          <AlertTriangle size={16} />
          <label>
            {SESSION_GONE}
            <input name="secret" type="password" autoComplete="current-password" required />
          </label>
          <Button size="sm" loading={busy} disabled={busy}>
            Masuk lagi
          </Button>
        </form>
      )}
      {/* The account strip (PINs, Telegram, sign out) belongs to Lainnya, not to the /menu and /team pages. */}
      {!only && <div className="account-footer">
        <span className="avatar">{initials(user.name)}</span>
        <div className="account-id">
          <strong>{user.name}</strong>
          <p className="muted small">
            {roleTitle[user.role]} · {user.demo ? "Demo lokal" : "Akun restoran"}
          </p>
        </div>
        <div className="account-actions">
          {!user.demo && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setPin("");
                setPinAgain("");
                setPinKind("login");
                setPinDialog(true);
              }}
            >
              <KeyRound size={16} /> PIN masuk
            </Button>
          )}
          {can(user.role, "pin") && !user.demo && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setPin("");
                setPinAgain("");
                setPinKind("approve");
                setPinDialog(true);
              }}
            >
              <KeyRound size={16} /> PIN persetujuan
            </Button>
          )}
          {manager && !user.demo && <TelegramLink />}
          {user.role === "owner" && (
            <Button asChild variant="secondary" size="sm">
              <a href="/admin">
                <UserCog size={16} /> Akun staf
              </a>
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => openSignout()}>
            <LogOut size={16} /> Keluar akun
          </Button>
        </div>
      </div>}
      </>
      )}
      <Dialog
        open={Boolean(stock)}
        onOpenChange={() => {
          setStock(undefined);
          afterStockSave.current = undefined;
        }}
        title="Bahan stok"
      >
        {stock && (
          <>
            <label>
              Nama bahan
              <input
                value={stock.name}
                onChange={(e) => setStock({ ...stock, name: e.target.value })}
              />
            </label>
            <Select
              label="Satuan dasar"
              disabled={stockItems.some((s) => s.id === stock.id)}
              value={stock.unit}
              onChange={(v) =>
                setStock({ ...stock, unit: v as StockItem["unit"] })
              }
              options={[
                { value: "pcs", label: "pcs / porsi" },
                { value: "g", label: "gram" },
                { value: "ml", label: "mililiter" },
              ]}
            />
            <div className="form-grid">
              <label>
                Par (batas minimum, {stock.unit})
                <input
                  type="number"
                  inputMode="decimal"
                  value={stock.threshold / 1000}
                  onChange={(e) =>
                    setStock({
                      ...stock,
                      threshold: Math.round(Number(e.target.value) * 1000),
                    })
                  }
                />
              </label>
              <label>
                Area simpan
                <input list="takar-areas" value={stock.area ?? ""} onChange={(e) => setStock({ ...stock, area: e.target.value })} placeholder="Kulkas bar, Dry store, Freezer" />
                <datalist id="takar-areas">{areas.map((a) => <option key={a} value={a} />)}</datalist>
              </label>
            </div>
            <label>
              Nama lain untuk pencarian
              <input value={(stock.aliases ?? []).join(", ")} onChange={(e) => setStock({ ...stock, aliases: words(e.target.value) })} placeholder="fresh milk, susu cair" />
            </label>
            <h3 className="mt">Kemasan beli</h3>
            <p className="small muted">Kiriman dicatat dalam kemasan, stok tetap dalam {stock.unit}.</p>
            {(stock.packs ?? []).map((pk) => (
              <div className="bill-row" key={pk.name}>
                <span>1 {pk.name} = {quantity(pk.qty)} {stock.unit}</span>
                <button className="text-button" onClick={() => setStock({ ...stock, packs: stock.packs!.filter((x) => x.name !== pk.name) })}>Hapus</button>
              </div>
            ))}
            <div className="form-grid">
              <label>
                Nama kemasan
                <input value={pack.name} onChange={(e) => setPack({ ...pack, name: e.target.value })} placeholder="karton" />
              </label>
              <label>
                Isi per kemasan
                <input inputMode="decimal" value={pack.amount} onChange={(e) => setPack({ ...pack, amount: e.target.value })} placeholder="12" />
              </label>
            </div>
            <Select label="Satuan isi" value={pack.unit || stock.unit} onChange={(v) => setPack({ ...pack, unit: v })} options={[{ value: stock.unit, label: stock.unit }, ...(stock.unit === "g" ? [{ value: "kg", label: "kg" }] : stock.unit === "ml" ? [{ value: "l", label: "liter" }] : [])]} />
            <Button
              variant="secondary"
              disabled={!pack.name.trim() || !pack.amount}
              onClick={() => {
                try {
                  const qty = convert(pack.amount, pack.unit || stock.unit, stock.unit);
                  setStock({ ...stock, packs: [...(stock.packs ?? []).filter((x) => x.name !== pack.name.trim()), { name: pack.name.trim(), qty } as Pack] });
                  setPack({ name: "", amount: "", unit: "" });
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Isi kemasan tidak valid");
                }
              }}
            >
              Tambah kemasan
            </Button>
            <label className="inline-check mt">
              <input
                type="checkbox"
                checked={Boolean(stock.production)}
                onChange={(e) =>
                  setStock({
                    ...stock,
                    production: e.target.checked ? { inputs: [], output: 1000 } : undefined,
                  })
                }
              />
              Dibuat sendiri dari bahan lain (Produksi)
            </label>
            {stock.production && (
              <>
                <p className="small muted">
                  Resep satu batch. Produksi mengurangi bahan ini dan menambah
                  hasilnya ke stok.
                </p>
                {stock.production.inputs.map((i) => (
                  <div className="bill-row" key={i.stockId}>
                    <span>
                      {stockItems.find((x) => x.id === i.stockId)?.name}: {i.qty / 1000}{" "}
                      {stockItems.find((x) => x.id === i.stockId)?.unit}
                    </span>
                    <button
                      className="text-button"
                      onClick={() =>
                        setStock({
                          ...stock,
                          production: {
                            ...stock.production!,
                            inputs: stock.production!.inputs.filter((x) => x.stockId !== i.stockId),
                          },
                        })
                      }
                    >
                      Hapus
                    </button>
                  </div>
                ))}
                <div className="form-grid">
                  <BahanPicker label="Bahan per batch" drop="down" items={stockItems.filter((x) => x.id !== stock.id)} value={bomStock} costs={costs} onChange={setBomStock} />
                  <label>
                    Jumlah satuan dasar
                    <input inputMode="decimal" value={bomQty} onChange={(e) => setBomQty(e.target.value)} />
                  </label>
                </div>
                <Button
                  variant="secondary"
                  disabled={!bomStock || !bomQty}
                  onClick={() => {
                    const input = stockItems.find((x) => x.id === bomStock)!;
                    try {
                      const qty = convert(bomQty, input.unit, input.unit);
                      setStock({
                        ...stock,
                        production: {
                          ...stock.production!,
                          inputs: [...stock.production!.inputs.filter((x) => x.stockId !== input.id), { stockId: input.id, qty }],
                        },
                      });
                      setBomStock("");
                      setBomQty("");
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                >
                  Tambah bahan produksi
                </Button>
                <label>
                  Hasil per batch ({stock.unit})
                  <input
                    type="number"
                    inputMode="decimal"
                    value={stock.production.output / 1000}
                    onChange={(e) =>
                      setStock({
                        ...stock,
                        production: { ...stock.production!, output: Math.round(Number(e.target.value) * 1000) },
                      })
                    }
                  />
                </label>
                <div className="form-grid">
                  <label>
                    Masa simpan (jam)
                    <input type="number" inputMode="numeric" value={stock.shelfLife ?? ""} onChange={(e) => setStock({ ...stock, shelfLife: e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : undefined })} placeholder="48" />
                  </label>
                  <Select label="Dibuat di" value={stock.station ?? "kitchen"} onChange={(v) => setStock({ ...stock, station: v as Station })} options={[{ value: "kitchen", label: "Dapur" }, { value: "bar", label: "Bar" }]} />
                </div>
              </>
            )}
            <Button
              className="full"
              disabled={!stock.name || busy}
              onClick={() =>
                act(async () => {
                  await commands.publish(menu, [
                    ...stockItems.filter((s) => s.id !== stock.id),
                    stock,
                  ]);
                  setStock(undefined);
                  afterStockSave.current?.(stock.id);
                  afterStockSave.current = undefined;
                }, "Bahan tersimpan")
              }
            >
              Simpan bahan
            </Button>
          </>
        )}
      </Dialog>
      <ApprovalDialog request={ask} onClose={() => setAsk(undefined)} onApproved={(a) => { setAsk(undefined); if (item) void saveItem(a); else void applyImport(a); }} />
      {/* Accounts and devices are not created in the app (no public sign-up, no pairing codes): say how it is done. */}
      <Dialog
        open={Boolean(help)}
        onOpenChange={() => setHelp(undefined)}
        title={help === "device" ? "Tambah perangkat" : "Tambah orang"}
        description={help === "device" ? "Perangkat dipasangkan dari perangkat itu sendiri, setelah masuk dengan akun staf." : "Pendaftaran publik dimatikan. Akun staf dibuat pemilik dari terminal, bukan dari aplikasi."}
      >
        {help === "device" ? (
          <ol className="set-steps">
            <li>Buka Takar di tablet atau laptop itu, lalu masuk dengan akun staf (email dan PIN masuk).</li>
            <li>Manajer membuka Lainnya → Tim & perangkat di perangkat itu dan memasangkannya sebagai stasiun atau back office.</li>
            <li>Untuk kasir utama: pemilik masuk di perangkat itu dan memilih Jadikan perangkat ini kasir utama. Kasir lama langsung dicabut, jadi sinkronkan dulu.</li>
          </ol>
        ) : (
          <>
            <div className="code-block set-code">
              <code>{`pnpm staff add <email> <peran> <nama> --restaurant ${user.restaurantId} --pin <6 angka>`}</code>
            </div>
            <p className="small muted">Peran: owner, manager, admin, chef, cashier, barista, kitchen, accountant. Sandi awal tampil sekali; serahkan langsung ke orangnya. Peran dan akses diubah di area pemilik.</p>
            {user.role === "owner" && !user.demo && (
              <Button asChild variant="secondary">
                <a href="/admin">
                  <UserCog size={16} /> Buka area pemilik
                </a>
              </Button>
            )}
          </>
        )}
      </Dialog>
      <Dialog
        open={pinDialog}
        onOpenChange={setPinDialog}
        title={pinKind === "login" ? "PIN masuk" : "PIN persetujuan"}
        description={pinKind === "login" ? "Untuk masuk di tablet: ketuk nama Anda, lalu ketik PIN ini. PIN ini menggantikan kata sandi akun Anda." : "Dipakai saat kasir meminta diskon, pembatalan, refund, atau kas keluar. Bukan PIN untuk masuk."}
      >
        <label>
          PIN baru (6 angka)
          <input
            type="text"
            className="pin-field"
            inputMode="numeric"
            autoComplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          />
        </label>
        <label>
          Ulangi PIN
          <input
            type="text"
            className="pin-field"
            inputMode="numeric"
            autoComplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
            maxLength={6}
            value={pinAgain}
            onChange={(e) => setPinAgain(e.target.value.replace(/\D/g, ""))}
          />
        </label>
        <p className="small muted">
          {pinKind === "login"
            ? "Hindari angka kembar dan urutan seperti 123456. Email dan PIN ini juga dipakai untuk masuk di laptop."
            : "Jangan beri tahu kasir. Server hanya menyimpan sidik PIN, dan lima PIN salah dalam 15 menit menghentikan persetujuan sementara."}
        </p>
        <Button
          className="full"
          loading={busy}
          disabled={busy || pin.length !== 6 || pin !== pinAgain}
          onClick={() =>
            act(async () => {
              if (pinKind === "approve") await commands.setPin(pin);
              else {
                if (/^(\d)\1{5}$/.test(pin) || ["123456", "654321", "012345", "123123"].includes(pin)) throw new Error("PIN terlalu mudah ditebak: hindari angka kembar dan urutan seperti 123456");
                const { error } = await supabase!.auth.updateUser({ password: pin });
                if (error) throw new Error(error.message);
                // Staff unlock the idle lock offline with this PIN; owners and managers keep no hash on a shared device.
                try { if (!can(user.role, "approve")) localStorage.setItem("takar-pin-hash", await pinHash(pin, user.id)); } catch { /* private mode */ }
              }
              setPinDialog(false);
            }, pinKind === "login" ? "PIN masuk tersimpan. Pakai di layar masuk tablet." : "PIN persetujuan tersimpan")
          }
        >
          Simpan PIN
        </Button>
      </Dialog>
      <Dialog open={Boolean(removing)} onOpenChange={() => setRemoving(undefined)} title={`Hapus ${removing?.name ?? "menu"}?`} description="Untuk menu yang belum pernah terjual, misalnya hasil impor uji coba.">
        <p>Menu, foto, resep, dan semua versinya dihapus dari semua perangkat. Tidak bisa dibatalkan. Menu yang sudah terjual tidak bisa dihapus; nonaktifkan lewat Edit agar struk dan laporannya tetap utuh.</p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setRemoving(undefined)}>Batal</Button>
          <Button variant="destructive" loading={busy} disabled={busy} onClick={() => removing && void act(async () => { await commands.removeMenu([removing.id]); setRemoving(undefined); }, `${removing?.name} dihapus`)}>Hapus menu</Button>
        </div>
      </Dialog>
      <Dialog open={signout} onOpenChange={setSignout} title="Keluar akun?">
        {blockers === null ? (
          <p className="muted">Memeriksa sif, keranjang, dan sinkronisasi…</p>
        ) : blockers.length ? (
          <div className="close-missing">
            <strong>Belum bisa keluar:</strong>
            <ul>{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          </div>
        ) : (
          <p>Semua sudah tersinkron. Data di perangkat ini tetap tersimpan untuk akun Anda.</p>
        )}
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setSignout(false)}>
            Batal
          </Button>
          <Button variant="destructive" disabled={!blockers || blockers.length > 0} onClick={() => logout()}>
            Keluar akun
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={claim}
        onOpenChange={setClaim}
        title="Pindahkan kasir utama ke perangkat ini?"
        description="Transaksi operasional hanya berjalan di kasir utama."
      >
        <p className="callout">
          <AlertTriangle size={18} /> Sinkronkan perangkat lama terlebih dahulu:
          setelah dipindahkan, operasi yang belum terkirim dari sana ditolak
          server. Sif yang masih terbuka ikut pindah ke perangkat ini dan
          ditutup dari sini.
        </p>
        <Button
          className="full"
          loading={busy}
          onClick={() =>
            act(async () => {
              const { error } = await supabase!.rpc("enroll_device", {
                device_id: user.deviceId,
              });
              if (error) throw error;
              // "Primary" is cached from sign-in; refresh it (and the server's data) now rather
              // than asking for a sign-out in a toast that is gone before anyone reads it.
              localStorage.setItem(
                "meja-identity",
                JSON.stringify(await bootstrap(user.id, user.deviceId)),
              );
              location.reload();
            })
          }
        >
          Pindahkan kasir utama ke sini
        </Button>
      </Dialog>
      <Dialog open={testPrint} onOpenChange={setTestPrint} title="Tes printer">
        <div id="print-area" className="receipt-paper">
          <pre>{`${settings?.name}\nTES CETAK ${settings?.receiptWidth} mm\n12345678901234567890123456789012\nNasi goreng × 2\nTotal Rp50.000\nPeriksa margin dan keterbacaan.\nBukan transaksi penjualan.`}</pre>
        </div>
        <Button
          onClick={() =>
            act(async () => {
              await db.prints.add({
                id: uid(),
                orderId: "test",
                kind: "test",
                status: "requested",
                at: new Date().toISOString(),
                reprint: false,
                lineIds: [],
              });
              window.print();
            })
          }
        >
          <Printer size={17} /> Minta cetak tes
        </Button>
        <p className="small muted">
          <Check size={14} /> Catat hasil uji fisik di docs/HARDWARE.md.
        </p>
      </Dialog>
    </section>
  );
}
