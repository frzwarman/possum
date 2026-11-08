import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Download,
  RefreshCw,
  Printer,
  ShieldCheck,
  Plus,
  Settings2,
  LogOut,
  Check,
  Upload,
  AlertTriangle,
  Database,
  UserCog,
  Image as ImageIcon,
  Trash2,
  KeyRound,
} from "lucide-react";
import { useApp, logout } from "../../app/context";
import { Button } from "../../components/ui/button";
import { Money } from "../../components/ui/money";
import { Select } from "../../components/ui/select";
import { Dialog } from "../../components/ui/dialog";
import { csv, download, exportData, uid } from "../../lib/db";
import {
  parseCSV,
  menuImportSchema,
  stockImportSchema,
} from "../../lib/import";
import type { Ingredient, MenuItem, MenuType, OptionGroup, Pack, Station, StockItem } from "../../domain/types";
import { convert, describeDelta, itemStation, menuType, quantity, rupiah, typeLabel, when } from "../../domain/calculate";
import { can } from "../../domain/permissions";
import { ApprovalDialog, type ApprovalRequest } from "../../app/Approval";
import { supabase } from "../../lib/supabase";
import { compressMenuPhoto } from "../../lib/menu-photo";
import { bootstrap } from "../auth/Login";
import { roleTitle } from "../../domain/permissions";
const schema = z.object({
  appName: z.string().min(1).max(30),
  name: z.string().min(1).max(100),
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
  kitchenTarget: z.coerce.number<number>().int().min(1).max(600),
  barTarget: z.coerce.number<number>().int().min(1).max(600),
  varianceLimit: z.coerce.number<number>().int().min(0).max(1000000000),
  lowAt: z.coerce.number<number>().int().min(0).max(999),
});
const SIGNS = [{ value: "add", label: "tambah" }, { value: "remove", label: "kurangi / ganti" }];
const KINDS: [OptionGroup["kind"], string][] = [["add", "Tambahan (boleh beberapa)"], ["swap", "Ganti (pilih satu)"], ["level", "Tingkat (pilih satu)"], ["size", "Ukuran (pilih satu)"]];
const words = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
export default function SettingsPage() {
  const {
    settings,
    menu,
    stockItems,
    db,
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
  } = useApp();
  // Owner and manager tune the restaurant; chef and admin keep menu and ingredients; everyone has sync and device.
  const tillLocked = user.primary && Boolean(shift);
  const settingsRole = can(user.role, "settings") && !tillLocked, catalogRole = can(user.role, "catalog") && !tillLocked;
  const [tab, setTab] = useState(settingsRole ? "restaurant" : catalogRole ? "menu" : "sync");
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
  const [recipeStock, setRecipeStock] = useState("");
  const [recipeQty, setRecipeQty] = useState("");
  const [signout, setSignout] = useState(false);
  const [claim, setClaim] = useState(false);
  const [testPrint, setTestPrint] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [pinDialog, setPinDialog] = useState(false);
  const [bomStock, setBomStock] = useState("");
  const [bomQty, setBomQty] = useState("");
  const [pin, setPin] = useState("");
  const [pinAgain, setPinAgain] = useState("");
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    values: settings && { ...settings, stationTablets: Boolean(settings.stationTablets), kitchenTarget: settings.stations?.kitchen ?? 15, barTarget: settings.stations?.bar ?? 8, varianceLimit: settings.varianceLimit ?? 10000, lowAt: settings.lowAt ?? 5 },
  });
  const errors = form.formState.errors;
  async function saveSettings(values: z.infer<typeof schema>) {
    if (!settings) return;
    if (values.printableWidth > width - 4) {
      setError("Lebar area cetak harus lebih kecil dari lebar kertas");
      return;
    }
    const { kitchenTarget, barTarget, varianceLimit, lowAt, stationTablets, ...rest } = values;
    await act(
      () => commands.settings({ ...settings, ...rest, receiptWidth: width, stations: { kitchen: kitchenTarget, bar: barTarget }, varianceLimit, lowAt, stationTablets }),
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
      if (file.size > 200000) throw new Error("CSV maksimal 200 KB");
      const rows = parseCSV(await file.text());
      const errs: string[] = [];
      rows.forEach((r, i) => {
        const parsed = (
          importType === "menu" ? menuImportSchema : stockImportSchema
        ).safeParse(r);
        if (!parsed.success)
          errs.push(
            `Baris ${i + 2}: ${parsed.error.issues.map((x) => x.path.join(".") + " " + x.message).join("; ")}`,
          );
      });
      if (new Set(rows.map((r) => r.name.toLowerCase())).size !== rows.length)
        errs.push("Nama duplikat dalam impor");
      if (
        rows.some((r) =>
          (importType === "menu" ? menu : stockItems).some(
            (m) => m.name.toLowerCase() === r.name.toLowerCase(),
          ),
        )
      )
        errs.push(
          "Nama sudah ada. Edit menu/bahan yang ada; impor hanya menambah.",
        );
      setPreview(rows);
      setImportErrors(errs);
    } catch (e) {
      setImportErrors([String(e)]);
      setPreview([]);
    }
  }
  async function applyImport(approval?: import("../../domain/types").Approval) {
    await act(async () => {
      if (importErrors.length || !preview.length)
        throw new Error("Perbaiki CSV dahulu");
      if (importType === "menu") {
        const added = preview.map((r) => {
          const parsed = menuImportSchema.parse(r);
          return {
            id: uid(),
            name: r.name,
            category: typeLabel[parsed.type],
            type: parsed.type,
            station: itemStation({ type: parsed.type, category: "" }),
            tags: [],
            aliases: [],
            groups: [],
            lowAt: settings?.lowAt ?? 5,
            price: Number(r.price),
            active: true,
            soldOut: false,
            favorite: false,
            version: 1,
            modifiers: [],
            recipe: [],
          };
        });
        await commands.publish([...menu, ...added], stockItems, approval);
      } else {
        const added = preview.map((r) => ({
          id: uid(),
          name: r.name,
          unit: r.unit as StockItem["unit"],
          threshold: convert(r.threshold || "0", r.unit, r.unit) || 0,
          area: r.area || "",
          aliases: [],
          packs: r.pack_name ? [{ name: r.pack_name, qty: convert(r.pack_qty, r.unit, r.unit) }] : [],
        }));
        await commands.publish(menu, [...stockItems, ...added]);
        for (let i = 0; i < added.length; i++)
          if (Number(preview[i].quantity) > 0)
            await commands.stockRecord(
              added[i].id,
              "opening",
              convert(preview[i].quantity, added[i].unit, added[i].unit),
              "Impor saldo awal",
            );
      }
      setPreview([]);
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
        recipe: [...item.recipe.filter((x) => x.stockId !== s.id), r],
      });
      setRecipeQty("");
    } catch (e) {
      setError(String(e));
    }
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
  return (
    <section className="page-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Dibuat sesuai warung Anda</p>
          <h1>Lainnya</h1>
          <p className="muted">Pengaturan, sinkronisasi, dan penjagaan data.</p>
        </div>
        <Settings2 className="muted" />
      </div>
      <div className="category-tabs">
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
          ["printer", "Printer & perangkat"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {settingsRole && tab === "restaurant" && (
        <div className="settings-columns">
          <form className="panel" onSubmit={form.handleSubmit(saveSettings)}>
            <h2>Identitas restoran</h2>
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
            <div className="form-grid">
              <label>
                Selisih kas tanpa PIN (Rp)
                <input type="number" {...form.register("varianceLimit")} />
              </label>
              <label>
                "Hampir habis" di bawah (porsi)
                <input type="number" {...form.register("lowAt")} />
              </label>
            </div>
            <p className="small muted">
              Tiket berubah merah setelah target stasiun. Kasir menutup sif tanpa PIN selama selisihnya di bawah batas.
            </p>
            {Object.entries(errors).map(([key, e]) => (
              <p className="error" key={key}>
                {key}: {e?.message}
              </p>
            ))}
            <Button loading={busy} disabled={busy}>
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
        <article className="panel">
          <div className="panel-heading">
            <h2>Menu restoran</h2>
            <Button
              onClick={() =>
                setItem({
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
              <Plus size={17} /> Tambah menu
            </Button>
          </div>
          {menu.map((m) => (
            <div className="admin-row" key={m.id}>
              <img
                className="admin-menu-thumb"
                src={m.photo || "/menu-placeholder.svg"}
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
              {!m.recipe.length && m.active && <span className="badge badge-warning">Belum ada resep</span>}
              <span className="badge">
                {!m.active ? "Nonaktif" : m.soldOut ? "Habis" : "Aktif"}
              </span>
              <Button
                variant="secondary"
                onClick={() => setItem(structuredClone(m))}
              >
                Edit
              </Button>
            </div>
          ))}
        </article>
      )}
      {catalogRole && tab === "stock" && (
        <article className="panel">
          <div className="panel-heading">
            <h2>Bahan dan satuan dasar</h2>
            <Button
              onClick={() =>
                setStock({ id: uid(), name: "", unit: "pcs", threshold: 0, aliases: [], area: "", packs: [] })
              }
            >
              <Plus size={17} /> Tambah bahan
            </Button>
          </div>
          {stockItems.map((s) => (
            <div className="admin-row" key={s.id}>
              <div>
                <strong>{s.name}</strong>
                <p className="small muted">
                  {s.unit} · par {quantity(s.threshold)} {s.unit}{s.area ? ` · ${s.area}` : ""}
                  {s.packs?.length ? ` · ${s.packs.map((pk) => `1 ${pk.name} = ${quantity(pk.qty)} ${s.unit}`).join(", ")}` : ""}
                  {s.production ? " · bahan olahan" : ""}
                </p>
              </div>
              <Button variant="secondary" onClick={() => setStock({ ...s })}>
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
            Tambahkan data dari template. Tidak mengubah data yang sudah ada.
          </p>
          <Select
            label="Jenis data"
            value={importType}
            onChange={(v) => {
              setImportType(v as typeof importType);
              setPreview([]);
              setImportErrors([]);
            }}
            options={[
              { value: "menu", label: "Menu" },
              { value: "stock", label: "Bahan & saldo awal" },
            ]}
          />
          <Button variant="secondary" onClick={template}>
            <Download size={16} /> Unduh template CSV
          </Button>
          <label className="upload-label">
            <Upload size={20} /> Pilih berkas CSV
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) =>
                e.target.files?.[0] && void readFile(e.target.files[0])
              }
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
              <div className="import-preview">
                {preview.map((r, i) => (
                  <div key={i}>{Object.values(r).join(" · ")}</div>
                ))}
              </div>
              <Button
                loading={busy}
                disabled={busy || importErrors.length > 0}
                onClick={() => (!manager && importType === "menu" ? setAsk({ action: "publish", what: `Impor ${preview.length} menu tanpa resep` }) : void applyImport())}
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
                  void act(
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
                    {o.state === "rejected" && manager && (
                      <Button
                        variant="secondary"
                        onClick={() =>
                          void act(async () => {
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
                          void act(async () => {
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
              <Database size={25} />
              <h2>Ekspor & pemulihan</h2>
              <p className="muted">
                Ekspor tidak menyertakan token, kata sandi, atau kunci rahasia.
              </p>
              <div className="button-stack">
                <Button
                  variant="secondary"
                  onClick={() =>
                    void act(async () =>
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
                    void act(async () =>
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
      {tab === "printer" && (
        <div className="settings-columns">
          <article className="panel">
            <Printer size={25} />
            <h2>Printer browser / sistem</h2>
            <p className="muted">
              Cetak dipicu oleh operator. Dialog browser tidak membuktikan
              kertas tercetak.
            </p>
            <p className="badge badge-warning">
              Printer fisik belum diverifikasi
            </p>
            <Button
              className="full mt"
              variant="secondary"
              onClick={() => setTestPrint(true)}
            >
              Buka tes cetak {settings?.receiptWidth} mm
            </Button>
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
          </article>
          <article className="panel">
            <ShieldCheck size={25} />
            <h2>Penyimpanan perangkat</h2>
            <p className="muted">{storage}</p>
            <Button
              variant="secondary"
              onClick={() =>
                void act(async () => {
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
            <p className="small">
              Perangkat:{" "}
              {user.primary ? "Kasir utama" : user.mode === "station" ? "Stasiun (dapur / bar)" : user.mode === "office" ? "Back office" : "Belum dipasangkan (hanya membaca)"}
            </p>
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
                      void act(async () => {
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
        </div>
      )}
      <div className="account-footer">
        <span className="avatar">{user.name.slice(0, 1)}</span>
        <div className="account-id">
          <strong>{user.name}</strong>
          <p className="muted small">
            {roleTitle[user.role]} · {user.demo ? "Demo lokal" : "Akun restoran"}
          </p>
        </div>
        <div className="account-actions">
          {manager && !user.demo && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setPin("");
                setPinAgain("");
                setPinDialog(true);
              }}
            >
              <KeyRound size={16} /> PIN persetujuan
            </Button>
          )}
          {user.role === "owner" && (
            <Button asChild variant="secondary" size="sm">
              <a href="/admin">
                <UserCog size={16} /> Akun staf
              </a>
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setSignout(true)}>
            <LogOut size={16} /> Keluar akun
          </Button>
        </div>
      </div>
      <Dialog
        open={Boolean(item)}
        onOpenChange={() => setItem(undefined)}
        title={item?.version ? "Edit menu" : "Tambah menu"}
      >
        {item && (
          <>
            <div className="menu-photo-editor">
              <img
                src={item.photo || "/menu-placeholder.svg"}
                alt="Pratinjau foto menu"
              />
              <div>
                <label className="photo-upload">
                  <ImageIcon size={18} />
                  {photoBusy
                    ? "Memperkecil foto…"
                    : item.photo
                      ? "Ganti foto"
                      : "Unggah foto (opsional)"}
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setItem({ ...item, photo: undefined })}
                  >
                    <Trash2 size={15} /> Pakai gambar standar
                  </Button>
                )}
                <p className="small muted">
                  JPG, PNG, atau WebP hingga 10 MB. Meja memperkecil foto untuk
                  penggunaan offline.
                </p>
              </div>
            </div>
            <label>
              Nama menu
              <input
                value={item.name}
                onChange={(e) => setItem({ ...item, name: e.target.value })}
              />
            </label>
            <div className="form-grid">
              <Select
                label="Jenis"
                value={menuType(item)}
                onChange={(v) => setItem({ ...item, type: v as MenuType, category: typeLabel[v as MenuType], station: v === "beverage" ? "bar" : "kitchen" })}
                options={(Object.keys(typeLabel) as MenuType[]).map((t) => ({ value: t, label: typeLabel[t] }))}
              />
              <label>
                Harga
                <Money
                  value={String(item.price)}
                  onChange={(v) => setItem({ ...item, price: Number(v || 0) })}
                />
              </label>
            </div>
            <div className="form-grid">
              <Select
                label="Stasiun"
                value={itemStation(item)}
                onChange={(v) => setItem({ ...item, station: v as Station })}
                options={[{ value: "kitchen", label: "Dapur" }, { value: "bar", label: "Bar" }]}
              />
              <label>
                "Hampir habis" di bawah (porsi)
                <input type="number" inputMode="numeric" value={item.lowAt ?? settings?.lowAt ?? 5} onChange={(e) => setItem({ ...item, lowAt: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
              </label>
            </div>
            <div className="form-grid">
              <label>
                Tag (pisahkan dengan koma)
                <input list="takar-tags" value={(item.tags ?? []).join(", ")} onChange={(e) => setItem({ ...item, tags: words(e.target.value) })} placeholder="Signature, Kopi" />
                <datalist id="takar-tags">{tags.map((t) => <option key={t} value={t} />)}</datalist>
              </label>
              <label>
                Nama lain untuk pencarian
                <input value={(item.aliases ?? []).join(", ")} onChange={(e) => setItem({ ...item, aliases: words(e.target.value) })} placeholder="americano panas, kopi hitam" />
              </label>
            </div>
            <div className="button-row">
              {(["active", "soldOut", "favorite"] as const).map((key) => (
                <label className="inline-check" key={key}>
                  <input
                    type="checkbox"
                    checked={item[key]}
                    onChange={(e) =>
                      setItem({ ...item, [key]: e.target.checked })
                    }
                  />
                  {key === "active"
                    ? "Aktif"
                    : key === "soldOut"
                      ? "Habis"
                      : "Favorit"}
                </label>
              ))}
              <label className="inline-check">
                <input type="checkbox" checked={Boolean(item.ignoreStock)} onChange={(e) => setItem({ ...item, ignoreStock: e.target.checked })} />
                Tetap jual walau bahan habis
              </label>
            </div>
            <h3 className="mt">Resep per porsi</h3>
            <p className="small muted">
              Kosong = tidak dilacak. Minuman botol: pilih bahan botol, jumlah
              1. Batch matang: lacak porsi, bukan asumsi hasil bahan mentah.
            </p>
            {item.recipe.map((r) => (
              <div className="bill-row" key={r.stockId}>
                <span>
                  {stockItems.find((s) => s.id === r.stockId)?.name}:{" "}
                  {quantity(r.qty)}{" "}
                  {stockItems.find((s) => s.id === r.stockId)?.unit}
                  {costs.has(r.stockId) && <small className="muted"> · {rupiah(Math.round(r.qty * costs.get(r.stockId)!))}</small>}
                </span>
                <button
                  className="text-button"
                  onClick={() =>
                    setItem({
                      ...item,
                      recipe: item.recipe.filter(
                        (x) => x.stockId !== r.stockId,
                      ),
                    })
                  }
                >
                  Hapus
                </button>
              </div>
            ))}
            <div className="form-grid">
              <Select
                label="Bahan"
                value={recipeStock}
                onChange={setRecipeStock}
                options={[
                  { value: "", label: "Pilih bahan" },
                  ...stockItems.map((s) => ({
                    value: s.id,
                    label: `${s.name} (${s.unit})`,
                  })),
                ]}
              />
              <label>
                Jumlah
                <input
                  inputMode="decimal"
                  value={recipeQty}
                  onChange={(e) => setRecipeQty(e.target.value)}
                />
              </label>
            </div>
            <Select label="Satuan" value={recipeUnit || stockItems.find((s) => s.id === recipeStock)?.unit || ""} onChange={setRecipeUnit} options={unitsFor(stockItems.find((s) => s.id === recipeStock))} />
            <Button variant="secondary" onClick={addRecipe}>
              Tambah bahan resep
            </Button>
            <p className="callout">
              {recipeCost(item.recipe) === undefined
                ? "Biaya bahan belum lengkap: harga sebagian bahan belum pernah tercatat."
                : `Biaya bahan ${rupiah(recipeCost(item.recipe)!)} · margin ${rupiah(item.price - recipeCost(item.recipe)!)} · food cost ${item.price ? Math.round((recipeCost(item.recipe)! / item.price) * 100) : 0}%`}
            </p>
            <h3 className="mt">Grup pilihan</h3>
            <p className="small muted">Ukuran, susu, gula, tambahan. Pilihan "ganti" dan "tingkat" mengurangi bahan dasar, "tambahan" menambah.</p>
            {(item.groups ?? []).map((g, gi) => (
              <div className="form-grid" key={g.id}>
                <label>
                  Nama grup
                  <input value={g.name} onChange={(e) => setItem({ ...item, groups: item.groups!.map((x, j) => (j === gi ? { ...x, name: e.target.value } : x)) })} />
                </label>
                <Select label="Jenis grup" value={g.kind} onChange={(v) => setItem({ ...item, groups: item.groups!.map((x, j) => (j === gi ? { ...x, kind: v as OptionGroup["kind"], required: v !== "add" } : x)) })} options={KINDS.map(([value, label]) => ({ value, label }))} />
                <button className="text-button" onClick={() => setItem({ ...item, groups: item.groups!.filter((_, j) => j !== gi), modifiers: item.modifiers.map((m) => (m.group === g.id ? { ...m, group: undefined } : m)) })}>Hapus grup</button>
              </div>
            ))}
            <Button variant="secondary" onClick={() => setItem({ ...item, groups: [...(item.groups ?? []), { id: uid(), name: "", kind: "add" }] })}>Tambah grup pilihan</Button>
            <h3 className="mt">Tambahan</h3>
            {item.modifiers.map((m, i) => (
              <div className="modifier-editor" key={m.id}>
                <label>
                  Nama tambahan
                  <input
                    value={m.name}
                    onChange={(e) =>
                      setItem({
                        ...item,
                        modifiers: item.modifiers.map((v, j) =>
                          j === i ? { ...v, name: e.target.value } : v,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  Harga tambahan
                  <Money
                    value={String(m.price)}
                    onChange={(value) =>
                      setItem({
                        ...item,
                        modifiers: item.modifiers.map((mod, j) =>
                          j === i ? { ...mod, price: Number(value || 0) } : mod,
                        ),
                      })
                    }
                  />
                </label>
                {(item.groups ?? []).length > 0 && (
                  <Select
                    label="Grup"
                    value={m.group ?? ""}
                    onChange={(value) => setItem({ ...item, modifiers: item.modifiers.map((mod, j) => (j === i ? { ...mod, group: value || undefined } : mod)) })}
                    options={[{ value: "", label: "Tanpa grup (tambahan lepas)" }, ...(item.groups ?? []).map((g) => ({ value: g.id, label: g.name || "(grup tanpa nama)" }))]}
                  />
                )}
                {m.group && item.groups?.find((g) => g.id === m.group)?.kind !== "add" && (
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
                    <Select label="Bahan" value={effect.stockId} onChange={(v) => setEffect({ ...effect, stockId: v, unit: stockItems.find((s) => s.id === v)?.unit ?? "" })} options={[{ value: "", label: "Pilih bahan" }, ...stockItems.map((s) => ({ value: s.id, label: `${s.name} (${s.unit})` }))]} />
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
                <button
                  className="text-button"
                  onClick={() =>
                    setItem({
                      ...item,
                      modifiers: item.modifiers.filter((_, j) => j !== i),
                    })
                  }
                >
                  Hapus tambahan
                </button>
              </div>
            ))}
            <Button
              className="mt"
              variant="secondary"
              onClick={() =>
                setItem({
                  ...item,
                  modifiers: [
                    ...item.modifiers,
                    { id: uid(), name: "", price: 0, recipe: [] },
                  ],
                })
              }
            >
              Tambah pilihan
            </Button>
            {item.active && !item.recipe.length && (
              <p className="callout">
                <AlertTriangle size={18} /> Menu aktif tanpa resep tidak memotong stok. {manager ? "" : "Menerbitkannya perlu PIN manajer."}
              </p>
            )}
            <Button
              className="full mt"
              loading={busy}
              disabled={busy || !item.name}
              onClick={() => void saveItem()}
            >
              Simpan versi menu
            </Button>
          </>
        )}
      </Dialog>
      <Dialog
        open={Boolean(stock)}
        onOpenChange={() => setStock(undefined)}
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
                  <Select
                    label="Bahan per batch"
                    value={bomStock}
                    onChange={setBomStock}
                    options={[
                      { value: "", label: "Pilih bahan" },
                      ...stockItems
                        .filter((x) => x.id !== stock.id)
                        .map((x) => ({ value: x.id, label: `${x.name} (${x.unit})` })),
                    ]}
                  />
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
                void act(async () => {
                  await commands.publish(menu, [
                    ...stockItems.filter((s) => s.id !== stock.id),
                    stock,
                  ]);
                  setStock(undefined);
                }, "Bahan tersimpan")
              }
            >
              Simpan bahan
            </Button>
          </>
        )}
      </Dialog>
      <ApprovalDialog request={ask} onClose={() => setAsk(undefined)} onApproved={(a) => { setAsk(undefined); if (item) void saveItem(a); else void applyImport(a); }} />
      <Dialog
        open={pinDialog}
        onOpenChange={setPinDialog}
        title="PIN persetujuan"
        description="Dipakai saat kasir meminta diskon, pembatalan, refund, atau kas keluar."
      >
        <label>
          PIN baru (6 angka)
          <input
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          />
        </label>
        <label>
          Ulangi PIN
          <input
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={6}
            value={pinAgain}
            onChange={(e) => setPinAgain(e.target.value.replace(/\D/g, ""))}
          />
        </label>
        <p className="small muted">
          Jangan beri tahu kasir. Server hanya menyimpan sidik PIN, dan lima
          PIN salah dalam 15 menit menghentikan persetujuan sementara.
        </p>
        <Button
          className="full"
          loading={busy}
          disabled={busy || pin.length !== 6 || pin !== pinAgain}
          onClick={() =>
            void act(async () => {
              await commands.setPin(pin);
              setPinDialog(false);
            }, "PIN persetujuan tersimpan")
          }
        >
          Simpan PIN
        </Button>
      </Dialog>
      <Dialog open={signout} onOpenChange={setSignout} title="Keluar akun?">
        <p>
          Data perangkat dan {pending.length} operasi yang belum tersinkron
          tetap disimpan dan hanya terlihat saat akun yang sama masuk lagi.
          Ekspor pemulihan terlebih dahulu bila diperlukan.
        </p>
        <Button variant="destructive" onClick={() => void logout()}>
          Keluar tanpa menghapus data
        </Button>
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
            void act(async () => {
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
            void act(async () => {
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
