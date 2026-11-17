// Pasangkan ponsel: Takar refuses writes from a device nobody paired. Only an owner or a manager may pair,
// the same rule as for the tablets, so they sign in on this phone once.
import { useApp } from '../state';
import { Button, Card, Screen, T } from '../ui/kit';

export function Pair() {
  const app = useApp();
  const role = app.identity?.role;
  const may = role === 'owner' || role === 'manager';
  return (
    <Screen title="Pasangkan ponsel" note={app.identity?.store} footer={<Button label="Keluar" kind="secondary" onPress={() => void app.signOut()} />}>
      <Card>
        {may ? (
          <>
            <T tone="heading">Ponsel ini belum dipasangkan</T>
            <T>Setelah dipasangkan, ponsel ini bisa mengirim hitungan stok dan kiriman ke Takar. Cukup sekali; staf lalu masuk dengan nama dan PIN masing-masing.</T>
            <Button label="Pasangkan ponsel ini" kind="accent" loading={app.busy} onPress={() => void app.pair()} />
          </>
        ) : (
          <>
            <T tone="heading">Ponsel ini belum dipasangkan.</T>
            <T>Minta pemilik atau manajer masuk di ponsel ini sekali.</T>
          </>
        )}
      </Card>
    </Screen>
  );
}
