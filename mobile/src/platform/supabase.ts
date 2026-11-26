// The phone's only door to Takar's database: the same Supabase project as the web app, reached through five server
// functions. Set up as Expo's Supabase guide does it: the session is kept in SQLite-backed localStorage.
import 'expo-sqlite/localStorage/install';
import { createClient, isAuthRetryableFetchError } from '@supabase/supabase-js';
import { AppState } from 'react-native';
import { classify, deadline } from '../../../src/stok/sync';
import type { Server, Snapshot } from '../../../src/stok/types';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
// Without both values (mobile/.env) the app only offers the demo.
export const configured = Boolean(url && key);

// The phone's fetch never gives up by itself (Android's HTTP client is set up without timeouts), and one request
// with no answer used to hold every later send, the 30-second retry and "Ganti" until the app was restarted. So
// every request this client makes, for the session as well as for the server functions, gets this long. After that
// it is cancelled and fails like a lost connection: the work stays queued and goes out again under the same id,
// which the server answers with its first result, so a request that did arrive is not entered twice.
// ponytail: one limit for every request, the delivery with its nota photo included (about 70 KB to send). A
// connection too slow for that in 20 seconds keeps the work queued until it improves; give sends with a photo a
// longer limit if phones on 2G turn out to need it.
const TIMEOUT = 20_000;

const supabase = configured
  ? createClient(url, key, {
      auth: { storage: localStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
      global: { fetch: (input, init) => deadline(TIMEOUT, (signal) => fetch(input, { ...init, signal })) },
    })
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
  // Without a session the call would run as nobody, and the server's "no permission" would set valid work aside
  // as refused. A plain error keeps it queued until the person signs in again (as the web till does).
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Sesi masuk berakhir. Masuk lagi untuk mengirim.');
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
  // This phone only: the default global sign-out would also end the person's sessions on the till and the laptop.
  await supabase?.auth.signOut({ scope: 'local' });
}

// Whose session is saved on this phone. After about an hour the session has to be refreshed, which needs signal:
// `unsure` says it could not be, so the caller keeps the person signed in rather than locking them out of a
// storeroom. A refresh the server refused is not unsure: that session is gone.
export async function currentUser(): Promise<{ id?: string; unsure: boolean }> {
  if (!supabase) return { unsure: false };
  const { data, error } = await supabase.auth.getSession();
  return { id: data.session?.user.id, unsure: Boolean(error && isAuthRetryableFetchError(error)) };
}

// The server ended the session (a refresh it refused, or the account was signed out elsewhere).
export function onSignedOut(run: () => void): () => void {
  if (!supabase) return () => undefined;
  const { data } = supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') run();
  });
  return () => data.subscription.unsubscribe();
}
