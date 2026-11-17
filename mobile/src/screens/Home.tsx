// Beranda: who is signed in, whether everything was sent, and the two jobs this app exists for.
import { Pressable, StyleSheet, View } from 'react-native';
import { can, roleLabel } from '../../../src/domain/permissions';
import { useApp } from '../state';
import { Avatar, Button, Row, Screen, T, styles as kit } from '../ui/kit';
import { color, radius, space } from '../ui/theme';

export type Route = 'home' | 'count' | 'receive' | 'attention';

export function Home({ go }: { go: (route: Route) => void }) {
  const app = useApp();
  const me = app.identity;
  if (!me) return null;
  const pending = app.jobs.filter((j) => j.state === 'pending').length;
  const rejected = app.jobs.filter((j) => j.state === 'rejected').length;
  // Deliveries stay with the roles Takar lets record them; everyone counts.
  const receives = can(me.role, 'inventory');
  const queued = new Set(app.jobs.map((j) => j.id));
  const today = new Date().toDateString();
  // "Sent" means the queue no longer holds any of its jobs.
  const done = app.sent.filter((s) => new Date(s.at).toDateString() === today && !s.jobs.some((id) => queued.has(id)));

  return (
    <Screen refreshing={app.syncing} onRefresh={() => void app.sync()}>
      <View style={local.who}>
        <Avatar name={me.name} />
        <View style={kit.grow}>
          <T tone="heading" numberOfLines={1}>Hai {me.name.split(' ')[0]}</T>
          <T tone="small" numberOfLines={1}>{roleLabel[me.role]} · {me.store}</T>
        </View>
        {me.demo ? <View style={local.badge}><T tone="small" style={{ color: color.warningFg }}>Demo</T></View> : null}
        <Button label="Ganti" kind="secondary" small loading={app.busy} onPress={() => void app.signOut()} />
      </View>

      <View style={local.status} accessibilityLiveRegion="polite">
        <View style={[local.dot, { backgroundColor: pending ? color.warningFg : color.goodFg }]} />
        <T tone="small" style={{ color: color.text }}>{app.syncing ? 'Mengirim…' : pending ? `${pending} belum terkirim` : 'Tersinkron'}</T>
      </View>

      <View style={local.tiles}>
        <Pressable accessibilityRole="button" accessibilityLabel="Hitung stok" onPress={() => go('count')} style={({ pressed }) => [local.tile, { backgroundColor: color.lime }, pressed && kit.pressed]}>
          <T tone="heading">Hitung stok</T>
          <T tone="small" style={{ color: color.ink }}>Pindai, ketik jumlah, kirim untuk ditinjau.</T>
        </Pressable>
        <Pressable
          accessibilityRole="button" accessibilityLabel="Terima barang" accessibilityState={{ disabled: !receives }} disabled={!receives} onPress={() => go('receive')}
          style={({ pressed }) => [local.tile, { backgroundColor: receives ? color.ink : color.muted }, pressed && kit.pressed]}
        >
          <T tone="heading" style={{ color: receives ? color.onInk : color.disabled }}>Terima barang</T>
          <T tone="small" style={{ color: receives ? color.borderStrong : color.secondary }}>
            {receives ? 'Pindai kiriman, masukkan ke stok.' : 'Hanya pemilik, manajer atau admin stok'}
          </T>
        </Pressable>
      </View>

      {rejected > 0 ? <Row tone="warning" title={`Perlu perhatian (${rejected})`} note="Ada catatan yang ditolak Takar." right={<T tone="strong">›</T>} onPress={() => go('attention')} /> : null}

      {app.drafts.length > 0 ? (
        <View style={local.section}>
          <T tone="label">Dijeda</T>
          {app.drafts.map((c) => (
            <Row
              key={c.id} title={c.area} note={`${c.lines.filter((l) => l.counted !== undefined).length} dari ${c.lines.length} dihitung`}
              right={<T tone="strong">Lanjutkan ›</T>} onPress={() => go('count')}
            />
          ))}
        </View>
      ) : null}

      {done.length > 0 ? (
        <View style={local.section}>
          <T tone="label">Terkirim hari ini</T>
          {done.map((s) => (
            <Row key={s.id} title={s.label} note={s.label.startsWith('Hitung') ? 'Menunggu persetujuan manajer' : 'Sudah masuk stok'} />
          ))}
        </View>
      ) : null}
    </Screen>
  );
}

const local = StyleSheet.create({
  who: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingTop: space.m },
  badge: { backgroundColor: color.warningBg, borderRadius: radius.pill, paddingHorizontal: space.m, paddingVertical: space.xs },
  status: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  dot: { width: 8, height: 8, borderRadius: 4 },
  tiles: { flexDirection: 'row', gap: space.m },
  tile: { flex: 1, minHeight: 132, borderRadius: radius.m, padding: space.l, justifyContent: 'space-between', gap: space.s },
  section: { gap: space.s },
});
