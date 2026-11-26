// Takar's Telegram bot for owners and managers. Three callers, each proving who it is:
//  - Telegram (webhook): header x-telegram-bot-api-secret-token must equal TELEGRAM_WEBHOOK_SECRET
//  - pg_cron (morning report, alerts): header x-cron-secret must equal CRON_SECRET
//  - the till (ask a manager): the signed-in user's JWT, checked by the database in request_approval
// Everything else is refused. Messages are plain text, so nothing a cashier types becomes markup.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

const env = (key: string) => Deno.env.get(key) ?? "";
const url = env("SUPABASE_URL");
const admin = createClient(url, env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const rp = (n: number) => `Rp${new Intl.NumberFormat("id-ID").format(n)}`;
const label: Record<string, string> = {
  discount: "Diskon",
  void: "Pembatalan",
  voidline: "Pembatalan item",
  discard: "Lepas antrean",
  refund: "Refund",
  cashout: "Kas keluar",
  count: "Hitung stok",
  variance: "Selisih kas",
  publish: "Menu tanpa resep",
};
const status: Record<string, string> = { open: "Belum dibayar", paid: "Lunas", void: "Dibatalkan", refunded: "Dikembalikan" };

async function tg(method: string, body: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${env("TELEGRAM_BOT_TOKEN")}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) console.error(method, r.status, await r.text());
  return r.ok;
}
const send = (chat: number, text: string, extra: Record<string, unknown> = {}) =>
  tg("sendMessage", { chat_id: chat, text, ...extra });

async function rpc<T>(fn: string, args: Record<string, unknown> = {}, client: SupabaseClient = admin): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

// The till: create the request as the signed-in cashier, then message every linked owner and manager.
async function ask(req: Request) {
  const user = createClient(url, env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: req.headers.get("Authorization")! } },
    auth: { persistSession: false },
  });
  const { action, orderId, amount, what, lineId } = await req.json();
  const id = await rpc<string>("request_approval", { action, order_id: orderId ?? null, amount: amount ?? null, what, line_id: lineId ?? null }, user);
  const r = await rpc<{
    action: string;
    amount: number | null;
    what: string;
    by: string;
    chats: number[];
    order: { receipt: string; label: string; status: string; total: number; items: string | null } | null;
    line: { name: string; qty: number; total: number } | null;
    count: { area: string; lines: number } | null;
  } | null>("telegram_request", { request: id });
  if (!r) return json({ id, sent: 0 });
  // What the approval is bound to comes from the server and goes first; the requester's own words are only a note.
  // Telegram refuses a message over 4096 characters, so a long order's items are cut.
  const o = r.order, items = o?.items && o.items.length > 1500 ? `${o.items.slice(0, 1500)}…` : o?.items;
  const text = [
    `Persetujuan: ${label[r.action] ?? r.action}`,
    o ? `Pesanan #${o.receipt.slice(-6).toUpperCase()}${o.label ? ` · ${o.label}` : ""} · ${status[o.status] ?? o.status} · ${rp(o.total)}` : "",
    items ? `Isi: ${items}` : "",
    r.line ? `Item dibatalkan: ${r.line.qty}× ${r.line.name} · ${rp(r.line.total)}` : "",
    r.count ? `Hitung stok ${r.count.area}: ${r.count.lines} bahan` : "",
    r.amount != null ? `Nominal: ${rp(r.amount)}` : "",
    `Catatan kasir: ${r.what}`,
    `Diminta oleh ${r.by}. Berlaku 5 menit.`,
  ].filter(Boolean).join("\n");
  const buttons = { inline_keyboard: [[{ text: "Setujui", callback_data: `ok:${id}` }, { text: "Tolak", callback_data: `no:${id}` }]] };
  const sent = (await Promise.all(r.chats.map((c) => send(c, text, { reply_markup: buttons })))).filter(Boolean).length;
  return json({ id, sent });
}

type Update = {
  message?: { text?: string; chat: { id: number; type: string }; from: { id: number } };
  callback_query?: { id: string; data?: string; from: { id: number }; message?: { text?: string; message_id: number; chat: { id: number } } };
};
async function update(u: Update) {
  const m = u.message, q = u.callback_query;
  if (m?.text?.startsWith("/start")) {
    if (m.chat.type !== "private") return send(m.chat.id, "Hubungkan Takar lewat chat pribadi dengan bot ini, bukan grup.");
    const code = m.text.split(" ")[1]?.trim();
    if (!code) return send(m.chat.id, "Buka Takar, ketuk Telegram di bagian akun Anda, lalu Hubungkan untuk menautkan akun ini.");
    const r = await rpc<{ name?: string; restaurant?: string; error?: string }>("telegram_link", { code, telegram_id: m.from.id, chat_id: m.chat.id });
    return send(
      m.chat.id,
      r.error
        ? "Kode tidak berlaku atau sudah kedaluwarsa. Buat kode baru di Takar."
        : `Terhubung sebagai ${r.name} di ${r.restaurant}. Permintaan persetujuan, laporan pagi dan peringatan akan masuk ke sini.`,
    );
  }
  const pick = q?.data?.match(/^(ok|no):([0-9a-f-]{36})$/);
  if (q && pick) {
    const r = await rpc<{ status?: string; by?: string; already?: boolean; error?: string }>("decide_approval", {
      request: pick[2],
      telegram_id: q.from.id,
      accept: pick[1] === "ok",
    });
    const result = r.error === "role"
      ? "Akun Telegram ini tidak terhubung ke manajer aktif."
      : r.error
      ? "Permintaan tidak ditemukan."
      : r.status === "expired"
      ? "Kedaluwarsa: tidak dijawab dalam 5 menit."
      : `${r.status === "approved" ? "Disetujui" : "Ditolak"} oleh ${r.by}${r.already ? " (sudah dijawab)" : ""}.`;
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: result });
    if (q.message && !r.error) {
      await tg("editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text: `${q.message.text ?? ""}\n\n${result}` });
    }
    return;
  }
  if (m?.chat.type === "private") await send(m.chat.id, "Bot ini hanya mengirim persetujuan, laporan dan peringatan dari Takar.");
}

type Report = {
  restaurant: string;
  chats: number[];
  day: string;
  report: { sales: number; transactions: number; discounts: number; compliments: number; refunds: number; outstanding: number; bestSellers: { name: string; quantity: number }[] };
};
function reportText({ restaurant, day, report: r }: Report) {
  const date = new Date(`${day}T12:00:00Z`).toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const top = r.bestSellers.slice(0, 3).map((b) => `${b.name} ×${b.quantity}`).join(", ");
  return [
    `Laporan ${restaurant}, ${date}`,
    `Penjualan ${rp(r.sales)} dari ${r.transactions} transaksi`,
    r.discounts ? `Diskon ${rp(r.discounts)}` : "",
    r.compliments ? `Kompliment ${rp(r.compliments)}` : "",
    r.refunds ? `Refund ${rp(r.refunds)}` : "",
    r.outstanding ? `Belum dibayar ${rp(r.outstanding)}` : "",
    top ? `Terlaris: ${top}` : "",
  ].filter(Boolean).join("\n");
}
type Alerts = { restaurant: string; chats: number[]; alerts: { cashier: string; variance: number; limit: number; approvedBy: string | null }[] };
const alertText = (restaurant: string, a: Alerts["alerts"][number]) =>
  `Peringatan ${restaurant}: kas ${a.variance < 0 ? "kurang" : "lebih"} ${rp(Math.abs(a.variance))} saat ${a.cashier} menutup sif (batas ${rp(a.limit)})` +
  (a.approvedBy ? `, disetujui ${a.approvedBy}.` : ".");

async function cron(job: string) {
  if (job === "report") {
    for (const x of await rpc<Report[]>("telegram_report")) for (const c of x.chats) await send(c, reportText(x));
  } else if (job === "alerts") {
    for (const x of await rpc<Alerts[]>("telegram_alerts")) for (const a of x.alerts) for (const c of x.chats) await send(c, alertText(x.restaurant, a));
  } else return json({ error: "Unknown job" }, 400);
  return json({ ok: true });
}

// A secret shorter than 16 characters counts as not set, so an empty variable never opens a door.
const holds = (req: Request, header: string, name: string) => env(name).length >= 16 && req.headers.get(header) === env(name);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (holds(req, "x-telegram-bot-api-secret-token", "TELEGRAM_WEBHOOK_SECRET")) {
    // Always 200 to Telegram, or it retries the same update for hours.
    try {
      await update(await req.json());
    } catch (e) {
      console.error(e);
    }
    return json({ ok: true });
  }
  try {
    if (holds(req, "x-cron-secret", "CRON_SECRET")) return await cron((await req.json()).job);
    if (req.headers.get("Authorization")?.startsWith("Bearer ")) return await ask(req);
    return json({ error: "Unauthorized" }, 401);
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : "Failed" }, 400);
  }
});
