import type { Queue } from './queue'
import type { Identity, Job, Operation, Server } from './types'

// The server refused this for good: sending it again unchanged would fail the same way.
export class Rejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Rejected'
    // Keeps `instanceof` true when the bundler compiles classes down.
    Object.setPrototypeOf(this, Rejected.prototype)
  }
}

// The Postgres codes that mean "refused", the same list Takar's web app uses (serverTransport in src/lib/sync.ts):
// a raised exception, a failed check, no permission, a broken reference, a duplicate, a malformed value.
// Anything else (no network, an expired session, a timeout) is worth another try later.
const FINAL = ['P0001', '23514', '42501', '23503', '23505', '22P02']
export function classify(error: { code?: string; message: string }): Error {
  return error.code && FINAL.includes(error.code) ? new Rejected(error.message) : new Error(error.message)
}

// The server answers in English. These are the refusals a phone can meet, in words staff can act on; anything
// else is shown as the server said it.
const WORDS: Record<string, string> = {
  'Device not enrolled': 'Ponsel ini belum dipasangkan. Minta pemilik atau manajer memasangkannya.',
  'Manager permission required': 'Peran Anda tidak boleh melakukan ini.',
  'Manager required': 'Hanya pemilik atau manajer yang bisa melakukan ini.',
  'No active staff membership': 'Akun ini tidak aktif. Hubungi manajer.',
  'Operation timestamp outside recovery window': 'Catatan ini tertunda lebih dari 7 hari, atau jam ponsel salah. Kirim ulang untuk mencatatnya sekarang.',
  'Count already approved': 'Hitungan ini sudah disetujui manajer.',
  'Invalid count': 'Hitungan tidak bisa diterima. Mulai hitungan baru.',
  'Invalid count line': 'Ada bahan di hitungan ini yang sudah tidak ada di Takar. Mulai hitungan baru.',
  'Invalid stock amount': 'Jumlah atau harga di luar batas.',
  'Invalid stock quantity': 'Jumlah harus lebih dari nol.',
  'Invalid photo': 'Foto nota tidak bisa diterima. Ambil ulang fotonya.',
  'Invalid barcode': 'Barcode tidak bisa dipakai.',
  'Unknown stock item': 'Bahan ini sudah tidak ada di Takar.',
  'Unknown pack': 'Kemasan ini sudah tidak ada di Takar.',
  'The till cannot be a phone': 'Perangkat ini adalah kasir utama.',
}
export const explain = (message: string): string => (Object.prototype.hasOwnProperty.call(WORDS, message) ? WORDS[message] : message)

// On start: does the person who was signed in stay signed in? `session` is what the phone can tell about the saved
// session: whose it is, or `unsure` when it has expired and could not be refreshed for lack of signal. Unsure
// keeps the person in: a phone opened in a storeroom must still count, and nothing reaches the server without a
// good session anyway.
export function staysSignedIn(saved: { id: string; demo: boolean }, session: { id?: string; unsure: boolean }): boolean {
  return saved.demo || session.id === saved.id || (session.id === undefined && session.unsure)
}

// A wait with an end. `call` gets a signal that is aborted `ms` after it started, and at that moment the caller
// stops waiting, whatever `call` does with the signal. The signal fires even after `call` has answered: a fetch
// answers when the headers arrive, and the body it is still reading must not hang either.
export function deadline<T>(ms: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const stop = new AbortController()
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      stop.abort()
      reject(new Error('Tidak ada jawaban dari Takar. Coba lagi.'))
    }, ms)
    call(stop.signal).then(resolve, reject)
  })
}

// The question staysSignedIn needs answered, asked with a limit. An expired session is refreshed first, and with no
// signal that is half a minute of retries: the app must not sit at a blank screen that long. After `wait` the
// answer is "unsure", as it is when the check fails outright; the refresh carries on by itself.
export function whoseSession(check: () => Promise<{ id?: string; unsure: boolean }>, wait = 2000): Promise<{ id?: string; unsure: boolean }> {
  return deadline(wait, check).catch(() => ({ unsure: true }))
}

// A queued count or delivery as apply_operation takes it.
export function toOperation(job: Extract<Job, { type: 'op' }>, identity: Identity): Operation {
  return { id: job.id, kind: job.kind, actor: job.actor, restaurantId: identity.restaurantId, deviceId: identity.deviceId, occurredAt: job.occurredAt, payload: job.payload }
}

// Sends the signed-in person's pending work, oldest first. A refused job is set aside with the server's message
// and the rest goes on. Any other failure stops the run and leaves everything as it is: the same ids go out on
// the next try, and the server answers a repeated id with the first result, so nothing is entered twice.
// Work queued by someone else is never sent under this person's name.
export async function flush(queue: Queue, identity: Identity, server: Server): Promise<{ sent: number; rejected: number; left: number }> {
  const mine = queue.all().filter((j) => j.state === 'pending' && j.actor === identity.id)
  let sent = 0
  let rejected = 0
  for (const job of mine) {
    try {
      if (job.type === 'op') await server.apply(toOperation(job, identity))
      else if (job.type === 'link') await server.link(identity.deviceId, job.code, job.stockId, job.pack)
      else await server.unlink(identity.deviceId, job.code)
      queue.done(job.id)
      sent++
    } catch (e) {
      if (!(e instanceof Rejected)) break
      queue.reject(job.id, e.message)
      rejected++
    }
  }
  return { sent, rejected, left: mine.length - sent - rejected }
}

// Why "Ganti" has to wait, if it has to: work is sent under the name of the person who did it, so they cannot leave
// while some of it is still on the phone. Unsent work waits for signal. Refused work waits for a decision in Perlu
// perhatian, and no signal will send it.
export function cannotLeave(jobs: Job[]): string | undefined {
  const unsent = jobs.filter((j) => j.state === 'pending').length
  if (unsent) return `Masih ada ${unsent} catatan belum terkirim. Cari sinyal dulu, lalu ganti pengguna.`
  if (jobs.length) return `Ada ${jobs.length} catatan yang ditolak Takar. Buka Perlu perhatian: kirim ulang atau hapus, lalu ganti pengguna.`
  return undefined
}
