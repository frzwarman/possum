// What every screen shares: who is signed in, what the phone knows, and what is waiting to be sent.
// The decisions live in ../../src/stok and are tested by the web app's suite. This file only wires them to the
// phone's storage, the server and React.
import 'expo-sqlite/localStorage/install';
import * as Crypto from 'expo-crypto';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { countJob } from '../../src/stok/count';
import { deliveryJobs } from '../../src/stok/delivery';
import { demoIdentity, demoServer, demoSnapshot } from '../../src/stok/demo';
import { Queue, load, save } from '../../src/stok/queue';
import { Rejected, explain, flush } from '../../src/stok/sync';
import type { BarcodeLink, CountSession, Delivery, Identity, Job, KV, PhoneStock, Snapshot, TeamMember } from '../../src/stok/types';
import { configured, currentUser, server, signIn as serverSignIn, signOut as serverSignOut } from './platform/supabase';

// A count or a delivery the person sent off today. It counts as sent once none of its jobs is left in the queue.
export interface Sent { id: string; label: string; at: string; jobs: string[] }

export interface App {
  ready: boolean; configured: boolean; identity?: Identity; team: TeamMember[]; stock: PhoneStock[]; links: Record<string, BarcodeLink>
  jobs: Job[]; drafts: CountSession[]; delivery: Delivery; sent: Sent[]
  busy: boolean; syncing: boolean; error: string; notice: string
  signIn(email: string, secret: string, byPin?: boolean): Promise<void>; startDemo(): void; signOut(): Promise<void>; pair(): Promise<void>; sync(): Promise<void>
  saveDraft(session: CountSession): void; dropDraft(id: string): void; submitCount(session: CountSession): boolean
  setDelivery(delivery: Delivery): void; saveDelivery(): boolean
  link(code: string, stockId: string, pack: string): void; unlink(code: string): void
  renew(jobId: string): void; discard(jobId: string): void; clearMessage(): void
  newId(): string
}

const kv: KV = localStorage;
const uuid = () => Crypto.randomUUID();
const stamp = () => new Date().toISOString();
const emptyDelivery = (): Delivery => ({ id: uuid(), note: '', lines: [] });
const keys = {
  device: 'stok-device', team: 'stok-team', identity: 'stok-identity', snapshot: 'stok-snapshot',
  drafts: (user: string) => `stok-drafts-${user}`, delivery: (user: string) => `stok-delivery-${user}`, sent: (user: string) => `stok-sent-${user}`,
};
const linkMap = (rows: Snapshot['barcodes']): Record<string, BarcodeLink> => Object.fromEntries(rows.map((b) => [b.code, { stockId: b.stockId, pack: b.pack }]));
const linkRows = (links: Record<string, BarcodeLink>): Snapshot['barcodes'] => Object.entries(links).map(([code, link]) => ({ code, ...link }));
// Links this phone changed and has not sent yet stay as the person left them, whatever the server last said.
function withPending(links: Record<string, BarcodeLink>, queued: Job[]): Record<string, BarcodeLink> {
  const next = { ...links };
  for (const job of queued) {
    if (job.state !== 'pending') continue;
    if (job.type === 'link') next[job.code] = { stockId: job.stockId, pack: job.pack };
    else if (job.type === 'unlink') delete next[job.code];
  }
  return next;
}
const words = (e: unknown) => explain(e instanceof Error ? e.message : String(e));

// State that async work can read at its latest value: the ref is always current, the value drives rendering.
function useLive<T>(initial: T | (() => T)) {
  const [value, setValue] = useState(initial);
  const ref = useRef(value);
  const set = useCallback((next: T) => {
    ref.current = next;
    setValue(next);
  }, []);
  return [value, ref, set] as const;
}

const Context = createContext<App | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [identity, me, setMe] = useLive<Identity | undefined>(undefined);
  const [team, setTeam] = useState<TeamMember[]>(() => load(kv, keys.team, []));
  const [stock, stockRef, setStock] = useLive<PhoneStock[]>([]);
  const [links, linksRef, setLinks] = useLive<Record<string, BarcodeLink>>({});
  const [jobs, setJobs] = useState<Job[]>([]);
  const [drafts, draftsRef, setDrafts] = useLive<CountSession[]>([]);
  const [delivery, deliveryRef, setDeliveryLive] = useLive<Delivery>(emptyDelivery);
  const [sent, sentRef, setSentLive] = useLive<Sent[]>([]);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const busyRef = useRef(false);

  // Built once. Everything inside reads refs and calls stable setters, never a render's own values.
  const actions = useMemo(() => {
    // The device id is made once and kept: it is what the owner or manager pairs.
    let device = load<string>(kv, keys.device, '');
    if (!device) {
      device = uuid();
      save(kv, keys.device, device);
    }
    const demo = demoServer(stamp);
    const queueOf = (user: Identity) => new Queue(kv, user.id);
    const need = (): Identity => {
      if (!me.current) throw new Error('Masuk dulu.');
      return me.current;
    };
    const remember = (user: Identity | undefined) => {
      setMe(user);
      if (user) save(kv, keys.identity, user);
      else kv.removeItem(keys.identity);
    };
    // Bahan and barcodes are kept on the phone so the app opens and works with no signal.
    const writeLinks = (next: Record<string, BarcodeLink>) => {
      setLinks(next);
      save(kv, keys.snapshot, { stock: stockRef.current, barcodes: linkRows(next) });
    };
    const writeDrafts = (next: CountSession[]) => {
      setDrafts(next);
      if (me.current) save(kv, keys.drafts(me.current.id), next);
    };
    const writeDelivery = (next: Delivery) => {
      setDeliveryLive(next);
      if (me.current) save(kv, keys.delivery(me.current.id), next);
    };
    const writeSent = (next: Sent[]) => {
      setSentLive(next);
      if (me.current) save(kv, keys.sent(me.current.id), next);
    };

    // What the server says replaces what the phone had, except links still waiting in the queue.
    const adopt = (snapshot: Snapshot, user: Identity) => {
      const next: Identity = {
        ...user, name: snapshot.name, role: snapshot.role, restaurantId: snapshot.restaurantId, store: snapshot.store, timezone: snapshot.timezone,
        paired: user.demo || snapshot.device.enrolled,
      };
      remember(next);
      setStock(snapshot.stock);
      writeLinks(withPending(linkMap(snapshot.barcodes), queueOf(next).all()));
      if (!user.demo) {
        setTeam(snapshot.team);
        save(kv, keys.team, snapshot.team);
      }
    };
    // Everything this person left on this phone: paused counts, the delivery being entered, unsent work.
    const open = (user: Identity) => {
      remember(user);
      const saved = load<Pick<Snapshot, 'stock' | 'barcodes'>>(kv, keys.snapshot, { stock: [], barcodes: [] });
      const queued = queueOf(user).all();
      setStock(saved.stock);
      setLinks(withPending(linkMap(saved.barcodes), queued));
      setJobs(queued);
      setDrafts(load(kv, keys.drafts(user.id), []));
      setDeliveryLive(load(kv, keys.delivery(user.id), emptyDelivery()));
      setSentLive(load(kv, keys.sent(user.id), []));
    };
    const leave = async () => {
      if (me.current && !me.current.demo) await serverSignOut().catch(() => undefined);
      remember(undefined);
      setJobs([]);
      setDrafts([]);
      setSentLive([]);
      setDeliveryLive(emptyDelivery());
    };

    // Send what is waiting, then refresh bahan, barcodes and team. One run at a time: a call made while a run is
    // under way asks for one more pass and waits for the same promise, so its caller sees the final state.
    let inflight: Promise<void> | undefined;
    let again = false;
    const run = async () => {
      const user = me.current;
      if (!user) return;
      setSyncing(true);
      try {
        do {
          again = false;
          const api = user.demo ? demo : server;
          const queue = queueOf(user);
          await flush(queue, user, api);
          if (me.current?.id !== user.id) return;
          setJobs(queue.all());
          const snapshot = await api.snapshot(user.deviceId);
          if (me.current?.id !== user.id) return;
          adopt(snapshot, me.current);
        } while (again);
      } catch (e) {
        // No signal stays quiet and is tried again later. An account switched off in Takar must speak up.
        if (e instanceof Rejected && e.message === 'No active staff membership') {
          await leave();
          setError(explain(e.message));
        }
      } finally {
        setSyncing(false);
        if (me.current) setJobs(queueOf(me.current).all());
      }
    };
    const sync = (): Promise<void> => {
      if (inflight) {
        again = true;
        return inflight;
      }
      inflight = run().finally(() => {
        inflight = undefined;
      });
      return inflight;
    };

    const act = async (fn: () => Promise<void>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError('');
      try {
        await fn();
      } catch (e) {
        setError(words(e));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    };
    const guard = (fn: () => void): boolean => {
      try {
        setError('');
        fn();
        return true;
      } catch (e) {
        setError(words(e));
        return false;
      }
    };
    // Queue first, then try to send. The person is told which of the two happened.
    const enqueue = (user: Identity, added: Job[], label: string) => {
      const queue = queueOf(user);
      queue.add(added);
      setJobs(queue.all());
      const ids = added.map((j) => j.id);
      writeSent([{ id: uuid(), label, at: stamp(), jobs: ids }, ...sentRef.current].slice(0, 20));
      void sync().then(() => {
        if (me.current?.id !== user.id) return;
        const left = queueOf(user).all().filter((j) => ids.includes(j.id));
        if (left.some((j) => j.state === 'rejected')) setError('Ada catatan yang ditolak. Buka Perlu perhatian.');
        else setNotice(left.length ? 'Disimpan di ponsel. Terkirim saat ada sinyal.' : 'Terkirim.');
      });
    };
    const linkJob = (user: Identity, code: string, rest: { type: 'link'; stockId: string; pack: string } | { type: 'unlink' }) => {
      const queue = queueOf(user);
      queue.add([{ id: uuid(), actor: user.id, occurredAt: stamp(), label: `Barcode ${code}`, state: 'pending', code, ...rest }]);
      setJobs(queue.all());
      void sync();
    };

    return {
      sync,
      newId: uuid,
      // On start: the person who was signed in stays signed in, if their session is still on this phone.
      start: async () => {
        const saved = load<Identity | null>(kv, keys.identity, null);
        if (!saved) return;
        if (!saved.demo && (await currentUser().catch(() => undefined)) !== saved.id) {
          kv.removeItem(keys.identity);
          return;
        }
        open({ ...saved, deviceId: device });
        void sync();
      },
      signIn: (email: string, secret: string, byPin = false) =>
        act(async () => {
          let id: string;
          try {
            id = await serverSignIn(email.trim(), secret);
          } catch (e) {
            throw new Error((e as { offline?: boolean }).offline ? 'Perlu internet untuk masuk.' : byPin ? 'PIN salah atau akun tidak aktif' : 'Email atau kata sandi salah');
          }
          let snapshot: Snapshot;
          try {
            snapshot = await server.snapshot(device);
          } catch (e) {
            await serverSignOut().catch(() => undefined);
            throw e instanceof Rejected ? e : new Error('Perlu internet untuk masuk.');
          }
          const user: Identity = {
            id, name: snapshot.name, role: snapshot.role, restaurantId: snapshot.restaurantId, store: snapshot.store, timezone: snapshot.timezone,
            deviceId: device, paired: snapshot.device.enrolled, demo: false,
          };
          open(user);
          adopt(snapshot, user);
          void sync();
        }),
      startDemo: () => {
        const user = demoIdentity(device);
        open(user);
        adopt(demoSnapshot(stamp()), user);
        void sync();
      },
      // Work is sent under the name of the person who did it, so they cannot leave while some of it is unsent.
      signOut: () =>
        act(async () => {
          const user = me.current;
          if (!user) return;
          if (!user.demo) {
            await sync();
            const left = queueOf(user).all().length;
            if (left) throw new Error(`Masih ada ${left} catatan belum terkirim. Cari sinyal dulu, lalu ganti pengguna.`);
          }
          await leave();
        }),
      pair: () =>
        act(async () => {
          const user = need();
          await server.pair(user.deviceId);
          await sync();
        }),
      saveDraft: (session: CountSession) =>
        writeDrafts(draftsRef.current.some((d) => d.id === session.id) ? draftsRef.current.map((d) => (d.id === session.id ? session : d)) : [...draftsRef.current, session]),
      dropDraft: (id: string) => writeDrafts(draftsRef.current.filter((d) => d.id !== id)),
      submitCount: (session: CountSession) =>
        guard(() => {
          const user = need();
          const job = countJob(session, stockRef.current, user.id, uuid(), stamp());
          enqueue(user, [job], job.label);
          writeDrafts(draftsRef.current.filter((d) => d.id !== session.id));
        }),
      setDelivery: writeDelivery,
      saveDelivery: () =>
        guard(() => {
          const user = need();
          const current = deliveryRef.current;
          const added = deliveryJobs(current, stockRef.current, user.id, stamp());
          enqueue(user, added, `Kiriman ${current.note.trim()} · ${added.length} bahan`);
          writeDelivery(emptyDelivery());
        }),
      // A link shows at once on this phone and reaches the other phones when it is sent.
      link: (code: string, stockId: string, pack: string) => {
        guard(() => {
          const user = need();
          writeLinks({ ...linksRef.current, [code]: { stockId, pack } });
          linkJob(user, code, { type: 'link', stockId, pack });
        });
      },
      unlink: (code: string) => {
        guard(() => {
          const user = need();
          const next = { ...linksRef.current };
          delete next[code];
          writeLinks(next);
          linkJob(user, code, { type: 'unlink' });
        });
      },
      // "Kirim ulang": the server remembers the refused id, so the work goes out again under a new one.
      renew: (jobId: string) => {
        guard(() => {
          const user = need();
          const fresh = uuid();
          const queue = queueOf(user);
          queue.renew(jobId, fresh, stamp());
          setJobs(queue.all());
          writeSent(sentRef.current.map((s) => ({ ...s, jobs: s.jobs.map((j) => (j === jobId ? fresh : j)) })));
          void sync();
        });
      },
      discard: (jobId: string) => {
        guard(() => {
          const user = need();
          const queue = queueOf(user);
          queue.remove(jobId);
          setJobs(queue.all());
          writeSent(sentRef.current.map((s) => ({ ...s, jobs: s.jobs.filter((j) => j !== jobId) })).filter((s) => s.jobs.length));
        });
      },
      clearMessage: () => {
        setError('');
        setNotice('');
      },
    };
    // Refs and state setters are stable for the life of the provider.
  }, [me, stockRef, linksRef, draftsRef, deliveryRef, sentRef, setMe, setStock, setLinks, setDrafts, setDeliveryLive, setSentLive]);

  useEffect(() => {
    void actions.start().finally(() => setReady(true));
  }, [actions]);

  // Try again when the app comes to the front, and every 30 seconds while something is waiting.
  useEffect(() => {
    const front = AppState.addEventListener('change', (state) => {
      if (state === 'active') void actions.sync();
    });
    const timer = setInterval(() => {
      if (me.current && new Queue(kv, me.current.id).all().some((j) => j.state === 'pending')) void actions.sync();
    }, 30_000);
    return () => {
      front.remove();
      clearInterval(timer);
    };
  }, [actions, me]);

  // A notice fades by itself; an error stays until it is tapped away.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const { start: _start, ...api } = actions;
  const value: App = { ready, configured, identity, team, stock, links, jobs, drafts, delivery, sent, busy, syncing, error, notice, ...api };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useApp(): App {
  const app = useContext(Context);
  if (!app) throw new Error('AppProvider required');
  return app;
}
