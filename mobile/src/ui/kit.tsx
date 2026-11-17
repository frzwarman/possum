// The few building blocks every screen uses. Sizes are for a thumb in a storeroom: 52-point buttons, 16-point text.
import type { ReactNode } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View,
  type StyleProp, type TextInputProps, type TextProps, type TextStyle, type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state';
import { color, font, radius, space } from './theme';

type Tone = 'title' | 'heading' | 'body' | 'strong' | 'small' | 'label';
export function T({ tone = 'body', style, ...rest }: TextProps & { tone?: Tone }) {
  return <Text {...rest} style={[styles[tone], style]} />;
}

// Two letters, as Takar's avatars draw them: the first letters of two words, or the first two of one name.
export const initials = (name: string) => {
  const words = name.trim().split(/\s+/);
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
};
export function Avatar({ name, size = 44 }: { name: string; size?: number }) {
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[styles.strong, { fontSize: size * 0.36 }]}>{initials(name)}</Text>
    </View>
  );
}

type Kind = 'accent' | 'primary' | 'secondary' | 'ghost' | 'danger';
export function Button({ label, onPress, kind = 'primary', loading, disabled, small, style }: {
  label: string; onPress: () => void; kind?: Kind; loading?: boolean; disabled?: boolean; small?: boolean; style?: StyleProp<ViewStyle>
}) {
  const off = disabled || loading;
  const ink = kind === 'primary' ? color.onInk : kind === 'danger' ? color.criticalFg : kind === 'ghost' ? color.secondary : color.ink;
  return (
    <Pressable
      accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: Boolean(off), busy: Boolean(loading) }}
      disabled={off} onPress={onPress}
      style={({ pressed }) => [styles.button, small && styles.buttonSmall, buttons[kind], off && styles.off, pressed && styles.pressed, style]}
    >
      {loading ? <ActivityIndicator color={ink} /> : <Text style={[styles.buttonText, small && styles.small, { color: ink }]}>{label}</Text>}
    </Pressable>
  );
}

export function Field({ label, style, ...rest }: TextInputProps & { label: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} placeholderTextColor={color.disabled} {...rest} style={[styles.input, style]} />
    </View>
  );
}

export function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: Boolean(active) }} onPress={onPress} style={[styles.chip, active && styles.chipOn]}>
      <Text style={[styles.small, { color: color.ink, fontFamily: active ? font.semibold : font.medium }]}>{label}</Text>
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

// A row that can be tapped: a name, a line under it, and something on the right.
export function Row({ title, note, right, onPress, tone }: { title: string; note?: string; right?: ReactNode; onPress?: () => void; tone?: 'warning' }) {
  const body = (
    <View style={[styles.row, tone === 'warning' && { backgroundColor: color.warningBg }]}>
      <View style={styles.grow}>
        <Text style={styles.strong}>{title}</Text>
        {note ? <Text style={styles.small}>{note}</Text> : null}
      </View>
      {right}
    </View>
  );
  return onPress ? (
    <Pressable accessibilityRole="button" accessibilityLabel={`${title}${note ? `, ${note}` : ''}`} onPress={onPress} style={({ pressed }) => pressed && styles.pressed}>
      {body}
    </Pressable>
  ) : body;
}

// A panel that slides up from the bottom, above the keyboard.
export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.sheetWrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.sheetShade} onPress={onClose} accessibilityLabel="Tutup" />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, space.l) }]}>
          <View style={styles.sheetHead}>
            <Text style={[styles.heading, styles.grow]}>{title}</Text>
            <Button label="Tutup" kind="ghost" small onPress={onClose} />
          </View>
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// A yes-or-no question as a sheet. (React Native's own Alert does nothing in a browser, where the demo runs.)
export function Confirm({ ask, onClose }: { ask?: { title: string; message: string; yes: string; run: () => void }; onClose: () => void }) {
  return (
    <Sheet visible={Boolean(ask)} onClose={onClose} title={ask?.title ?? ''}>
      <Text style={styles.body}>{ask?.message}</Text>
      <Button
        label={ask?.yes ?? 'Ya'} kind="accent"
        onPress={() => {
          onClose();
          ask?.run();
        }}
      />
      <Button label="Batal" kind="secondary" onPress={onClose} />
    </Sheet>
  );
}

// What just happened, or what went wrong. A notice fades by itself; an error stays until it is tapped.
// It sits in the layout between the body and the footer, never on top of them: a message that floats over the
// screen ends up covering the very button the person needs next.
export function Toast() {
  const { error, notice, clearMessage } = useApp();
  if (!error && !notice) return null;
  return (
    <Pressable
      accessibilityRole="alert" accessibilityLabel={error || notice} onPress={clearMessage}
      style={[styles.toast, error ? { backgroundColor: color.criticalBg, borderColor: color.criticalFg } : null]}
    >
      <Text style={[styles.strong, { color: error ? color.criticalFg : color.onInk }]}>{error || notice}</Text>
      {error ? <Text style={[styles.small, { color: color.criticalFg }]}>Ketuk untuk menutup</Text> : null}
    </Pressable>
  );
}

// A whole screen: safe areas, an optional header with a way back, a scrolling body and a fixed footer.
export function Screen({ title, note, onBack, backLabel = 'Kembali', right, children, footer, scroll = true, refreshing, onRefresh }: {
  title?: string; note?: string; onBack?: () => void; backLabel?: string; right?: ReactNode; children: ReactNode; footer?: ReactNode
  scroll?: boolean; refreshing?: boolean; onRefresh?: () => void
}) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView style={[styles.screen, { paddingTop: insets.top }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {title || onBack ? (
        <View style={styles.header}>
          {onBack ? (
            <Pressable accessibilityRole="button" accessibilityLabel={backLabel} onPress={onBack} hitSlop={12} style={styles.back}>
              <Text style={styles.backGlyph}>←</Text>
            </Pressable>
          ) : null}
          <View style={styles.grow}>
            {title ? <Text accessibilityRole="header" style={styles.title} numberOfLines={1}>{title}</Text> : null}
            {note ? <Text style={styles.small} numberOfLines={1}>{note}</Text> : null}
          </View>
          {right}
        </View>
      ) : null}
      {scroll ? (
        <ScrollView
          style={styles.grow} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
          refreshControl={onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} /> : undefined}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.grow, styles.content]}>{children}</View>
      )}
      <Toast />
      {footer ? <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, space.l) }]}>{footer}</View> : <View style={{ height: insets.bottom }} />}
    </KeyboardAvoidingView>
  );
}

const buttons = StyleSheet.create({
  accent: { backgroundColor: color.lime },
  primary: { backgroundColor: color.ink },
  secondary: { backgroundColor: color.surface, borderColor: color.borderStrong },
  ghost: { backgroundColor: 'transparent' },
  danger: { backgroundColor: color.criticalBg },
});

export const styles = StyleSheet.create({
  title: { fontFamily: font.bold, fontSize: 22, color: color.text },
  heading: { fontFamily: font.bold, fontSize: 18, color: color.text },
  body: { fontFamily: font.medium, fontSize: 16, color: color.text, lineHeight: 23 },
  strong: { fontFamily: font.semibold, fontSize: 16, color: color.text },
  small: { fontFamily: font.medium, fontSize: 13, color: color.secondary, lineHeight: 19 },
  label: { fontFamily: font.semibold, fontSize: 13, color: color.secondary, marginBottom: space.xs },
  grow: { flex: 1, minWidth: 0 },
  screen: { flex: 1, backgroundColor: color.canvas },
  content: { paddingHorizontal: space.l, paddingBottom: space.xl, gap: space.l },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingHorizontal: space.l, paddingVertical: space.m },
  back: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface, borderWidth: 1, borderColor: color.border },
  backGlyph: { fontFamily: font.semibold, fontSize: 20, color: color.ink },
  footer: { paddingHorizontal: space.l, paddingTop: space.m, gap: space.s, backgroundColor: color.canvas, borderTopWidth: 1, borderTopColor: color.border },
  card: { backgroundColor: color.surface, borderRadius: radius.m, borderWidth: 1, borderColor: color.border, padding: space.l, gap: space.m },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.m, backgroundColor: color.surface, borderRadius: radius.m, borderWidth: 1, borderColor: color.border, paddingHorizontal: space.l, paddingVertical: space.m, minHeight: 60 },
  avatar: { backgroundColor: color.limeSubtle, alignItems: 'center', justifyContent: 'center' },
  button: { minHeight: 52, paddingHorizontal: space.l, borderRadius: radius.s, borderWidth: 1, borderColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  buttonSmall: { minHeight: 40, paddingHorizontal: space.m },
  buttonText: { fontFamily: font.semibold, fontSize: 16 },
  off: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
  field: { gap: 2 },
  input: { minHeight: 52, borderRadius: radius.s, borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.surface, paddingHorizontal: space.m, fontFamily: font.medium, fontSize: 17, color: color.text },
  chip: { minHeight: 40, paddingHorizontal: space.l, borderRadius: radius.pill, borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.surface, alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: color.limeSubtle, borderColor: color.ink },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheetShade: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(27,29,33,0.45)' },
  sheet: { backgroundColor: color.canvas, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: space.l, paddingTop: space.l, gap: space.m, maxHeight: '88%', width: '100%', maxWidth: 480, alignSelf: 'center' },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  toast: { marginHorizontal: space.l, marginBottom: space.s, backgroundColor: color.ink, borderRadius: radius.m, borderWidth: 1, borderColor: color.ink, paddingHorizontal: space.l, paddingVertical: space.m, gap: 2 },
});
