import { PlusJakartaSans_500Medium } from '@expo-google-fonts/plus-jakarta-sans/500Medium';
import { PlusJakartaSans_600SemiBold } from '@expo-google-fonts/plus-jakarta-sans/600SemiBold';
import { PlusJakartaSans_700Bold } from '@expo-google-fonts/plus-jakarta-sans/700Bold';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { BackHandler, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Attention } from './src/screens/Attention';
import { Count } from './src/screens/Count';
import { Home, type Route } from './src/screens/Home';
import { Pair } from './src/screens/Pair';
import { Receive } from './src/screens/Receive';
import { SignIn } from './src/screens/SignIn';
import { AppProvider, useApp } from './src/state';
import { color } from './src/ui/theme';

// Six screens, switched by state: who is signed in decides the first three, a route the rest. No router.
function Root() {
  const app = useApp();
  const [route, setRoute] = useState<Route>('home');
  const [resume, setResume] = useState<string>();
  const who = app.identity?.id;
  // A new person always starts at Beranda.
  useEffect(() => setRoute('home'), [who]);
  // Android's back button: back to Beranda from anywhere else; from Beranda it leaves the app as usual.
  // A screen with its own step back (an open entry, a sheet) registers after this one and is asked first.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (route === 'home') return false;
      setRoute('home');
      return true;
    });
    return () => sub.remove();
  }, [route]);

  if (!app.ready) return <View style={{ flex: 1, backgroundColor: color.canvas }} />;
  if (!app.identity) return <SignIn />;
  if (!app.identity.paired && !app.identity.demo) return <Pair />;
  const home = () => setRoute('home');
  // "Lanjutkan" on Beranda opens that paused count directly.
  const go = (next: Route, draft?: string) => {
    setResume(draft);
    setRoute(next);
  };
  if (route === 'attention') return <Attention back={home} />;
  if (route === 'count') return <Count key={resume ?? 'new'} back={home} resume={resume} />;
  if (route === 'receive') return <Receive back={home} />;
  return <Home go={go} />;
}

export default function App() {
  const [fonts] = useFonts({ PlusJakartaSans_500Medium, PlusJakartaSans_600SemiBold, PlusJakartaSans_700Bold });
  if (!fonts) return <View style={{ flex: 1, backgroundColor: color.canvas }} />;
  // A phone fills its screen. In a browser (the demo, or a check on a laptop) the app keeps a phone's width.
  return (
    <SafeAreaProvider>
      <AppProvider>
        <View style={{ flex: 1, backgroundColor: color.canvas, alignItems: 'center' }}>
          <View style={{ flex: 1, width: '100%', maxWidth: 480 }}>
            <Root />
          </View>
        </View>
        <StatusBar style="dark" />
      </AppProvider>
    </SafeAreaProvider>
  );
}
