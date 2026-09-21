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
import type { Ingredient, MenuItem, StockItem } from "../../domain/types";
import { convert, rupiah } from "../../domain/calculate";
import { supabase } from "../../lib/supabase";
import { compressMenuPhoto } from "../../lib/menu-photo";
const schema = z.object({
  appName: z.string().min(1).max(30),
  name: z.string().min(1).max(100),
  address: z.string().max(200),
  phone: z.string().max(40),
  footer: z.string().max(150),
  timezone: z.string().refine((v) => {
    try {
      new Intl.DateTimeFormat("id", { timeZone: v });
      return true;
    } catch {
      return false;
    }
  }, "Zona waktu tidak valid"),
  cutoff: z.coerce.number<number>().int().min(0).max(23),
  taxBps: z.coerce.number<number>().int().min(0).max(10000),
  serviceBps: z.coerce.number<number>().int().min(0).max(10000),
  goLive: z.string().min(10),
  printableWidth: z.coerce.number<number>().min(32).max(76),
});
export default function SettingsPage() {
  const {
    settings,
    menu,
    stockItems,
    db,
    commands,
    user,
    manager,
    act,
    outbox,
    sync,
    setNotice,
    setError,
    busy,
  } = useApp();
  const [tab, setTab] = useState("restaurant");
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
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    values: settings,
  });
  const errors = form.formState.errors;
  async function saveSettings(values: z.infer<typeof schema>) {
    if (!settings) return;
    if (values.printableWidth > width - 4) {
      setError("Lebar area cetak harus lebih kecil dari lebar kertas");
      return;
    }
    await act(
      () => commands.settings({ ...settings, ...values, receiptWidth: width }),
      "Pengaturan tersimpan",
    );
  }
  function template() {
    download(
      `meja-template-${importType}.csv`,
      importType === "menu"
        ? csv([
            ["name", "category", "price"],
            ["Nasi kuning", "Makanan", 18000],
          ])
        : csv([
            ["name", "unit", "quantity", "threshold"],
            ["Beras", "g", 10000, 2000],
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
  async function applyImport() {
    await act(async () => {
      if (importErrors.length || !preview.length)
        throw new Error("Perbaiki CSV dahulu");
      if (importType === "menu") {
        const added = preview.map((r) => ({
          id: uid(),
          name: r.name,
          category: r.category,
          price: Number(r.price),
          active: true,
          soldOut: false,
          favorite: false,
          version: 1,
          modifiers: [],
          recipe: [],
        }));
        await commands.publish([...menu, ...added], stockItems);
      } else {
        const added = preview.map((r) => ({
          id: uid(),
          name: r.name,
          unit: r.unit as StockItem["unit"],
          threshold: Math.round(Number(r.threshold) * 1000),
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
        qty: convert(recipeQty, s.unit, s.unit),
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
          ...(manager
            ? [
                ["restaurant", "Restoran"],
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
      {manager && tab === "restaurant" && (
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
      {manager && tab === "menu" && (
        <article className="panel">
          <div className="panel-heading">
            <h2>Menu restoran</h2>
            <Button
              onClick={() =>
                setItem({
                  id: uid(),
                  name: "",
                  category: "Makanan",
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
                  {m.category} · {rupiah(m.price)} ·{" "}
                  {m.photo ? "Dengan foto" : "Gambar standar"} ·{" "}
                  {m.recipe.length ? "Resep dipantau" : "Stok tidak dipantau"} ·
                  v{m.version}
                </p>
              </div>
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
      {manager && tab === "stock" && (
        <article className="panel">
          <div className="panel-heading">
            <h2>Bahan dan satuan dasar</h2>
            <Button
              onClick={() =>
                setStock({ id: uid(), name: "", unit: "pcs", threshold: 0 })
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
                  {s.unit} · Batas minimum {s.threshold / 1000}
                </p>
              </div>
              <Button variant="secondary" onClick={() => setStock({ ...s })}>
                Edit
              </Button>
            </div>
          ))}
        </article>
      )}
      {manager && tab === "import" && (
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
                onClick={() => void applyImport()}
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
                      {new Date(o.occurredAt).toLocaleString("id-ID")} ·{" "}
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
              {user.primary ? "Kasir utama" : "Dashboard / administrasi"}
            </p>
            {user.role === "owner" ? (
              <>
                {!user.primary && !user.demo && (
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
            {user.role === "owner"
              ? "Pemilik"
              : user.role === "manager"
                ? "Manajer"
                : "Kasir"}{" "}
            · {user.demo ? "Demo lokal" : "Akun restoran"}
          </p>
        </div>
        <div className="account-actions">
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
              <label>
                Kategori
                <input
                  value={item.category}
                  onChange={(e) =>
                    setItem({ ...item, category: e.target.value })
                  }
                />
              </label>
              <label>
                Harga
                <Money
                  value={String(item.price)}
                  onChange={(v) => setItem({ ...item, price: Number(v || 0) })}
                />
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
                  {r.qty / 1000}{" "}
                  {stockItems.find((s) => s.id === r.stockId)?.unit}
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
                Jumlah satuan dasar
                <input
                  inputMode="decimal"
                  value={recipeQty}
                  onChange={(e) => setRecipeQty(e.target.value)}
                />
              </label>
            </div>
            <Button variant="secondary" onClick={addRecipe}>
              Tambah bahan resep
            </Button>
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
                <Select
                  label="Bahan tambahan (1 satuan dasar)"
                  value={m.recipe[0]?.stockId || ""}
                  onChange={(value) =>
                    setItem({
                      ...item,
                      modifiers: item.modifiers.map((mod, j) =>
                        j === i
                          ? {
                              ...mod,
                              recipe: value
                                ? [{ stockId: value, qty: 1000 }]
                                : [],
                            }
                          : mod,
                      ),
                    })
                  }
                  options={[
                    { value: "", label: "Tidak dipantau" },
                    ...stockItems.map((s) => ({
                      value: s.id,
                      label: `${s.name} (${s.unit})`,
                    })),
                  ]}
                />
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
            <Button
              className="full mt"
              loading={busy}
              disabled={busy || !item.name || !item.category}
              onClick={() =>
                void act(async () => {
                  if (!Number.isInteger(item.price) || item.price < 0)
                    throw new Error("Harga tidak valid");
                  await commands.publish(
                    [
                      ...menu.filter((m) => m.id !== item.id),
                      { ...item, version: item.version + 1 },
                    ],
                    stockItems,
                  );
                  setItem(undefined);
                }, "Versi menu tersimpan; struk lama tidak berubah")
              }
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
            <label>
              Batas stok minimum
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
              setClaim(false);
              setNotice(
                "Kasir utama pindah ke perangkat ini. Keluar dan masuk kembali.",
              );
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
