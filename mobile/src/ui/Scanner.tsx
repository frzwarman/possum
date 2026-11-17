// The camera strip that reads barcodes. It only reports a code; what the code means is the screen's business.
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { BARCODE_TYPES, normalizeCode } from '../../../src/stok/barcode';
import { Button, T } from './kit';
import { color, radius, space } from './theme';

export function Scanner({ onCode, active }: { onCode: (code: string) => void; active: boolean }) {
  const [permission, request] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const last = useRef({ code: '', at: 0 });
  // The camera reports the same code many times a second: one report per code every 1.5 seconds is enough.
  const scanned = (result: BarcodeScanningResult) => {
    const code = normalizeCode(result.data);
    const now = Date.now();
    if (!code || (code === last.current.code && now - last.current.at < 1500)) return;
    last.current = { code, at: now };
    onCode(code);
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
      <CameraView style={StyleSheet.absoluteFill} facing="back" enableTorch={torch} barcodeScannerSettings={{ barcodeTypes: [...BARCODE_TYPES] }} onBarcodeScanned={scanned} />
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
