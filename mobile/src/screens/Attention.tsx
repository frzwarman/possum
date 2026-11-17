// Perlu perhatian: work Takar refused for good (wrong role, phone un-paired, a bahan removed, a count already
// approved). Nothing here is sent again by itself: the person sends it again as new, or deletes it.
import { View } from 'react-native';
import { explain } from '../../../src/stok/sync';
import { useApp } from '../state';
import { Button, Card, Screen, T, styles as kit } from '../ui/kit';
import { space } from '../ui/theme';

export function Attention({ back }: { back: () => void }) {
  const app = useApp();
  const refused = app.jobs.filter((j) => j.state === 'rejected');
  return (
    <Screen title="Perlu perhatian" note="Catatan yang ditolak Takar" onBack={back}>
      {refused.length === 0 ? <T>Tidak ada catatan yang ditolak.</T> : null}
      {refused.map((job) => (
        <Card key={job.id}>
          <View>
            <T tone="strong">{job.label}</T>
            <T tone="small">{explain(job.error ?? '')}</T>
          </View>
          <View style={{ flexDirection: 'row', gap: space.s }}>
            <Button label="Kirim ulang" kind="primary" small style={kit.grow} onPress={() => app.renew(job.id)} />
            <Button label="Hapus" kind="danger" small style={kit.grow} onPress={() => app.discard(job.id)} />
          </View>
        </Card>
      ))}
    </Screen>
  );
}
