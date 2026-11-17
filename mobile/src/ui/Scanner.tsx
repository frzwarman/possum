// The camera strip that reads barcodes. It only reports a code; what the code means is the screen's business.
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { BARCODE_TYPES, START, admit, normalizeCode, rearm } from '../../../src/stok/barcode';
import { Button, T } from './kit';
import { color, radius, space } from './theme';

// What the camera read last. It outlives the strip itself, which is taken down while an entry is open: when the
// list comes back the camera is usually still pointed at the product just counted, and must not open it again.
let gate = START;

export function Scanner({ onCode, active }: { onCode: (code: string) => void; active: boolean }) {
  const [permission, request] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  // One settings object for the life of the strip, so the camera is not reconfigured on every render.
  const settings = useMemo(() => ({ barcodeTypes: [...BARCODE_TYPES] }), []);
  // Each time the camera comes (back) on, the last code counts as still in view.
  useEffect(() => {
    if (active) gate = rearm(gate, Date.now());
  }, [active]);
  const scanned = (result: BarcodeScanningResult) => {
    const code = normalizeCode(result.data);
    if (!code) return;
    const seen = admit(gate, code, Date.now());
    gate = seen.gate;
    if (seen.fire) onCode(code);
  };
  // Off while an entry or a sheet is open: no stray scans, and the battery lasts the whole count.
  if (!active) return null;
  if (!permission?.granted) {
    return (
      <View style={[local.frame, local.ask]}>
        <T tone="small" style={{ color: color.borderStrong, textAlign: 'center' }}>
          {permission && !permission.canAskAgain ? 'Kamera diblokir. Izinkan Takar Stok memakai kamera di pengaturan ponsel.' : 'Kamera dipakai untuk memindai barcode. Kode juga bisa diketik di bawah.'}
        </T>
        {permission?.canAskAgain !== false ? <Button label="Izinkan kamera" kind="accent" small onPress={() => void request()} /> : null}
      </View>
    );
  }
  return (
    <View style={local.frame}>
      <CameraView style={StyleSheet.absoluteFill} facing="back" enableTorch={torch} barcodeScannerSettings={settings} onBarcodeScanned={scanned} />
      <View style={local.aim} />
      <Pressable accessibilityRole="button" accessibilityLabel="Senter" accessibilityState={{ selected: torch }} onPress={() => setTorch(!torch)} style={local.torch}>
        <T tone="small" style={{ color: color.onInk }}>{torch ? 'Senter nyala' : 'Senter'}</T>
      </Pressable>
    </View>
  );
}

const local = StyleSheet.create({
  frame: { height: 180, borderRadius: radius.m, overflow: 'hidden', backgroundColor: color.ink },
  ask: { alignItems: 'center', justifyContent: 'center', gap: space.m, padding: space.l },
  // Where to hold the barcode.
  aim: { position: 'absolute', left: '12%', right: '12%', top: '50%', height: 2, backgroundColor: color.lime, opacity: 0.9, pointerEvents: 'none' },
  torch: { position: 'absolute', right: space.s, bottom: space.s, minHeight: 36, paddingHorizontal: space.m, borderRadius: radius.pill, backgroundColor: 'rgba(27,29,33,0.7)', alignItems: 'center', justifyContent: 'center' },
});
