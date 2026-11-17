// Terima barang: scan what arrived, type the amount in the pack it came in and the price, photograph the nota,
// and put it into stock. Each line becomes the same stock.record the Stok page sends ("Terima kiriman"), so
// Takar's rules decide who may do this and the audit log shows it. No purchase order, no cash drawer.
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useRef, useState } from 'react';
import { BackHandler, Image, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { quantity, rupiah, search } from '../../../src/domain/calculate';
import { can } from '../../../src/domain/permissions';
import { lookup, normalizeCode } from '../../../src/stok/barcode';
import { flag, lineCost, lineQty, suggestedPrice, units } from '../../../src/stok/delivery';
import type { DeliveryLine, PhoneStock } from '../../../src/stok/types';
import { shrinkNote } from '../platform/photo';
import { useApp } from '../state';
import { nice, unitName } from '../ui/format';
import { ItemPicker } from '../ui/ItemPicker';
import { Button, Card, Chip, Field, Row, Screen, Sheet, T, styles as kit } from '../ui/kit';
import { Scanner } from '../ui/Scanner';
import { color, radius, space } from '../ui/theme';

const says = (e: unknown) => (e instanceof Error ? e.message : String(e));
// Thousandths of the base unit, or NaN while the amount does not parse.
const qtyOf = (item: PhoneStock, line: DeliveryLine) => {
  try {
    return lineQty(item, line);
  } catch {
    return NaN;
  }
};
const perOf = (item: PhoneStock, unit: string) => units(item).find((u) => u.name === unit)?.per ?? 1000;
// The usual delivery, as the web app works it out: the median of the last five.
const usualOf = (item: PhoneStock) => {
  const last = (item.usual ?? []).slice(-5).sort((a, b) => a - b);
  return last[Math.floor(last.length / 2)] ?? 0;
};

export function Receive({ back }: { back: () => void }) {
  const app = useApp();
  const delivery = app.delivery;
  const [query, setQuery] = useState('');
  const [unknown, setUnknown] = useState<string>();
  // The line in the sheet: a new one, or one from the list being changed.
  const [editing, setEditing] = useState<DeliveryLine>();
  const [shooting, setShooting] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const saved = useRef(false);

  // Android's back button closes the note camera before it leaves the delivery.
  useEffect(() => {
    if (!shooting) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setShooting(false);
      return true;
    });
    return () => sub.remove();
  }, [shooting]);

  const item = (id: string) => app.stock.find((s) => s.id === id);
  if (!app.identity || !can(app.identity.role, 'inventory')) {
    return (
      <Screen title="Terima barang" onBack={back}>
        <T>Hanya pemilik, manajer atau admin stok yang mencatat kiriman.</T>
      </Screen>
    );
  }

  // A bahan was scanned or picked: one already in the list opens for changing, a new one starts in the pack the
  // code is printed on (or its first unit) with the last price filled in.
  const arrive = (stock: PhoneStock, pack?: string) => {
    setQuery('');
    setProblem('');
    const unit = pack ?? units(stock)[0].name;
    setEditing(delivery.lines.find((l) => l.stockId === stock.id) ?? { id: app.newId(), stockId: stock.id, unit, amount: '', price: suggestedPrice(stock, unit) });
  };
  const onCode = (code: string) => {
    const hit = lookup(code, app.links, app.stock);
    if (hit) arrive(hit.item, hit.pack?.name);
    else setUnknown(code);
  };
  const submitQuery = () => {
    const code = normalizeCode(query);
    if (!code) return;
    if (lookup(code, app.links, app.stock)) onCode(code);
    else if (/^\d{6,}$/.test(code)) {
      setQuery('');
      setUnknown(code);
    }
  };
  const putLine = (line: DeliveryLine) => {
    const stock = item(line.stockId);
    if (!stock) return;
    try {
      if (lineQty(stock, line) <= 0) throw new Error('Isi jumlah yang datang');
    } catch (e) {
      setProblem(says(e));
      return;
    }
    setProblem('');
    app.setDelivery({ ...delivery, lines: delivery.lines.some((l) => l.id === line.id) ? delivery.lines.map((l) => (l.id === line.id ? line : l)) : [...delivery.lines, line] });
    setEditing(undefined);
  };
  const dropLine = (id: string) => {
    app.setDelivery({ ...delivery, lines: delivery.lines.filter((l) => l.id !== id) });
    setEditing(undefined);
  };
  const shot = async (uri: string) => {
    setShooting(false);
    setPhotoBusy(true);
    setProblem('');
    try {
      const photo = await shrinkNote(uri);
      app.setDelivery({ ...delivery, photo });
    } catch (e) {
      setProblem(says(e));
    } finally {
      setPhotoBusy(false);
    }
  };

  if (shooting) return <NoteCamera onShot={(uri) => void shot(uri)} onCancel={() => setShooting(false)} />;

  const rows = delivery.lines.flatMap((line) => {
    const stock = item(line.stockId);
    return stock ? [{ line, stock, qty: qtyOf(stock, line) }] : [];
  });
  const total = rows.reduce((sum, r) => sum + (Number.isNaN(r.qty) ? 0 : lineCost(r.stock, r.line)), 0);
  const found = query.trim() ? search(app.stock, query).slice(0, 8) : [];
  const editingStock = editing ? item(editing.stockId) : undefined;

  return (
    <Screen
      title="Terima barang" note="Tanpa PO, dibayar di luar laci kas" onBack={back}
      footer={
        <Button
          label={`Masukkan ke stok · ${rupiah(total)}`} kind="accent" disabled={rows.length === 0 || photoBusy}
          onPress={() => {
            // One delivery, one save: a second tap before the screen closes does nothing.
            if (saved.current) return;
            saved.current = app.saveDelivery();
            if (saved.current) back();
          }}
        />
      }
    >
      <Field
        label="Pemasok / nota" placeholder="Contoh: CV Susu Jaya, nota 1203" maxLength={100} value={delivery.note}
        onChangeText={(note) => app.setDelivery({ ...delivery, note })}
      />
      {delivery.photo ? (
        <View style={local.inline}>
          <Image source={{ uri: delivery.photo }} style={local.thumb} accessibilityLabel="Foto nota" />
          <T tone="small" style={kit.grow}>Foto nota terlampir.</T>
          <Button label="Ganti" kind="secondary" small onPress={() => setShooting(true)} />
          <Button label="Hapus" kind="ghost" small onPress={() => app.setDelivery({ ...delivery, photo: undefined })} />
        </View>
      ) : (
        <Button label={photoBusy ? 'Memperkecil foto…' : 'Foto nota (opsional)'} kind="secondary" loading={photoBusy} onPress={() => setShooting(true)} />
      )}

      <Scanner active={!editing && !unknown} onCode={onCode} />
      <Field
        label="Ketik kode atau cari nama bahan" value={query} onChangeText={setQuery} onSubmitEditing={submitQuery}
        returnKeyType="search" autoCorrect={false} autoCapitalize="none" placeholder="8991002101234 atau susu"
      />
      {found.length > 0 ? (
        <View style={local.section}>
          {found.map((s) => (
            <Row key={s.id} title={s.name} note={s.area} right={<T tone="strong">+</T>} onPress={() => arrive(s)} />
          ))}
        </View>
      ) : null}
      {query.trim() && found.length === 0 ? <T tone="small">Tidak ada bahan dengan nama itu.</T> : null}

      {rows.length > 0 ? (
        <View style={local.section}>
          <T tone="label">Yang datang ({rows.length})</T>
          {rows.map(({ line, stock, qty }) => {
            const verdict = flag(stock, line);
            const per = perOf(stock, line.unit);
            const usual = usualOf(stock);
            const typed = `${line.amount} ${unitName(line.unit)}`;
            const normal = `${quantity((usual * 1000) / per)} ${unitName(line.unit)}`;
            return (
              <View key={line.id} style={local.section}>
                <Row
                  title={stock.name}
                  note={Number.isNaN(qty) ? 'Jumlah tidak valid' : `${typed}${per === 1000 ? '' : ` = ${nice(qty, stock.unit)}`}`}
                  right={<T tone="strong">{line.price.trim() ? rupiah(lineCost(stock, line)) : 'Tanpa harga'}</T>}
                  onPress={() => setEditing(line)} tone={verdict ? 'warning' : undefined}
                />
                {verdict ? (
                  <Card style={{ backgroundColor: color.warningBg, borderColor: color.warningFg }}>
                    <T style={{ color: color.warningFg }} accessibilityRole="alert">
                      {verdict === 'high' ? `${typed} itu ${Math.round(qty / usual)}× kiriman biasa (${normal}).` : `${typed} jauh di bawah kiriman biasa (${normal}).`} Cek nota: satuan dan jumlahnya.
                    </T>
                    <View style={local.inline}>
                      <Button label="Ubah" kind="secondary" small style={kit.grow} onPress={() => setEditing(line)} />
                      <Button
                        label={`Ya, ${line.amount} benar`} kind="primary" small style={kit.grow}
                        onPress={() => app.setDelivery({ ...delivery, lines: delivery.lines.map((l) => (l.id === line.id ? { ...l, checked: l.amount } : l)) })}
                      />
                    </View>
                  </Card>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : (
        <T tone="small">Pindai barang yang datang, atau cari namanya. Setiap bahan menjadi satu baris.</T>
      )}
      {problem && !editing ? <T style={{ color: color.criticalFg }}>{problem}</T> : null}

      <Sheet visible={Boolean(editing && editingStock)} onClose={() => setEditing(undefined)} title={editingStock?.name ?? ''}>
        {editing && editingStock ? (
          <LineForm
            line={editing} stock={editingStock} listed={delivery.lines.some((l) => l.id === editing.id)} problem={problem}
            onChange={setEditing} onSave={() => putLine(editing)} onRemove={() => dropLine(editing.id)}
          />
        ) : null}
      </Sheet>
      <ItemPicker
        code={unknown} onClose={() => setUnknown(undefined)}
        onPick={(picked, pack) => {
          setUnknown(undefined);
          arrive(picked, pack || undefined);
        }}
      />
    </Screen>
  );
}

// Amount, unit and price for one bahan. Changing the unit refreshes a price that was only the prefill.
function LineForm({ line, stock, listed, problem, onChange, onSave, onRemove }: {
  line: DeliveryLine; stock: PhoneStock; listed: boolean; problem: string
  onChange: (line: DeliveryLine) => void; onSave: () => void; onRemove: () => void
}) {
  const qty = qtyOf(stock, line);
  const per = perOf(stock, line.unit);
  const pick = (unit: string) => onChange({ ...line, unit, price: !line.price || line.price === suggestedPrice(stock, line.unit) ? suggestedPrice(stock, unit) : line.price });
  return (
    <>
      <View style={local.wrap}>
        {units(stock).map((u) => (
          <Chip
            key={u.name} active={line.unit === u.name} onPress={() => pick(u.name)}
            // A pack says how much it holds ("dus (24 pcs)"); kg, L and the base unit speak for themselves.
            label={(stock.packs ?? []).some((p) => p.name === u.name) ? `${unitName(u.name)} (${nice(u.per, stock.unit)})` : unitName(u.name)}
          />
        ))}
      </View>
      <Field label={`Jumlah (${unitName(line.unit)})`} keyboardType="decimal-pad" placeholder="0" autoFocus value={line.amount} onChangeText={(amount) => onChange({ ...line, amount })} />
      <Field
        label={`Harga per ${unitName(line.unit)} (Rp)`} keyboardType="number-pad" placeholder="Boleh kosong" value={line.price}
        onChangeText={(price) => onChange({ ...line, price: price.replace(/\D/g, '') })}
      />
      <T tone="strong" accessibilityLiveRegion="polite">
        {Number.isNaN(qty) ? 'Jumlah tidak valid' : qty > 0 ? `${per === 1000 ? '' : `= ${nice(qty, stock.unit)} · `}${line.price ? rupiah(lineCost(stock, line)) : 'tanpa harga'}` : 'Isi jumlah yang datang'}
      </T>
      {problem ? <T style={{ color: color.criticalFg }}>{problem}</T> : null}
      <Button label={listed ? 'Simpan' : 'Tambah'} kind="accent" onPress={onSave} />
      {listed ? <Button label="Hapus baris" kind="danger" onPress={onRemove} /> : null}
    </>
  );
}

// The nota, photographed full screen. The picture is shrunk to what the server accepts before it is kept.
function NoteCamera({ onShot, onCancel }: { onShot: (uri: string) => void; onCancel: () => void }) {
  const [permission, request] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [busy, setBusy] = useState(false);
  const insets = useSafeAreaInsets();
  const shoot = async () => {
    setBusy(true);
    try {
      const picture = await camera.current?.takePictureAsync({ quality: 0.7 });
      if (picture) onShot(picture.uri);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={[local.camera, { paddingTop: insets.top }]}>
      {permission?.granted ? (
        <CameraView ref={camera} style={kit.grow} facing="back" />
      ) : (
        <View style={[kit.grow, local.ask]}>
          <T style={{ color: color.onInk, textAlign: 'center' }}>Kamera dipakai untuk memotret nota kiriman.</T>
          {permission?.canAskAgain !== false ? <Button label="Izinkan kamera" kind="accent" onPress={() => void request()} /> : null}
        </View>
      )}
      <View style={[local.inline, local.cameraBar, { paddingBottom: Math.max(insets.bottom, space.l) }]}>
        <Button label="Batal" kind="secondary" style={kit.grow} onPress={onCancel} />
        <Button label="Ambil foto" kind="accent" style={kit.grow} loading={busy} disabled={!permission?.granted} onPress={() => void shoot()} />
      </View>
    </View>
  );
}

const local = StyleSheet.create({
  section: { gap: space.s },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  thumb: { width: 56, height: 56, borderRadius: radius.s, backgroundColor: color.muted },
  camera: { flex: 1, backgroundColor: color.ink },
  ask: { alignItems: 'center', justifyContent: 'center', gap: space.l, padding: space.xl },
  cameraBar: { paddingHorizontal: space.l, paddingTop: space.m },
});
