// "Barcode belum dikenal": the person says once which bahan a code belongs to, and on which pack it is printed.
// Every phone in the store remembers it from then on.
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { search } from '../../../src/domain/calculate';
import type { PhoneStock } from '../../../src/stok/types';
import { useApp } from '../state';
import { nice } from './format';
import { Button, Chip, Field, Row, Sheet, T } from './kit';
import { space } from './theme';

export function ItemPicker({ code, onPick, onClose }: { code?: string; onPick: (item: PhoneStock, pack: string) => void; onClose: () => void }) {
  const app = useApp();
  const [query, setQuery] = useState('');
  const [item, setItem] = useState<PhoneStock>();
  const [pack, setPack] = useState('');
  // A new code starts from an empty search.
  useEffect(() => {
    setQuery('');
    setItem(undefined);
    setPack('');
  }, [code]);
  const found = search(app.stock, query).slice(0, 40);
  return (
    <Sheet visible={Boolean(code)} onClose={onClose} title={`Kode ${code ?? ''} belum dikenal`}>
      {item ? (
        <>
          <Row title={item.name} note={item.area} right={<Button label="Ganti" kind="ghost" small onPress={() => setItem(undefined)} />} />
          <T tone="label">Kode ini untuk:</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.s }}>
            <Chip label="satuan" active={pack === ''} onPress={() => setPack('')} />
            {(item.packs ?? []).map((p) => (
              <Chip key={p.name} label={`${p.name} ${nice(p.qty, item.unit)}`} active={pack === p.name} onPress={() => setPack(p.name)} />
            ))}
          </View>
          <Button
            label="Simpan" kind="accent"
            onPress={() => {
              if (!code) return;
              app.link(code, item.id, pack);
              onPick(item, pack);
            }}
          />
        </>
      ) : (
        <>
          <Field label="Cari bahan" value={query} onChangeText={setQuery} autoFocus placeholder="Nama bahan" autoCorrect={false} />
          <ScrollView style={{ maxHeight: 300 }} keyboardShouldPersistTaps="handled">
            <View style={{ gap: space.s }}>
              {found.map((s) => (
                <Row key={s.id} title={s.name} note={s.area} onPress={() => setItem(s)} />
              ))}
            </View>
          </ScrollView>
          {found.length === 0 ? <T tone="small">Tidak ada bahan dengan nama itu.</T> : null}
        </>
      )}
    </Sheet>
  );
}
