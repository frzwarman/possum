import { useState } from "react";
import { Link, Navigate } from "@tanstack/react-router";
import { CookingPot } from "lucide-react";
import { useApp } from "../../app/context";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { convert, quantity, rupiah, when } from "../../domain/calculate";
import type { StockItem } from "../../domain/types";
// Cook a batch of something the menu uses (sambal, ayam ungkep, kaldu): its inputs leave stock and
// the actual yield enters it, so menu recipes can count portions instead of raw ingredients.
export default function Production() {
  const { stockItems, movements, settings, commands, act, busy, manager, setError, costs } = useApp();
  const [item, setItem] = useState<StockItem>();
  const [batches, setBatches] = useState("1");
  const [output, setOutput] = useState("");
  const [note, setNote] = useState("");
  if (!manager) return <Navigate to="/pos" />;
  const stock = (id: string) => stockItems.find((s) => s.id === id);
  const balance = (id: string) => movements.filter((m) => m.stockId === id).reduce((n, m) => n + m.qty, 0);
  const made = stockItems.filter((s) => s.production);
  const runs = movements
    .filter((m) => m.kind === "production" && m.qty > 0)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 30);
  const n = /^[1-9]\d{0,2}$/.test(batches) ? Number(batches) : 0;
  // Cost of one batch at each input's latest price (purchase, production or transfer); unknown if any input was never priced.
  const batchCost = (s: StockItem) =>
    s.production!.inputs.every((i) => costs.has(i.stockId)) ? Math.round(s.production!.inputs.reduce((sum, i) => sum + i.qty * costs.get(i.stockId)!, 0)) : undefined;
  const perUnit = (cost: number, qty: number, unit: string) => `${rupiah(Math.round((cost * 1000) / qty))}/${unit}`;
  const inputs = item?.production?.inputs.map((i) => ({ stockId: i.stockId, qty: i.qty * n })) ?? [];
  function open(s: StockItem) {
    setItem(s);
    setBatches("1");
    setOutput(String(s.production!.output / 1000));
    setNote("");
  }
  function save() {
    if (!item) return;
    try {
      const qty = convert(output, item.unit, item.unit);
      void act(async () => {
        await commands.produce(item.id, qty, inputs, note);
        setItem(undefined);
      }, "Produksi tercatat; stok diperbarui");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Hasil produksi tidak valid");
    }
  }
  return (
    <section className="page-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Dapur produksi</p>
          <h1>Produksi</h1>
          <p className="muted">Olah bahan mentah menjadi bahan siap pakai per batch.</p>
        </div>
        <CookingPot size={27} className="muted" />
      </div>
      <div className="stock-list">
        {made.map((s) => (
          <article className="stock-row" key={s.id}>
            <span className="stock-icon">
              <CookingPot size={21} />
            </span>
            <div className="stock-name">
              <h3>{s.name}</h3>
              <p className="small muted">
                1 batch: {s.production!.inputs.map((i) => `${stock(i.stockId)?.name} ${quantity(i.qty)} ${stock(i.stockId)?.unit}`).join(", ")} →{" "}
                {quantity(s.production!.output)} {s.unit}
              </p>
              <p className="small muted">
                {batchCost(s) === undefined
                  ? "Biaya per batch: harga sebagian bahan belum tercatat"
                  : `Biaya per batch ≈ ${rupiah(batchCost(s)!)} · ${perUnit(batchCost(s)!, s.production!.output, s.unit)}`}
              </p>
            </div>
            <div className="stock-quantity">
              <strong>{quantity(balance(s.id))}</strong>
              <span>{s.unit}</span>
            </div>
            <div className="button-row">
              <Button variant="secondary" onClick={() => open(s)}>
                Catat produksi
              </Button>
            </div>
          </article>
        ))}
      </div>
      {!made.length && (
        <div className="empty-state">
          <CookingPot size={42} strokeWidth={1.3} />
          <h2>Belum ada bahan yang dibuat sendiri</h2>
          <p>Buka Lainnya → Daftar bahan, pilih bahan seperti sambal, lalu isi resep produksinya.</p>
          <Button asChild variant="secondary">
            <Link to="/settings">Ke Daftar bahan</Link>
          </Button>
        </div>
      )}
      <article className="panel mt">
        <div className="panel-heading">
          <h2>Riwayat produksi</h2>
          <span className="badge">{runs.length}</span>
        </div>
        {runs.length ? (
          <div className="history-list">
            {runs.map((m) => (
              <div key={m.id}>
                <span>
                  <strong>{m.reason}</strong>
                  <br />
                  <small className="muted">
                    {when(m.at, settings?.timezone)}
                    {m.cost > 0 && ` · biaya ${rupiah(m.cost)} (${perUnit(m.cost, m.qty, stock(m.stockId)?.unit ?? "")})`}
                  </small>
                </span>
                <b className="positive">
                  +{quantity(m.qty)} {stock(m.stockId)?.unit}
                </b>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">Produksi yang dicatat di perangkat ini muncul di sini.</p>
        )}
      </article>
      <Dialog open={Boolean(item)} onOpenChange={() => setItem(undefined)} title={`Produksi ${item?.name ?? ""}`}>
        {item && (
          <>
            <label>
              Jumlah batch
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={999}
                value={batches}
                onChange={(e) => {
                  setBatches(e.target.value);
                  if (/^[1-9]\d{0,2}$/.test(e.target.value)) setOutput(String((item.production!.output * Number(e.target.value)) / 1000));
                }}
              />
            </label>
            <h3 className="mt">Bahan terpakai</h3>
            {inputs.map((i) => (
              <div className="bill-row" key={i.stockId}>
                <span>{stock(i.stockId)?.name}</span>
                <span className={balance(i.stockId) < i.qty ? "negative" : undefined}>
                  {quantity(i.qty)} {stock(i.stockId)?.unit} · sisa {quantity(balance(i.stockId) - i.qty)}
                </span>
              </div>
            ))}
            {batchCost(item) !== undefined && n > 0 && (
              <p className="small muted">Perkiraan biaya {rupiah(batchCost(item)! * n)}, dari harga beli terakhir tiap bahan.</p>
            )}
            <label className="mt">
              Hasil sebenarnya ({item.unit})
              <input inputMode="decimal" value={output} onChange={(e) => setOutput(e.target.value)} />
            </label>
            <label>
              Catatan (opsional)
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Contoh: dimasak Bu Rini" />
            </label>
            <Button className="full" loading={busy} disabled={busy || !n || !output} onClick={save}>
              Simpan produksi
            </Button>
          </>
        )}
      </Dialog>
    </section>
  );
}
