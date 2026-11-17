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
