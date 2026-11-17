// The phone's only door to Takar's database: the same Supabase project as the web app, reached through five server
// functions. Set up as Expo's Supabase guide does it: the session is kept in SQLite-backed localStorage.
import 'expo-sqlite/localStorage/install';
import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';
import { classify } from '../../../src/stok/sync';
import type { Server, Snapshot } from '../../../src/stok/types';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
// Without both values (mobile/.env) the app only offers the demo.
export const configured = Boolean(url && key);

const supabase = configured
  ? createClient(url, key, { auth: { storage: localStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false } })
  : null;
// Refreshing the session only makes sense while the app is in front.
if (supabase) {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') void supabase.auth.startAutoRefresh();
    else void supabase.auth.stopAutoRefresh();
  });
}

// Every failure goes through classify(): a refusal from Postgres is final, anything else is worth another try.
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  if (!supabase) throw new Error('Koneksi restoran belum diatur.');
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw classify(error);
  return data as T;
}

export const server: Server = {
  snapshot: (deviceId) => rpc<Snapshot>('stock_app', { device_id: deviceId }),
  apply: async (operation) => {
    await rpc('apply_operation', { operation });
  },
  link: async (deviceId, code, stockId, pack) => {
    await rpc('link_barcode', { device_id: deviceId, barcode: code, item: stockId, pack_name: pack });
  },
  unlink: async (deviceId, code) => {
    await rpc('unlink_barcode', { device_id: deviceId, barcode: code });
  },
  pair: async (deviceId) => {
    await rpc('enroll_phone', { device_id: deviceId });
  },
};

// Staff sign in as on the tablet: the login behind their name, with their PIN as the password.
// Returns the user id. `offline` tells a missing connection from a wrong PIN.
export async function signIn(email: string, secret: string): Promise<string> {
  if (!supabase) throw new Error('Koneksi restoran belum diatur.');
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: secret });
  if (error || !data.user) throw Object.assign(new Error(error?.message ?? 'Login gagal'), { offline: !error?.status });
  return data.user.id;
}

export async function signOut(): Promise<void> {
  await supabase?.auth.signOut();
}

// Who the saved session belongs to. Read from the phone's storage, so it also answers with no signal.
export async function currentUser(): Promise<string | undefined> {
  return (await supabase?.auth.getSession())?.data.session?.user.id;
}
