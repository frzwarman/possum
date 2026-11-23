// Regenerates the screenshots and the PDF of the Takar Stok user guide (docs/panduan).
//
//   cd mobile && EXPO_PUBLIC_SUPABASE_URL=https://takar.example EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=panduan npx expo export --platform web --output-dir dist
//   node scripts/panduan.mjs            # screenshots, then the PDF
//   node scripts/panduan.mjs --pdf      # only the PDF, from docs/panduan/index.html
//
// The app runs for real, in a phone-sized browser. Only two things are pretend: the server (every request to
// takar.example is answered here, in the shapes Supabase uses) and the camera (a still of a carton with a real
// EAN-13 on it). So the run is also an end-to-end check of the paths the unit tests cannot reach: signing in by
// email and by PIN, pairing, a camera scan opening its bahan, the queue with no signal, and a refusal.
import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DIST = resolve('mobile/dist')
const OUT = resolve('docs/panduan/shots')
const API = 'https://takar.example'
const pdfOnly = process.argv.includes('--pdf')

// ---- the pretend store ----
const team = [
  { id: 'a1111111-1111-4111-8111-111111111111', name: 'Yusuf', role: 'owner', login: 'yusuf@contoh.id' },
  { id: 'a2222222-2222-4222-8222-222222222222', name: 'Rina', role: 'manager', login: 'rina@contoh.id' },
  { id: 'a3333333-3333-4333-8333-333333333333', name: 'Adit', role: 'admin', login: 'adit@contoh.id' },
  { id: 'a4444444-4444-4444-8444-444444444444', name: 'Sari', role: 'barista', login: 'sari@contoh.id' },
  { id: 'a5555555-5555-4555-8555-555555555555', name: 'Bima', role: 'kitchen', login: 'bima@contoh.id' },
]
// cost = rupiah per thousandth of the base unit; usual = the last deliveries in thousandths of the base unit.
const stock = [
  { id: 'susu-uht', name: 'Susu UHT Full Cream', unit: 'ml', area: 'Kulkas bar', packs: [{ name: 'karton', qty: 12_000_000 }], aliases: ['milk'], cost: 0.0195, usual: [36_000_000, 36_000_000, 24_000_000, 36_000_000, 36_000_000] },
  { id: 'susu-oat', name: 'Susu Oat', unit: 'ml', area: 'Kulkas bar', packs: [{ name: 'karton', qty: 6_000_000 }], aliases: [], cost: 0.038, usual: [12_000_000, 12_000_000, 12_000_000] },
  { id: 'whipping', name: 'Whipping Cream', unit: 'ml', area: 'Kulkas bar', packs: [{ name: 'kotak', qty: 1_000_000 }], aliases: [] },
  { id: 'lemon', name: 'Lemon', unit: 'g', area: 'Kulkas bar', packs: [], aliases: [] },
  { id: 'sirup-vanila', name: 'Sirup Vanila', unit: 'pcs', area: 'Rak bar', packs: [{ name: 'dus', qty: 6000 }], aliases: [], cost: 85, usual: [6000, 6000, 12000] },
  { id: 'biji-kopi', name: 'Biji Kopi House Blend', unit: 'g', area: 'Rak bar', packs: [{ name: 'bungkus', qty: 1_000_000 }], aliases: ['espresso'], cost: 0.25, usual: [5_000_000, 5_000_000, 5_000_000] },
  { id: 'gula-aren', name: 'Gula Aren Cair', unit: 'ml', area: 'Rak bar', packs: [{ name: 'jerigen', qty: 5_000_000 }], aliases: [] },
  { id: 'matcha', name: 'Bubuk Matcha', unit: 'g', area: 'Rak bar', packs: [{ name: 'kaleng', qty: 500_000 }], aliases: [] },
  { id: 'air-mineral', name: 'Air Mineral Botol', unit: 'pcs', area: 'Gudang', packs: [{ name: 'dus', qty: 24_000 }], aliases: [], cost: 2, usual: [48_000, 48_000, 48_000] },
  { id: 'beras', name: 'Beras', unit: 'g', area: 'Gudang', packs: [{ name: 'karung', qty: 25_000_000 }], aliases: [] },
  { id: 'cup-16', name: 'Cup 16 oz', unit: 'pcs', area: 'Gudang', packs: [{ name: 'slop', qty: 50_000 }], aliases: ['gelas'] },
  { id: 'minyak', name: 'Minyak Goreng', unit: 'ml', area: 'Gudang', packs: [{ name: 'jerigen', qty: 18_000_000 }], aliases: [] },
  { id: 'ayam', name: 'Ayam Fillet', unit: 'g', area: 'Freezer', packs: [{ name: 'pak', qty: 1_000_000 }], aliases: [] },
  { id: 'kentang', name: 'Kentang Goreng Beku', unit: 'g', area: 'Freezer', packs: [{ name: 'pak', qty: 2_500_000 }], aliases: [] },
]
const CARTON = '8991002101234' // on the carton the pretend camera looks at
const NEW_CODE = '8998866200301' // a code nobody has linked yet
const world = { enrolled: false, barcodes: [{ code: CARTON, stockId: 'susu-uht', pack: 'karton' }], ops: [], calls: [], rejectNext: false, offline: false }

// ---- EAN-13, drawn for real so the browser's own barcode detector reads it ----
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011']
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111']
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100']
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL']
function ean13(code) {
  const d = [...code].map(Number)
  let bits = '101'
  for (let i = 1; i <= 6; i++) bits += (PARITY[d[0]][i - 1] === 'L' ? L : G)[d[i]]
  bits += '01010'
  for (let i = 7; i <= 12; i++) bits += R[d[i]]
  return bits + '101'
}
function bars(code, unit, height) {
  const rects = [...ean13(code)].map((b, i) => (b === '1' ? `<rect x="${i * unit}" width="${unit}" height="${height}"/>` : '')).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${95 * unit}" height="${height}" fill="#111">${rects}</svg>`
}
// What the phone's camera "sees": the side of a carton of milk, barcode in the middle of the frame.
const scene = `<body style="margin:0;width:640px;height:480px;background:linear-gradient(180deg,#b9a98f,#8f7f66);font-family:Helvetica,Arial,sans-serif;display:flex;align-items:center;justify-content:center">
 <div style="width:600px;height:440px;background:linear-gradient(135deg,#f4f1ea,#e2ddd2);border-radius:6px;box-shadow:0 10px 30px rgba(0,0,0,.35);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px">
  <div style="font-size:26px;font-weight:800;letter-spacing:1px;color:#1f4e8c">SUSU UHT FULL CREAM</div>
  <div style="background:#fff;padding:14px 34px 6px;border-radius:4px">${bars(CARTON, 4, 150)}<div style="font:600 20px/26px monospace;letter-spacing:5px;text-align:center;color:#111">${CARTON[0]} ${CARTON.slice(1, 7)} ${CARTON.slice(7)}</div></div>
  <div style="font-size:18px;color:#55514a">12 × 1 L · simpan di tempat sejuk</div>
 </div></body>`

// ---- the pretend server, in Supabase's shapes ----
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = (person) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: person.id, role: 'authenticated', email: person.login, exp: Math.floor(Date.now() / 1000) + 3600 })}.panduan`
const session = (person) => ({
  access_token: token(person), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: `refresh-${person.id}`,
  user: { id: person.id, aud: 'authenticated', role: 'authenticated', email: person.login, app_metadata: {}, user_metadata: {}, created_at: '2026-11-01T00:00:00Z' },
})
const receives = (role) => ['owner', 'manager', 'admin'].includes(role)
async function serve(route) {
  const request = route.request()
  const url = new URL(request.url())
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
  if (world.offline) return route.abort('internetdisconnected')
  const json = (status, body) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const done = () => route.fulfill({ status: 204, headers: cors })
  const body = request.postData() ? JSON.parse(request.postData()) : {}
  if (url.pathname === '/auth/v1/token') {
    const person = url.searchParams.get('grant_type') === 'password' ? team.find((p) => p.login === body.email) : team.find((p) => `refresh-${p.id}` === body.refresh_token)
    world.calls.push(`sign-in ${body.email ?? 'refresh'}`)
    return person && (body.password ?? '').length >= 6 ? json(200, session(person)) : json(400, { code: 'invalid_credentials', message: 'Invalid login credentials' })
  }
  if (url.pathname === '/auth/v1/logout') return done()
  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    const fn = url.pathname.split('/').pop()
    const claims = JSON.parse(Buffer.from((request.headers().authorization ?? '').split('.')[1] ?? '', 'base64url').toString() || '{}')
    const me = team.find((p) => p.id === claims.sub)
    if (!me) return json(401, { code: 'PGRST301', message: 'JWT expired' })
    world.calls.push(`${fn} ${me.name}`)
    if (fn === 'stock_app') {
      return json(200, {
        restaurantId: 'b0000000-0000-4000-8000-000000000001', name: me.name, role: me.role, store: 'Ziggy Lounge', timezone: 'Asia/Jakarta', now: new Date().toISOString(),
        device: { mode: world.enrolled ? 'phone' : null, enrolled: world.enrolled, primary: false }, team,
        stock: stock.map(({ cost, usual, ...rest }) => (receives(me.role) ? { ...rest, ...(cost && { cost }), ...(usual && { usual }) } : rest)), barcodes: world.barcodes,
      })
    }
    if (fn === 'enroll_phone') {
      if (!['owner', 'manager'].includes(me.role)) return json(403, { code: '42501', message: 'Manager required' })
      world.enrolled = true
      return done()
    }
    if (!world.enrolled) return json(400, { code: 'P0001', message: 'Device not enrolled' })
    if (fn === 'apply_operation') {
      if (world.rejectNext) {
        world.rejectNext = false
        return json(400, { code: 'P0001', message: 'Operation timestamp outside recovery window', details: null, hint: null })
      }
      world.ops.push({ by: me.name, ...body.operation })
      return json(200, { id: body.operation.id, receivedAt: new Date().toISOString() })
    }
    if (fn === 'link_barcode') {
      world.barcodes = [...world.barcodes.filter((b) => b.code !== body.barcode), { code: body.barcode, stockId: body.item, pack: body.pack_name }]
      world.calls.push(`  linked ${body.barcode} to ${body.item}/${body.pack_name || 'satuan'} on device ${body.device_id ? 'yes' : 'missing'}`)
      return done()
    }
    if (fn === 'unlink_barcode') {
      world.barcodes = world.barcodes.filter((b) => b.code !== body.barcode)
      return done()
    }
  }
  return json(404, { message: `not mocked: ${url.pathname}` })
}

// ---- a static server for mobile/dist ----
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.ttf': 'font/ttf', '.png': 'image/png', '.ico': 'image/x-icon', '.css': 'text/css', '.wasm': 'application/wasm' }
async function staticServer() {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const file = resolve(join(DIST, path === '/' ? 'index.html' : path))
    try {
      if (!file.startsWith(DIST)) throw new Error('outside')
      const data = await readFile(file)
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(data)
    } catch {
      res.writeHead(200, { 'content-type': 'text/html' }).end(await readFile(join(DIST, 'index.html')))
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  // Browsers keep connections open; without closing them the script would never exit.
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => (server.closeAllConnections(), server.close()) }
}

async function screenshots() {
  await mkdir(OUT, { recursive: true })
  // Start clean: the files are numbered in the order they are taken, so an old run can leave strays.
  for (const old of await readdir(OUT)) if (old.endsWith('.png')) await unlink(join(OUT, old))
  // The camera feed: one JPEG frame, which Chromium loops as a video.
  const feed = join(tmpdir(), 'takar-stok-camera.mjpeg')
  {
    const browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } })
    await page.setContent(scene)
    await writeFile(feed, await page.screenshot({ type: 'jpeg', quality: 95 }))
    await browser.close()
  }
  const site = await staticServer()
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${feed}`] })
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'id-ID', timezoneId: 'Asia/Jakarta', permissions: ['camera'],
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  })
  await context.route(`${API}/**`, serve)
  // A step that cannot find its button should fail with its name, not wait forever.
  context.setDefaultTimeout(15_000)
  const page = await context.newPage()
  const problems = []
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()))
  page.on('pageerror', (e) => problems.push(String(e)))

  const button = (name) => page.getByRole('button', { name, exact: true })
  const field = (name) => page.getByLabel(name, { exact: true })
  const heading = (name) => page.getByRole('heading', { name, exact: true })
  let n = 0
  const shot = async (name) => {
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(450) // sheets slide in
    await page.screenshot({ path: join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`) })
  }

  // A notice ("Terkirim.") fades after four seconds; wait for it where it would cover what the picture is about.
  const calm = () => expect(page.getByRole('alert')).toHaveCount(0, { timeout: 8000 })

  // 1. A phone nobody has used: email, then pairing by the manager.
  await page.goto(site.origin)
  // The browser treats its pretend camera as a front camera and mirrors the preview. A phone's back camera is
  // not mirrored, so the pictures should not be either. Detection reads the raw frames and is unaffected.
  await page.addStyleTag({ content: 'video{transform:none!important}' })
  await expect(field('Email staf')).toBeVisible()
  await field('Email staf').fill('rina@contoh.id')
  await field('Kata sandi').fill('rahasia-rina')
  await shot('masuk-email')
  await button('Masuk').click()
  await expect(button('Pasangkan ponsel ini')).toBeVisible()
  await shot('pasangkan')
  await button('Pasangkan ponsel ini').click()
  await expect(button('Hitung stok')).toBeVisible()
  assert.equal(world.enrolled, true, 'the manager paired the phone')
  await button('Ganti').click()

  // 2. Staff: name, then PIN.
  await expect(page.getByRole('button', { name: 'Adit, Admin stok' })).toBeVisible()
  await shot('masuk-nama')
  await page.getByRole('button', { name: 'Adit, Admin stok' }).click()
  await field('PIN').pressSequentially('482')
  await shot('masuk-pin')
  await field('PIN').pressSequentially('915')
  await expect(button('Hitung stok')).toBeVisible()
  assert.ok(world.calls.includes('sign-in adit@contoh.id'), 'the PIN signed in with the login behind the name')
  await shot('beranda')

  // 3. A count. The camera is already looking at the carton, so the scan itself opens the bahan.
  await button('Hitung stok').click()
  await button('Kulkas bar').click()
  await shot('hitung-area')
  await button('Mulai menghitung').click()
  let scanned = true
  try {
    await expect(heading('Susu UHT Full Cream')).toBeVisible({ timeout: 8000 })
  } catch {
    scanned = false // no barcode detector in this browser: type the code instead
    await field('Ketik kode atau cari nama bahan').fill(CARTON)
    await field('Ketik kode atau cari nama bahan').press('Enter')
    await expect(heading('Susu UHT Full Cream')).toBeVisible()
  }
  await expect(field('Karton penuh (12 L)')).toBeFocused()
  await field('Karton penuh (12 L)').fill('2')
  await button('L').click()
  await field('Karton terbuka (L)').fill('5')
  await expect(page.getByText('= 29.000 ml')).toBeVisible()
  await shot('hitung-isi')
  await button('Simpan, pindai berikutnya').click()
  // The camera still sees the same carton: it must not open that bahan again.
  await page.waitForTimeout(2500)
  await expect(heading('Hitung: Kulkas bar')).toBeVisible()
  await page.getByRole('button', { name: /^Susu Oat/ }).click()
  await field('Karton penuh (6 L)').fill('1')
  await button('Simpan, pindai berikutnya').click()
  await expect(page.getByText('Sudah dihitung (2)')).toBeVisible()
  await shot('hitung-daftar')

  // 4. A code nobody has linked yet.
  await field('Ketik kode atau cari nama bahan').fill(NEW_CODE)
  await field('Ketik kode atau cari nama bahan').press('Enter')
  await field('Cari bahan').fill('sirup')
  await page.getByRole('button', { name: /^Sirup Vanila/ }).click()
  await button('dus 6 pcs').click()
  await shot('kode-baru')
  await button('Simpan').click()
  await expect(page.getByText('Bahan ini tercatat di area Rak bar. Tambahkan ke hitungan ini?')).toBeVisible()
  await shot('area-lain')
  await button('Batal').click()
  assert.deepEqual(world.barcodes.find((b) => b.code === NEW_CODE), { code: NEW_CODE, stockId: 'sirup-vanila', pack: 'dus' }, 'the new code reached the server')

  // 5. Send the count.
  await button('Kirim untuk ditinjau').click()
  await expect(button('Kirim')).toBeVisible()
  await shot('hitung-kirim')
  await button('Kirim').click()
  await expect(page.getByText('Terkirim hari ini')).toBeVisible()
  await shot('hitung-terkirim')
  const count = world.ops.find((o) => o.kind === 'count.submit')
  // Lines keep the walk order: by area, then by name.
  assert.deepEqual(count.payload.lines, [{ stockId: 'susu-oat', counted: 6_000_000, reason: '' }, { stockId: 'susu-uht', counted: 29_000_000, reason: '' }], 'the count arrived as Takar expects it')
  assert.equal(count.payload.area, 'Kulkas bar')

  // 6. A delivery.
  await calm()
  await button('Terima barang').click()
  await field('Pemasok / nota').fill('CV Susu Jaya, nota 1203')
  await field('Ketik kode atau cari nama bahan').fill(CARTON)
  await field('Ketik kode atau cari nama bahan').press('Enter')
  await expect(field('Harga per karton (Rp)')).toHaveValue('234000')
  await field('Jumlah (karton)').fill('3')
  await shot('terima-baris')
  await button('Tambah').click()
  await field('Ketik kode atau cari nama bahan').fill('kopi')
  await page.getByRole('button', { name: /^Biji Kopi House Blend/ }).click()
  await field('Jumlah (bungkus)').fill('50')
  await button('Tambah').click()
  await expect(page.getByText('50 bungkus itu 10× kiriman biasa (5 bungkus).')).toBeVisible()
  let photo = true
  try {
    await button('Foto nota (opsional)').click()
    await button('Ambil foto').click()
    await expect(page.getByText('Foto nota terlampir.')).toBeVisible({ timeout: 8000 })
  } catch {
    photo = false
    if (await button('Batal').isVisible()) await button('Batal').click()
  }
  await button('Ya, 50 benar').scrollIntoViewIfNeeded()
  await shot('terima-daftar')
  await button('Ubah').click()
  await field('Jumlah (bungkus)').fill('5')
  await button('Simpan').click()
  await page.getByRole('button', { name: /^Masukkan ke stok/ }).click()
  await expect(page.getByText(/^Kiriman CV Susu Jaya/)).toBeVisible()
  const delivered = world.ops.filter((o) => o.kind === 'stock.record')
  assert.deepEqual(delivered.map((o) => [o.payload.stockId, o.payload.qty, o.payload.cost, o.payload.kind, o.payload.fromDrawer, o.payload.reason]), [
    ['susu-uht', 36_000_000, 702_000, 'purchase', false, 'CV Susu Jaya, nota 1203'],
    ['biji-kopi', 5_000_000, 1_250_000, 'purchase', false, 'CV Susu Jaya, nota 1203'],
  ], 'the delivery arrived as two stock entries')
  const note = delivered[0].payload.photo
  if (photo) assert.ok(/^data:image\/webp;base64,/.test(note) && note.length <= 70_000 && !delivered[1].payload.photo, 'the note photo fits the server limit and rides on the first line only')
  await shot('beranda-terkirim')

  // 7. No signal: the work waits on the phone, then goes out.
  world.offline = true
  await button('Hitung stok').click()
  await button('Gudang').click()
  await button('Mulai menghitung').click()
  await page.getByRole('button', { name: /^Air Mineral Botol/ }).click()
  await field('Dus penuh (24 pcs)').fill('3')
  await button('Simpan, pindai berikutnya').click()
  await button('Kirim untuk ditinjau').click()
  await button('Kirim').click()
  await expect(page.getByText('1 belum terkirim')).toBeVisible()
  await expect(page.getByText('Disimpan di ponsel. Terkirim saat ada sinyal.')).toBeVisible()
  await shot('belum-terkirim')
  world.offline = false
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(page.getByText('Tersinkron')).toBeVisible({ timeout: 10_000 })
  assert.ok(world.ops.some((o) => o.kind === 'count.submit' && o.payload.area === 'Gudang'), 'the queued count went out once the signal came back')

  // 8. A refusal from Takar.
  world.rejectNext = true
  await button('Hitung stok').click()
  await button('Freezer').click()
  await button('Mulai menghitung').click()
  await page.getByRole('button', { name: /^Ayam Fillet/ }).click()
  await field('Pak penuh (1 kg)').fill('4')
  await button('Simpan, pindai berikutnya').click()
  await button('Kirim untuk ditinjau').click()
  await button('Kirim').click()
  await page.getByRole('button', { name: /^Perlu perhatian \(1\)/ }).click()
  await expect(page.getByText('Catatan ini tertunda lebih dari 7 hari, atau jam ponsel salah.', { exact: false })).toBeVisible()
  await shot('perlu-perhatian')
  await button('Kirim ulang').click()
  await expect(page.getByText('Tidak ada catatan yang ditolak.')).toBeVisible()

  await browser.close()
  site.close()
  console.log(`${n} screenshots in docs/panduan/shots`)
  console.log(`camera scan opened the bahan by itself: ${scanned ? 'yes' : 'NO (typed the code instead)'}`)
  console.log(`note photo taken and shrunk: ${photo ? `yes, ${note.length} characters` : 'NO'}`)
  console.log(`operations the server received: ${world.ops.map((o) => `${o.kind} by ${o.by}`).join('; ')}`)
  console.log(`browser errors: ${problems.length ? problems.join(' | ') : 'none'}`)
}

async function pdf() {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(pathToFileURL(resolve('docs/panduan/index.html')).href)
    await page.evaluate(() => document.fonts.ready)
    await page.pdf({ path: resolve('docs/Panduan-Takar-Stok.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true })
    console.log('docs/Panduan-Takar-Stok.pdf written')
  } finally {
    await browser.close()
  }
}

if (!pdfOnly) await screenshots()
await pdf().catch((e) => console.error(`PDF not written: ${e.message.split('\n')[0]}`))
process.exit(process.exitCode ?? 0)
