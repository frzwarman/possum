// Hitung stok: scan a bahan (or pick it), type how much is there, next. The amount Takar expects is never shown;
// the phone does not even have it. A finished count goes to the manager, who approves it in Takar as today.
import { useEffect, useState } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';
import { quantity, search } from '../../../src/domain/calculate';
import { BIG, blank, measure, type Entry } from '../../../src/domain/measure';
import { lookup, normalizeCode } from '../../../src/stok/barcode';
import { ALL_AREAS, areas, setCounted, startCount } from '../../../src/stok/count';
import type { CountSession, PhoneStock } from '../../../src/stok/types';
import { useApp } from '../state';
import { cap, nice, unitName } from '../ui/format';
import { ItemPicker } from '../ui/ItemPicker';
import { Button, Card, Chip, Confirm, Field, Row, Screen, T, styles as kit } from '../ui/kit';
import { Scanner } from '../ui/Scanner';
import { color, space } from '../ui/theme';

// A paused count also keeps what was typed per bahan ("2 dus" and "5"), so resuming shows it as the person left
// it. Only stockId and counted are ever sent (countJob), so the extra field stays on the phone.
type Draft = CountSession & { typed?: Record<string, Entry> };
type Ask = { title: string; message: string; yes: string; run: () => void };

const progress = (c: CountSession) => `${c.lines.filter((l) => l.counted !== undefined).length} dari ${c.lines.length} dihitung`;
const says = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Count({ back, resume }: { back: () => void; resume?: string }) {
  const app = useApp();
  const [session, setSession] = useState<Draft | undefined>(() => app.drafts.find((d) => d.id === resume));
  const [area, setArea] = useState('');
  // The bahan whose entry is open, and the box that gets the cursor: a pack name, or '' for the open pack.
  const [current, setCurrent] = useState<string>();
  const [focus, setFocus] = useState('');
  const [query, setQuery] = useState('');
  const [unknown, setUnknown] = useState<string>();
  const [ask, setAsk] = useState<Ask>();
  const [problem, setProblem] = useState('');

  // Android's back button closes an open entry before it leaves the count.
  useEffect(() => {
    if (!current) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setCurrent(undefined);
      return true;
    });
    return () => sub.remove();
  }, [current]);

  const item = (id: string) => app.stock.find((s) => s.id === id);

  if (!session) {
    const start = () => {
      try {
        const next = startCount(app.stock, area, app.identity?.id ?? '', app.newId(), new Date().toISOString());
        app.saveDraft(next);
        setSession(next);
        setProblem('');
      } catch (e) {
        setProblem(app.stock.length ? says(e) : 'Belum ada bahan di ponsel ini. Tarik Beranda ke bawah untuk memuatnya dari Takar.');
      }
    };
    return (
      <Screen title="Hitung stok" note="Per area, tanpa melihat angka sistem" onBack={back} footer={<Button label="Mulai menghitung" kind="accent" onPress={start} />}>
        {app.drafts.length > 0 ? (
          <View style={local.section}>
            <T tone="label">Dijeda</T>
            {app.drafts.map((c) => (
              <Row
                key={c.id} title={c.area} note={progress(c)} onPress={() => setSession(c)}
                right={
                  <View style={local.inline}>
                    <Button
                      label="Hapus" kind="ghost" small
                      onPress={() => setAsk({ title: 'Hapus hitungan ini?', message: `Hitungan ${c.area} yang dijeda akan dibuang.`, yes: 'Hapus', run: () => app.dropDraft(c.id) })}
                    />
                    <T tone="strong">Lanjutkan ›</T>
                  </View>
                }
              />
            ))}
          </View>
        ) : null}
        <View style={local.section}>
          <T tone="label">Area simpan</T>
          <View style={local.wrap}>
            <Chip label={ALL_AREAS} active={area === ''} onPress={() => setArea('')} />
            {areas(app.stock).map((a) => (
              <Chip key={a} label={a} active={area === a} onPress={() => setArea(a)} />
            ))}
          </View>
        </View>
        {problem ? <T style={{ color: color.criticalFg }}>{problem}</T> : null}
        <Confirm ask={ask} onClose={() => setAsk(undefined)} />
      </Screen>
    );
  }

  // A bahan removed from Takar while the count was paused simply drops out of the walk.
  const lines = session.lines.filter((l) => item(l.stockId));
  const counted = lines.filter((l) => l.counted !== undefined).length;
  const entryOf = (id: string): Entry => {
    const typed = session.typed?.[id];
    if (typed) return typed;
    const value = session.lines.find((l) => l.stockId === id)?.counted;
    return value === undefined ? blank : { ...blank, loose: String(value / 1000).replace('.', ',') };
  };
  // Every keystroke is saved, so pausing or a closed app costs nothing. A number that does not parse counts as
  // "not counted" until it is fixed.
  const change = (stock: PhoneStock, entry: Entry) => {
    let amount: number | undefined;
    try {
      amount = measure(stock, entry);
    } catch {
      amount = undefined;
    }
    const next: Draft = { ...setCounted(session, stock.id, amount), typed: { ...session.typed, [stock.id]: entry } };
    setSession(next);
    app.saveDraft(next);
  };
  const open = (id: string, pack?: string) => {
    const stock = item(id);
    if (!stock) return;
    setCurrent(id);
    setFocus(pack ?? stock.packs?.[0]?.name ?? '');
    setQuery('');
  };
  // A bahan was scanned or picked. One from another area joins the count only if the person says so.
  const arrive = (stock: PhoneStock, pack?: string) => {
    if (session.lines.some((l) => l.stockId === stock.id)) {
      open(stock.id, pack);
      return;
    }
    setAsk({
      title: stock.name, message: `Bahan ini tercatat di area ${stock.area ?? 'lain'}. Tambahkan ke hitungan ini?`, yes: 'Tambahkan',
      run: () => {
        const next: Draft = setCounted(session, stock.id, undefined);
        setSession(next);
        app.saveDraft(next);
        open(stock.id, pack);
      },
    });
  };
  const onCode = (code: string) => {
    const hit = lookup(code, app.links, app.stock);
    if (hit) arrive(hit.item, hit.pack?.name);
    else setUnknown(code);
  };
  // The one field does two jobs: a code that is known opens its bahan, digits that are not get taught, and
  // anything else just filters the list below.
  const submitQuery = () => {
    const code = normalizeCode(query);
    if (!code) return;
    if (lookup(code, app.links, app.stock)) {
      setQuery('');
      onCode(code);
    } else if (/^\d{6,}$/.test(code)) {
      setQuery('');
      setUnknown(code);
    }
  };

  const stock = current ? item(current) : undefined;
  if (stock) {
    const entry = entryOf(stock.id);
    const packs = stock.packs ?? [];
    let total: number | undefined;
    let bad = '';
    try {
      total = measure(stock, entry);
    } catch (e) {
      bad = says(e);
    }
    const looseUnit = entry.big ? BIG[stock.unit] : stock.unit;
    // Switching g and kg (or ml and L) converts what is typed, so the count itself does not change.
    const flip = () => {
      const n = Number(entry.loose.replace(',', '.'));
      const loose = entry.loose.trim() && Number.isFinite(n) ? String(Math.round((entry.big ? n * 1000 : n / 1000) * 1000) / 1000).replace('.', ',') : entry.loose;
      change(stock, { ...entry, loose, big: !entry.big });
    };
    const codes = Object.entries(app.links).filter(([, link]) => link.stockId === stock.id).map(([code]) => code);
    return (
      <Screen
        title={stock.name} note={stock.area} onBack={() => setCurrent(undefined)} backLabel="Kembali ke daftar"
        footer={<Button label="Simpan, pindai berikutnya" kind="accent" disabled={Boolean(bad)} onPress={() => setCurrent(undefined)} />}
      >
        <Card>
          <T tone="small">
            {packs.length ? `Hitung ${packs.map((p) => p.name).join(' dan ')} penuh, lalu ${packs[packs.length - 1].name} yang terbuka.` : 'Hitung semua yang ada di area ini.'} Jumlah seharusnya tetap tersembunyi.
          </T>
          {packs.map((p) => (
            <Field
              key={p.name} label={`${cap(p.name)} penuh (${nice(p.qty, stock.unit)})`} keyboardType="decimal-pad" placeholder="0" autoFocus={focus === p.name}
              value={entry.packs[p.name] ?? ''} onChangeText={(v) => change(stock, { ...entry, packs: { ...entry.packs, [p.name]: v } })}
            />
          ))}
          <Field
            label={`${packs.length ? `${cap(packs[packs.length - 1].name)} terbuka` : 'Jumlah'} (${unitName(looseUnit)})`} keyboardType="decimal-pad" placeholder="0" autoFocus={focus === ''}
            value={entry.loose} onChangeText={(v) => change(stock, { ...entry, loose: v })}
          />
          {BIG[stock.unit] ? (
            <View style={local.wrap}>
              <Chip label={unitName(stock.unit)} active={!entry.big} onPress={() => entry.big && flip()} />
              <Chip label={unitName(BIG[stock.unit])} active={entry.big} onPress={() => !entry.big && flip()} />
            </View>
          ) : null}
          <T tone="strong" accessibilityLiveRegion="polite" style={bad ? { color: color.criticalFg } : undefined}>
            {bad || (total === undefined ? 'Belum dihitung' : `= ${quantity(total)} ${stock.unit}`)}
          </T>
        </Card>
        {codes.length > 0 ? (
          <Card>
            <T tone="label">Kode terpasang</T>
            {codes.map((code) => (
              <View key={code} style={local.inline}>
                <T style={kit.grow}>{code}</T>
                <Button label="Lepas" kind="ghost" small onPress={() => app.unlink(code)} />
              </View>
            ))}
          </Card>
        ) : null}
      </Screen>
    );
  }

  const hint = (s: PhoneStock) => [...(session.area === ALL_AREAS && s.area ? [s.area] : []), ...(s.packs?.length ? s.packs.map((p) => `${p.name} ${nice(p.qty, s.unit)}`) : [s.unit])].join(', ');
  // What was typed, in words: "2 dus + 5 pcs = 53 pcs".
  const words = (s: PhoneStock, amount: number) => {
    const entry = entryOf(s.id);
    const parts = (s.packs ?? []).filter((p) => (entry.packs[p.name] ?? '').trim()).map((p) => `${entry.packs[p.name]} ${p.name}`);
    const loose = entry.loose.trim() ? [`${entry.loose} ${unitName(entry.big ? BIG[s.unit] : s.unit)}`] : [];
    return parts.length ? `${[...parts, ...loose].join(' + ')} = ${nice(amount, s.unit)}` : nice(amount, s.unit);
  };
  const rows = lines.flatMap((l) => {
    const s = item(l.stockId);
    return s ? [{ s, amount: l.counted }] : [];
  });
  const match = query.trim() ? new Set(search(rows.map((r) => r.s), query).map((s) => s.id)) : undefined;
  const shown = rows.filter((r) => !match || match.has(r.s.id));
  const todo = shown.filter((r) => r.amount === undefined);
  const done = shown.filter((r) => r.amount !== undefined);
  // ponytail: every row is rendered at once; move to a FlatList if a store keeps many hundreds of bahan.
  return (
    <Screen
      title={`Hitung: ${session.area}`} note={`${counted} dari ${lines.length} dihitung`} onBack={back} backLabel="Jeda, kembali ke Beranda"
      right={<Button label="Jeda" kind="secondary" small onPress={back} />}
      footer={
        <Button
          label="Kirim untuk ditinjau" kind="accent" disabled={!counted}
          onPress={() =>
            setAsk({
              title: 'Kirim untuk ditinjau', message: `Kirim ${counted} dari ${lines.length} bahan? Yang belum dihitung tidak dikirim.`, yes: 'Kirim',
              run: () => {
                if (app.submitCount(session)) back();
              },
            })
          }
        />
      }
    >
      <Scanner active={!unknown && !ask} onCode={onCode} />
      <Field
        label="Ketik kode atau cari nama bahan" value={query} onChangeText={setQuery} onSubmitEditing={submitQuery}
        returnKeyType="search" autoCorrect={false} autoCapitalize="none" placeholder="8991002101234 atau susu"
      />
      {todo.length > 0 ? (
        <View style={local.section}>
          <T tone="label">Belum dihitung ({todo.length})</T>
          {todo.map(({ s }) => (
            <Row key={s.id} title={s.name} note={hint(s)} onPress={() => open(s.id)} />
          ))}
        </View>
      ) : null}
      {done.length > 0 ? (
        <View style={local.section}>
          <T tone="label">Sudah dihitung ({done.length})</T>
          {done.map(({ s, amount }) => (
            <Row key={s.id} title={s.name} note={words(s, amount ?? 0)} right={<T tone="strong" style={{ color: color.goodFg }}>✓</T>} onPress={() => open(s.id)} />
          ))}
        </View>
      ) : null}
      {shown.length === 0 ? <T tone="small">Tidak ada bahan dengan nama itu di hitungan ini.</T> : null}
      <ItemPicker
        code={unknown} onClose={() => setUnknown(undefined)}
        onPick={(picked, pack) => {
          setUnknown(undefined);
          arrive(picked, pack || undefined);
        }}
      />
      <Confirm ask={ask} onClose={() => setAsk(undefined)} />
    </Screen>
  );
}

const local = StyleSheet.create({
  section: { gap: space.s },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.s },
});
