// Masuk: as on Takar's shared tablet, tap your name and type your 6-digit PIN. A phone nobody has signed in on yet
// has no team list, so the first sign-in is by email.
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { roleLabel } from '../../../src/domain/permissions';
import type { TeamMember } from '../../../src/stok/types';
import { useApp } from '../state';
import { Avatar, Button, Card, Field, Screen, T, styles as kit } from '../ui/kit';
import { color, font, space } from '../ui/theme';

export function SignIn() {
  const app = useApp();
  const people = app.team.filter((m) => m.login);
  const [byEmail, setByEmail] = useState(people.length === 0);
  const [member, setMember] = useState<TeamMember>();
  const [pin, setPin] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // A wrong PIN empties the field, so the next try starts clean.
  useEffect(() => {
    if (app.error) setPin('');
  }, [app.error]);

  // The sixth digit signs in, as on the tablet: no extra button to find.
  const typePin = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 6);
    setPin(digits);
    if (digits.length === 6 && member?.login && !app.busy) void app.signIn(member.login, digits, true);
  };
  const pick = (m?: TeamMember) => {
    app.clearMessage();
    setPin('');
    setMember(m);
  };
  const demo = (
    <Pressable accessibilityRole="button" accessibilityLabel="Coba demo" onPress={app.startDemo} hitSlop={8}>
      <T style={local.link}>Coba demo</T>
    </Pressable>
  );

  if (!app.configured) {
    return (
      <Screen>
        <Brand />
        <Card>
          <T tone="heading">Koneksi restoran belum diatur.</T>
          <T>Isi alamat dan kunci Supabase di mobile/.env, lalu jalankan ulang aplikasinya. Demo tetap bisa dicoba.</T>
          <Button label="Coba demo" kind="accent" onPress={app.startDemo} />
        </Card>
      </Screen>
    );
  }

  if (member) {
    return (
      <Screen>
        <Brand />
        <Card style={local.center}>
          <Avatar name={member.name} size={64} />
          <T tone="title">Hai {member.name}</T>
          <T tone="small">{roleLabel[member.role]}. PIN Anda 6 angka.</T>
          <TextInput
            accessibilityLabel="PIN" autoFocus secureTextEntry keyboardType="number-pad" maxLength={6} value={pin} onChangeText={typePin}
            editable={!app.busy} placeholder="••••••" placeholderTextColor={color.disabled} style={local.pin}
          />
          <T tone="small">{app.busy ? 'Memeriksa…' : 'Angka keenam langsung masuk.'}</T>
        </Card>
        <Button label="Bukan Anda? Pilih nama" kind="secondary" onPress={() => pick()} />
      </Screen>
    );
  }

  if (byEmail) {
    return (
      <Screen>
        <Brand />
        <Card>
          <T tone="heading">Masuk dengan email</T>
          <T tone="small">Untuk ponsel yang baru pertama kali dipakai. Setelah itu staf cukup memilih nama dan mengetik PIN.</T>
          <Field label="Email staf" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" />
          <Field label="Kata sandi" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" onSubmitEditing={() => void app.signIn(email, password)} />
          <Button label="Masuk" kind="accent" loading={app.busy} disabled={!email.trim() || password.length < 6} onPress={() => void app.signIn(email, password)} />
        </Card>
        <View style={local.links}>
          {people.length > 0 ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Masuk dengan nama dan PIN" onPress={() => setByEmail(false)} hitSlop={8}>
              <T style={local.link}>Masuk dengan nama dan PIN</T>
            </Pressable>
          ) : null}
          {demo}
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <Brand />
      <View>
        <T tone="title">Siapa yang bertugas?</T>
        <T tone="small">Ketuk nama Anda, lalu masukkan PIN.</T>
      </View>
      {people.map((m) => (
        <Pressable key={m.id} accessibilityRole="button" accessibilityLabel={`${m.name}, ${roleLabel[m.role]}`} onPress={() => pick(m)} style={({ pressed }) => [kit.row, pressed && kit.pressed]}>
          <Avatar name={m.name} />
          <View style={kit.grow}>
            <T tone="strong">{m.name}</T>
            <T tone="small">{roleLabel[m.role]}</T>
          </View>
        </Pressable>
      ))}
      <View style={local.links}>
        <Pressable accessibilityRole="button" accessibilityLabel="Masuk dengan email" onPress={() => setByEmail(true)} hitSlop={8}>
          <T style={local.link}>Masuk dengan email</T>
        </Pressable>
        {demo}
      </View>
    </Screen>
  );
}

function Brand() {
  return (
    <View style={local.brand}>
      <T style={local.wordmark}>takar stok</T>
      <T tone="small">Hitung stok dan terima barang dari ponsel.</T>
    </View>
  );
}

const local = StyleSheet.create({
  brand: { paddingTop: space.xl, paddingBottom: space.s },
  wordmark: { fontFamily: font.bold, fontSize: 30, color: color.ink },
  center: { alignItems: 'center' },
  pin: {
    alignSelf: 'stretch', minHeight: 64, borderRadius: 12, borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.subtle,
    textAlign: 'center', fontFamily: font.bold, fontSize: 30, letterSpacing: 10, color: color.ink,
  },
  links: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: space.m },
  link: { fontFamily: font.semibold, fontSize: 15, color: color.ink, textDecorationLine: 'underline' },
});
