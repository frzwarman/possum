import { PlusJakartaSans_500Medium } from '@expo-google-fonts/plus-jakarta-sans/500Medium';
import { PlusJakartaSans_600SemiBold } from '@expo-google-fonts/plus-jakarta-sans/600SemiBold';
import { PlusJakartaSans_700Bold } from '@expo-google-fonts/plus-jakarta-sans/700Bold';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';
import { convert, quantity } from '../src/domain/calculate';
import { roleLabel } from '../src/domain/permissions';

// First screen: proves the fonts load and Takar's own unit maths is bundled from ../src/domain.
export default function App() {
  const [fonts] = useFonts({ PlusJakartaSans_500Medium, PlusJakartaSans_600SemiBold, PlusJakartaSans_700Bold });
  if (!fonts) return <View style={styles.page} />;
  return (
    <View style={styles.page}>
      <Text style={styles.brand}>takar stok</Text>
      <Text style={styles.line}>
        {quantity(convert('2,5', 'kg', 'g'))} g · {roleLabel.admin}
      </Text>
      <StatusBar style="dark" />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#F6F5F0', alignItems: 'center', justifyContent: 'center' },
  brand: { fontFamily: 'PlusJakartaSans_700Bold', fontSize: 32, color: '#1B1D21' },
  line: { fontFamily: 'PlusJakartaSans_500Medium', fontSize: 16, color: '#1B1D21', marginTop: 8 },
});
