import { PlusJakartaSans_500Medium } from '@expo-google-fonts/plus-jakarta-sans/500Medium';
import { PlusJakartaSans_600SemiBold } from '@expo-google-fonts/plus-jakarta-sans/600SemiBold';
import { PlusJakartaSans_700Bold } from '@expo-google-fonts/plus-jakarta-sans/700Bold';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AppProvider, useApp } from './src/state';

// Until the screens exist (next task): shows that state boots, the demo loads and the queue is readable.
function Boot() {
  const app = useApp();
  return (
    <View style={styles.page}>
      <Text style={styles.brand}>takar stok</Text>
      <Text style={styles.line}>{!app.ready ? 'Memuat…' : app.identity ? `${app.identity.name} · ${app.identity.store}` : 'Belum masuk'}</Text>
      <Text style={styles.line}>
        {app.stock.length} bahan · {Object.keys(app.links).length} barcode · {app.jobs.length} antre
      </Text>
      <Pressable onPress={app.startDemo} accessibilityRole="button">
        <Text style={styles.link}>Coba demo</Text>
      </Pressable>
      <StatusBar style="dark" />
    </View>
  );
}

export default function App() {
  const [fonts] = useFonts({ PlusJakartaSans_500Medium, PlusJakartaSans_600SemiBold, PlusJakartaSans_700Bold });
  if (!fonts) return <View style={styles.page} />;
  return (
    <AppProvider>
      <Boot />
    </AppProvider>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#F6F5F0', alignItems: 'center', justifyContent: 'center' },
  brand: { fontFamily: 'PlusJakartaSans_700Bold', fontSize: 32, color: '#1B1D21' },
  line: { fontFamily: 'PlusJakartaSans_500Medium', fontSize: 16, color: '#1B1D21', marginTop: 8 },
  link: { fontFamily: 'PlusJakartaSans_600SemiBold', fontSize: 16, color: '#1B1D21', marginTop: 24, textDecorationLine: 'underline' },
});
