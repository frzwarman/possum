// QA 2026-11-25, cluster voids: what a manager's approval to void covers (SEC-1), a void that never raises the bill
// (CT-02, DSC-4, TILL-13) and prices the discount by what the order was sold with (SQL-08, CT-05), one trim rule for the
// reason (CT-04), the revision check that no longer waves a missing revision through (SQL-15) and the 'discard' approval.
// Run by scripts/test-db.mjs.
import { readFile } from "node:fs/promises";
export default async ({ db, test, login, read, send, assert, randomUUID, menu, line, world }) => {
  const PIN = "482915", refusal = /Manager approval required/;
  // Every item the checks ring, priced in the catalog: the server turns down a line whose price is not its catalog version's.
  const priced = [["Nasi", 25000], ["Teh", 8000], ["Kopi", 12000], ["A", 30000], ["B", 30000], ["C", 18000], ["D", 36000], ["A", 25000], ["B", 6000], ["Mie", 120000], ["Teh", 10000]];
  const catalog = priced.map(([name, price]) => ({ id: `${name}-${price}`, name, category: "Makanan", type: "food", price, active: true, soldOut: false, favorite: false, recipe: [], modifiers: [], version: 1 }));
  const item = (name, price) => line(catalog.find((m) => m.id === `${name}-${price}`), 1, price);
  const bill = (sub, off) => ({ subtotal: sub, discount: off, service: 0, tax: 0, total: sub - off });
  // A restaurant of its own: the cashier's shift open, the manager's PIN set. sold() rings, sends to the station and (paid) takes cash.
  async function till(name, extra) {
    const w = await world(name, extra);
    await send(w.op("catalog.publish", { menu: catalog, stock: [] }));
    await w.as(w.people.manager);
    await db.query("select public.set_approval_pin($1)", [PIN]);
    await w.as(w.people.cashier);
    const shift = randomUUID();
    await send(w.op("shift.open", { id: shift, opening: 0 }));
    w.sold = async (lines, more = {}, paid = false, approval) => {
      const sub = lines.reduce((n, l) => n + l.price * l.qty, 0), off = more.discount ?? 0, o = w.order(shift, lines, bill(sub, off), more);
      if (approval) o.payload.approval = approval;
      await send(o);
      const id = o.payload.order.id;
      await send(w.op("order.prepare", { id, expectedRevision: 1, lineIds: lines.map((l) => l.id) }));
      if (paid) await send(w.op("payment.record", { id, expectedRevision: 2, method: "cash", tendered: sub - off, verified: true }));
      return { id, lines, rev: paid ? 3 : 2 };
    };
    w.stored = async (id) => (await read("select snapshot,revision,status from public.orders where restaurant_id=$1 and id=$2", [w.rid, id])).rows[0];
    // The cashier asks the manager's PIN for this; the old web app asks 'void' with no amount.
    w.pin = async (action, order, amount = null, lineId = null) => (await db.query("select public.approve($1,$2,$3,$4,$5,$6) as r", [w.people.manager, PIN, action, order, amount, lineId])).rows[0].r.id;
    w.void = (o, lineId, more = {}) => w.op("order.voidline", { id: o.id, lineId, reason: "Salah menu", expectedRevision: o.rev, ...more });
    return w;
  }

  await test("QA voids SEC-1: an approval for one line voids that line only, an approval for the order's total voids the whole order only", async () => {
    const w = await till("Warung Setuju");
    const o = await w.sold([item("Nasi", 25000), item("Teh", 8000)]), [nasi, tea] = o.lines;
    // What the manager approved: the tea, 8.000. Not the nasi, not the whole order, not another amount.
    const a = await w.pin("voidline", o.id, 8000, tea.id);
    await assert.rejects(send(w.void(o, nasi.id, { approval: a })), refusal);
    await assert.rejects(send(w.op("order.void", { id: o.id, expectedRevision: o.rev, reason: "x", approval: a })), refusal);
    for (const [amount, lineId] of [[25000, nasi.id], [9000, tea.id], [8000, nasi.id]]) await assert.rejects(send(w.void(o, tea.id, { approval: await w.pin("voidline", o.id, amount, lineId) })), refusal);
    await assert.rejects(send(w.void(o, tea.id, { approval: await w.pin("void", o.id, 8000) })), refusal);
    await assert.rejects(send(w.void(o, tea.id, { approval: await w.pin("voidline", randomUUID(), 8000, tea.id) })), refusal);
    await send(w.void(o, tea.id, { approval: a }));
    let s = await w.stored(o.id);
    assert.deepEqual([s.snapshot.lines.find((l) => l.id === tea.id).voidApprovedBy, s.snapshot.totals.total], ["manager", 25000]);
    await assert.rejects(send(w.op("order.void", { id: o.id, expectedRevision: 3, reason: "x", approval: a })), refusal);
    // The whole order: bound to its total. The approval for a line is not one for the order and the other way round.
    await assert.rejects(send(w.op("order.void", { id: o.id, expectedRevision: 3, reason: "Salah meja", approval: await w.pin("void", o.id, 33000) })), refusal);
    await assert.rejects(send(w.op("order.void", { id: o.id, expectedRevision: 3, reason: "Salah meja", approval: await w.pin("voidline", o.id, 25000, nasi.id) })), refusal);
    const all = await w.pin("void", o.id, 25000);
    await send(w.op("order.void", { id: o.id, expectedRevision: 3, reason: "Salah meja", approval: all }));
    s = await w.stored(o.id);
    assert.deepEqual([s.status, s.snapshot.voidApprovedBy], ["void", "manager"]);
  });

  await test("QA voids SEC-1: a voidline approval needs its order, line and value; the Telegram request carries the line and tells the manager what it is", async () => {
    const w = await till("Warung Telegram");
    const o = await w.sold([item("Nasi", 25000), item("Teh", 8000)]), tea = o.lines[1];
    for (const args of [[null, 8000, tea.id], [o.id, null, tea.id], [o.id, 8000, null]]) await assert.rejects(w.pin("voidline", ...args), /needs the order, the line and its value/);
    await assert.rejects(db.query("select public.request_approval('voidline',$1,null,'Batalkan teh')", [o.id]), /needs the order, the line and its value/);
    const id = (await db.query("select public.request_approval('voidline',$1,8000,'Batalkan 1× Teh · Salah menu',$2) as id", [o.id, tea.id])).rows[0].id;
    const asked = (await read("select public.telegram_request($1) as r", [id])).rows[0].r;
    assert.deepEqual([asked.action, asked.amount, asked.line, asked.order.total], ["voidline", 8000, { name: "Teh", qty: 1, total: 8000 }, 33000]);
    const tg = Math.floor(Math.random() * 1e9) + 1e9;
    await read("insert into public.telegram_links(restaurant_id,user_id,telegram_id,chat_id) values($1,$2,$3,1)", [w.rid, w.people.manager, tg]);
    assert.equal((await read("select public.decide_approval($1,$2,true) as r", [id, tg])).rows[0].r.status, "approved");
    const approval = (await db.query("select public.approval_request($1) as r", [id])).rows[0].r.id;
    await assert.rejects(send(w.void(o, o.lines[0].id, { approval })), refusal);
    await send(w.void(o, tea.id, { approval }));
  });

  await test("QA voids SEC-1: the web app deployed before this asks 'void' with no amount and is still accepted; supabase/pending/voids_strict.sql ends that", async () => {
    const w = await till("Warung Lama");
    const a = await w.sold([item("Nasi", 25000), item("Teh", 8000), item("Kopi", 12000)]);
    // Old form: one 'void' approval for the order voids a line, and another one the whole order.
    await send(w.void(a, a.lines[1].id, { approval: await w.pin("void", a.id) }));
    await send(w.op("order.void", { id: a.id, expectedRevision: 3, reason: "Salah meja", approval: await w.pin("void", a.id) }));
    const b = await w.sold([item("Nasi", 25000), item("Teh", 8000), item("Kopi", 12000)]);
    await read(await readFile("supabase/pending/voids_strict.sql", "utf8"));
    try {
      await assert.rejects(send(w.void(b, b.lines[1].id, { approval: await w.pin("void", b.id) })), refusal);
      await assert.rejects(send(w.op("order.void", { id: b.id, expectedRevision: 2, reason: "Salah meja", approval: await w.pin("void", b.id) })), refusal);
      await send(w.void(b, b.lines[1].id, { approval: await w.pin("voidline", b.id, 8000, b.lines[1].id) }));
      await send(w.op("order.void", { id: b.id, expectedRevision: 3, reason: "Salah meja", approval: await w.pin("void", b.id, 37000) }));
    } finally {
      await read("create or replace function public.voids_strict() returns boolean language sql immutable set search_path='' as $$ select false $$");
    }
  });

  await test("QA voids CT-02, DSC-4, TILL-13: a void never raises the bill and never fails because of a discount", async () => {
    const voucher = { id: "v", name: "Voucher Rp25.000", note: "", kind: "amount", value: 25000, scope: "order", from: "2026-01-01", to: "2099-12-31", minSpend: 100000 };
    const free = { ...voucher, id: "f", name: "Voucher Rp25.000 tanpa minimum", minSpend: 0 };
    const w = await till("Warung Voucher", { discounts: [voucher, free] });
    // CT-02: Rp114.000 with a Rp25.000 voucher (minimum Rp100.000), paid. The Rp18.000 item goes: the rest is under the minimum,
    // but the guest still pays Rp89.000 less what they had (never more).
    const a = await w.sold([item("A", 30000), item("B", 30000), item("C", 18000), item("D", 36000)], { discountId: "v", discount: 25000, discountReason: voucher.name }, true);
    await w.as(w.people.manager);
    await send(w.void(a, a.lines[2].id));
    let s = await w.stored(a.id);
    assert.deepEqual(s.snapshot.totals, bill(96000, 7000));
    assert.ok(s.snapshot.totals.total <= 89000);
    // DSC-4: the voucher is deleted after the order was sent; the item that goes leaves less than the amount it had.
    await w.as(w.people.cashier);
    const b = await w.sold([item("A", 25000), item("B", 6000)], { discountId: "f", discount: 25000, discountReason: free.name });
    await read("update public.restaurants set settings=settings||'{\"discounts\":[]}' where id=$1", [w.rid]);
    await w.as(w.people.manager);
    await send(w.void(b, b.lines[0].id));
    s = await w.stored(b.id);
    assert.deepEqual(s.snapshot.totals, bill(6000, 6000));
    // TILL-13: a manual Rp20.000 off Rp31.000, the Rp25.000 item goes.
    await w.as(w.people.cashier);
    const c = await w.sold([item("A", 25000), item("B", 6000)], { discount: 20000, discountReason: "Teman" }, false, await w.pin("discount", null, 20000));
    await w.as(w.people.manager);
    await send(w.void(c, c.lines[0].id));
    s = await w.stored(c.id);
    assert.deepEqual(s.snapshot.totals, bill(6000, 6000));
  });

  await test("QA voids SQL-08, CT-05: the discount follows the lines left by the definition the order was sold with, not today's", async () => {
    const promo = (value) => ({ id: "p", name: "Promo", note: "", kind: "percent", value, scope: "order", from: "2026-01-01", to: "2099-12-31" });
    const w = await till("Warung Promo", { discounts: [promo(10)] });
    const a = await w.sold([item("Mie", 120000), item("Teh", 10000)], { discountId: "p", discount: 13000, discountReason: "Promo" }, true);
    // The manager edits the promo to 50% mid-shift; the paid order keeps its 10%.
    await read("update public.restaurants set settings=settings||jsonb_build_object('discounts',$2::jsonb) where id=$1", [w.rid, JSON.stringify([promo(50)])]);
    await w.as(w.people.manager);
    await send(w.void(a, a.lines[1].id));
    const s = await w.stored(a.id);
    assert.deepEqual(s.snapshot.totals, bill(120000, 12000));
    // A manual discount with a rule follows it too; one without keeps the amount it had, capped at what is left.
    await w.as(w.people.cashier);
    const rule = { kind: "percent", value: 10, scope: "order" };
    const b = await w.sold([item("Mie", 120000), item("Teh", 10000)], { discountRule: rule, discount: 13000, discountReason: "Teman" }, false, await w.pin("discount", null, 13000));
    await w.as(w.people.manager);
    await send(w.void(b, b.lines[1].id));
    assert.deepEqual((await w.stored(b.id)).snapshot.totals, bill(120000, 12000));
  });

  await test("QA voids CT-04: the reason is trimmed the way the till trims it, line breaks and no-break spaces included", async () => {
    const w = await till("Warung Alasan");
    for (const [reason, kept] of [["Gelas tumpah\n", "Gelas tumpah"], [" Salah\tmenu  ", "Salah\tmenu"], ["  x  ", "x"]]) {
      await w.as(w.people.cashier);
      const o = await w.sold([item("Nasi", 25000), item("Teh", 8000)]);
      await w.as(w.people.manager);
      await send(w.void(o, o.lines[1].id, { reason }));
      assert.equal((await w.stored(o.id)).snapshot.lines[1].voidReason, kept);
    }
    await w.as(w.people.cashier);
    const o = await w.sold([item("Nasi", 25000), item("Teh", 8000)]);
    await w.as(w.people.manager);
    for (const reason of ["\n", "   ", "", "x".repeat(301)]) await assert.rejects(send(w.void(o, o.lines[1].id, { reason })), /Invalid line void/);
  });

  await test("QA voids SQL-15: a void, refund, payment or preparation with no expectedRevision is a revision conflict", async () => {
    const w = await till("Warung Revisi");
    const o = await w.sold([item("Nasi", 25000), item("Teh", 8000)], {}, true);
    for (const expectedRevision of [undefined, null]) {
      const more = { expectedRevision };
      await assert.rejects(send(w.op("refund.record", { id: o.id, reason: "x", ...more })), /Order revision conflict/);
      await assert.rejects(send(w.op("payment.record", { id: o.id, method: "cash", tendered: 33000, verified: true, ...more })), /Order revision conflict/);
      await assert.rejects(send(w.op("order.prepare", { id: o.id, lineIds: [o.lines[0].id], ...more })), /Order revision conflict/);
      await w.as(w.people.manager);
      await assert.rejects(send(w.op("order.voidline", { id: o.id, lineId: o.lines[1].id, reason: "x", ...more })), /Order revision conflict/);
      await assert.rejects(send(w.op("order.void", { id: o.id, reason: "x", ...more })), /Order revision conflict/);
      await w.as(w.people.cashier);
    }
    await send(w.op("refund.record", { id: o.id, reason: "x", expectedRevision: 3, approval: await w.pin("refund", o.id) }));
  });

  await test("QA voids: the 'discard' approval exists, carries no order, line or amount, and no operation consumes it", async () => {
    const w = await till("Warung Buang");
    const o = await w.sold([item("Nasi", 25000), item("Teh", 8000)]);
    const id = await w.pin("discard", o.id, 5000, o.lines[0].id);
    assert.deepEqual((await read("select action,order_id,amount,line_id,operation_id from public.approvals where id=$1", [id])).rows[0], { action: "discard", order_id: null, amount: null, line_id: null, operation_id: null });
    const asked = (await db.query("select public.request_approval('discard',$1,5000,'Lepas antrean') as id", [o.id])).rows[0].id;
    assert.deepEqual((await read("select action,order_id,amount,line_id from public.approval_requests where id=$1", [asked])).rows[0], { action: "discard", order_id: null, amount: null, line_id: null });
    await assert.rejects(send(w.void(o, o.lines[1].id, { approval: id })), refusal);
    await assert.rejects(send(w.op("order.void", { id: o.id, expectedRevision: 2, reason: "x", approval: id })), refusal);
  });
};
