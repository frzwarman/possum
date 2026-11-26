// QA 2026-11-25, cluster counts: stock counts (count.submit, count.record) and the Stok page's stock.record.
// A count measures the shelf at the moment it was taken, so approving it later keeps what moved since. Run by
// scripts/test-db.mjs.
export default async ({ db, test, read, send, assert, randomUUID, menu, line, world }) => {
  const HOUR = 3_600_000;
  // The same operation, as a device that made it `ms` ago sends it now.
  const ago = (o, ms) => ({ ...o, occurredAt: new Date(Date.now() - ms).toISOString() });
  const qty = async (w, stock) => Number((await read("select coalesce(sum(qty),0)::text as q from public.stock_movements where restaurant_id=$1 and stock_id=$2", [w.rid, stock])).rows[0].q);
  const count = async (id) => (await read("select status,approver,lines,occurred_at,operation_id from public.counts where id=$1", [id])).rows[0];
  const buy = (w, stock, amount, ms = 0) => send(ago(w.op("stock.record", { stockId: stock, kind: "purchase", qty: amount, cost: 0, fromDrawer: false, reason: "Kiriman" }), ms));
  const pin = async (w, approver, code = "482915") => { await w.as(approver); await db.query("select public.set_approval_pin($1)", [code]); };
  const approve = async (approver, code, id) => (await db.query("select public.approve($1,$2,'count',$3,null) as r", [approver, code, id])).rows[0].r;

  await test("QA counts CT-01, SQL-03, STK-01, STN-01: a count approved later books the gap at the time it was counted; the sale and the delivery since then stay", async () => {
    const w = await world("Warung Hitung"), id = randomUUID();
    await buy(w, "rice", 10_000_000, 3 * HOUR);
    // 2 h ago the kitchen counts 9,5 kg of rice (500 g short) and sends it.
    await w.as(w.people.kitchen);
    const submit = ago(w.op("count.submit", { id, area: "Dry store", lines: [{ stockId: "rice", counted: 9_500_000, reason: "" }] }), 2 * HOUR);
    await send(submit);
    // The waiting count already says what the books held when it was counted: the review shows this, on any device.
    assert.deepEqual((await count(id)).lines, [{ stockId: "rice", counted: 9_500_000, reason: "", expected: 10_000_000, at: submit.occurredAt }]);
    // Since then: three nasi goreng cooked (300 g) and a 5 kg delivery.
    await w.as(w.people.cashier);
    const shift = randomUUID();
    await send(w.op("shift.open", { id: shift, opening: 0 }));
    const order = w.order(shift, [{ ...line(menu, 1, 25000), qty: 3 }], { subtotal: 75000, discount: 0, service: 0, tax: 0, total: 75000 });
    await send(order);
    await send(w.op("order.prepare", { id: order.payload.order.id, expectedRevision: 1, lineIds: [order.payload.order.lines[0].id] }));
    await w.as(w.people.admin);
    await buy(w, "rice", 5_000_000);
    assert.equal(await qty(w, "rice"), 14_700_000);
    // Now the manager approves the count from the laptop.
    await w.as(w.people.manager);
    const record = w.op("count.record", { id, area: "Dry store", lines: [{ stockId: "rice", counted: 9_500_000, reason: "tumpah" }] });
    await send(record);
    assert.equal(await qty(w, "rice"), 14_200_000, "9,5 kg counted, 300 g cooked and 5 kg delivered since");
    const move = (await read("select qty::int as qty,reason,occurred_at from public.stock_movements where restaurant_id=$1 and kind='count'", [w.rid])).rows;
    assert.deepEqual(move.map((m) => [m.qty, m.reason, new Date(m.occurred_at).toISOString()]), [[-500_000, "Hitung Dry store: tumpah", submit.occurredAt]]);
    const c = await count(id);
    assert.deepEqual([c.status, c.approver, c.lines], ["approved", "manager", [{ stockId: "rice", expected: 10_000_000, counted: 9_500_000, reason: "tumpah", at: submit.occurredAt }]]);
    // The count row itself is stamped with the approval, as before (pull reports it as approvedAt).
    assert.equal(new Date(c.occurred_at).toISOString(), record.occurredAt);
    await w.as(w.people.owner);
  });

  await test("QA counts: a count with no submit is taken at its own time, and a count on the Stok page (stock.record) likewise", async () => {
    const w = await world("Warung Hitung Langsung");
    await buy(w, "rice", 10_000_000, 3 * HOUR);
    await buy(w, "egg", 50_000, 3 * HOUR);
    // The manager's laptop was offline for an hour: both counts were made then, a delivery of each arrived meanwhile.
    await buy(w, "rice", 2_000_000);
    await buy(w, "egg", 10_000);
    const id = randomUUID();
    await send(ago(w.op("count.record", { id, area: "Dry store", lines: [{ stockId: "rice", counted: 9_000_000, reason: "" }] }), HOUR));
    await send(ago(w.op("stock.record", { stockId: "egg", kind: "count", qty: 48_000, cost: 0, fromDrawer: false, reason: "hitung ulang rak" }), HOUR));
    assert.deepEqual([await qty(w, "rice"), await qty(w, "egg")], [11_000_000, 58_000]);
    assert.deepEqual((await count(id)).lines.map((l) => [l.expected, l.counted]), [[10_000_000, 9_000_000]]);
  });

  await test("QA counts: two counts waiting at once do not book the same gap twice, in either order of approval", async () => {
    const w = await world("Warung Dua Hitungan"), a = randomUUID(), b = randomUUID();
    await buy(w, "rice", 10_000_000, 4 * HOUR);
    await w.as(w.people.kitchen);
    await send(ago(w.op("count.submit", { id: a, area: "Dry store", lines: [{ stockId: "rice", counted: 9_500_000, reason: "" }] }), 3 * HOUR));
    // An hour later the shelf is counted again and still holds 9,5 kg.
    await send(ago(w.op("count.submit", { id: b, area: "Dry store", lines: [{ stockId: "rice", counted: 9_500_000, reason: "" }] }), 2 * HOUR));
    await w.as(w.people.owner);
    await send(w.op("count.record", { id: a, area: "Dry store", lines: [{ stockId: "rice", counted: 9_500_000, reason: "" }] }));
    await send(w.op("count.record", { id: b, area: "Dry store", lines: [{ stockId: "rice", counted: 9_500_000, reason: "" }] }));
    assert.equal(await qty(w, "rice"), 9_500_000);
    assert.deepEqual((await count(b)).lines.map((l) => [l.expected, l.counted]), [[9_500_000, 9_500_000]]);
    // The later count approved first: the earlier one, approved afterwards, is still measured at its own time.
    const w2 = await world("Warung Dua Hitungan Terbalik"), c = randomUUID(), d = randomUUID();
    await buy(w2, "rice", 10_000_000, 4 * HOUR);
    await send(ago(w2.op("count.submit", { id: c, area: "Dry store", lines: [{ stockId: "rice", counted: 9_500_000, reason: "" }] }), 3 * HOUR));
    await send(ago(w2.op("count.submit", { id: d, area: "Dry store", lines: [{ stockId: "rice", counted: 9_500_000, reason: "" }] }), 2 * HOUR));
    await send(w2.op("count.record", { id: d, area: "Dry store", lines: [{ stockId: "rice", counted: 9_500_000, reason: "" }] }));
    await send(w2.op("count.record", { id: c, area: "Dry store", lines: [{ stockId: "rice", counted: 9_500_000, reason: "" }] }));
    assert.equal(await qty(w2, "rice"), 9_000_000 + 500_000, "the earlier count adds back nothing and takes nothing more");
  });

  await test("QA counts: a recount sent again keeps the time of the lines that were not recounted", async () => {
    const w = await world("Warung Hitung Ulang"), id = randomUUID();
    await buy(w, "rice", 10_000_000, 5 * HOUR);
    await buy(w, "egg", 50_000, 5 * HOUR);
    await w.as(w.people.kitchen);
    const first = ago(w.op("count.submit", { id, area: "Semua area", lines: [{ stockId: "rice", counted: 8_000_000, reason: "" }, { stockId: "egg", counted: 50_000, reason: "" }] }), 3 * HOUR);
    await send(first);
    // After the count 10 eggs arrive; then the flagged rice is recounted (9,4 kg) and the count is sent again.
    await w.as(w.people.owner);
    await buy(w, "egg", 10_000, 2 * HOUR);
    await w.as(w.people.kitchen);
    const again = ago(w.op("count.submit", { id, area: "Semua area", lines: [{ stockId: "rice", counted: 9_400_000, reason: "" }, { stockId: "egg", counted: 50_000, reason: "" }] }), HOUR);
    await send(again);
    assert.deepEqual((await count(id)).lines.map((l) => [l.stockId, l.counted, l.expected, l.at]), [["rice", 9_400_000, 10_000_000, again.occurredAt], ["egg", 50_000, 50_000, first.occurredAt]]);
    await w.as(w.people.manager);
    await send(w.op("count.record", { id, area: "Semua area", lines: [{ stockId: "rice", counted: 9_400_000, reason: "tumpah" }, { stockId: "egg", counted: 50_000, reason: "" }] }));
    assert.deepEqual([await qty(w, "rice"), await qty(w, "egg")], [9_400_000, 60_000]);
    await w.as(w.people.owner);
  });

  await test("QA counts: a count submitted before this migration (lines without a time) is taken at its submit", async () => {
    const w = await world("Warung Hitungan Lama"), id = randomUUID();
    await buy(w, "rice", 10_000_000, 3 * HOUR);
    await w.as(w.people.kitchen);
    await send(ago(w.op("count.submit", { id, area: "Dry store", lines: [{ stockId: "rice", counted: 9_500_000, reason: "" }] }), 2 * HOUR));
    // As the server before this migration stored it: the lines exactly as sent.
    await read("update public.counts set lines=$2 where id=$1", [id, JSON.stringify([{ stockId: "rice", counted: 9_500_000, reason: "" }])]);
    await w.as(w.people.owner);
    await buy(w, "rice", 5_000_000);
    await send(w.op("count.record", { id, area: "Dry store", lines: [{ stockId: "rice", counted: 9_500_000, reason: "" }] }));
    assert.equal(await qty(w, "rice"), 14_500_000);
  });

  await test("QA counts STK-02: a second approval of an approved count is accepted and changes nothing", async () => {
    const w = await world("Warung Setuju Dua Kali"), id = randomUUID();
    await pin(w, w.people.manager);
    await w.as(w.people.owner);
    await buy(w, "rice", 10_000_000, 3 * HOUR);
    await w.as(w.people.cashier);
    await send(ago(w.op("count.submit", { id, area: "Rak bar", lines: [{ stockId: "rice", counted: 9_000_000, reason: "" }] }), 2 * HOUR));
    await w.as(w.people.manager);
    await send(w.op("count.record", { id, area: "Rak bar", lines: [{ stockId: "rice", counted: 9_000_000, reason: "" }] }));
    await buy(w, "rice", 2_000_000);
    assert.equal(await qty(w, "rice"), 11_000_000);
    const before = await count(id), moves = (await read("select count(*)::int as n from public.stock_movements where restaurant_id=$1", [w.rid])).rows[0].n;
    // The till never heard: the cashier asks the manager's PIN there and approves the same count again.
    await w.as(w.people.cashier);
    const granted = await approve(w.people.manager, "482915", id);
    const second = w.op("count.record", { id, area: "Rak bar", lines: [{ stockId: "rice", counted: 9_000_000, reason: "" }], approval: granted.id });
    const answer = (await send(second)).rows[0].result;
    assert.equal(answer.id, second.id);
    // So does the owner, with other figures, and a cashier with no approval at all: nothing is refused, nothing moves.
    await send(w.op("count.record", { id, area: "Rak bar", lines: [{ stockId: "rice", counted: 9_000_000, reason: "" }] }));
    await w.as(w.people.owner);
    await send(w.op("count.record", { id, area: "Rak bar", lines: [{ stockId: "rice", counted: 1_000_000, reason: "" }] }));
    assert.equal(await qty(w, "rice"), 11_000_000);
    assert.deepEqual(await count(id), before);
    assert.equal((await read("select count(*)::int as n from public.stock_movements where restaurant_id=$1", [w.rid])).rows[0].n, moves);
    // The approval was not spent, and the operation that did nothing is not in the audit trail as a count.
    assert.deepEqual((await read("select operation_id from public.approvals where id=$1", [granted.id])).rows, [{ operation_id: null }]);
    assert.equal((await read("select count(*)::int as n from public.sync_operations where id=$1", [second.id])).rows[0].n, 0);
    // Sent again (a lost answer), it is answered again.
    await w.as(w.people.cashier);
    assert.equal((await send(second)).rows[0].result.id, second.id);
    await w.as(w.people.owner);
  });

  await test("QA counts STK-03: a count sent again after it was approved is accepted and ignored", async () => {
    const w = await world("Warung Kirim Ulang"), id = randomUUID();
    await buy(w, "rice", 10_000_000, 3 * HOUR);
    await w.as(w.people.cashier);
    await send(ago(w.op("count.submit", { id, area: "Rak bar", lines: [{ stockId: "rice", counted: 9_000_000, reason: "" }] }), 2 * HOUR));
    await w.as(w.people.manager);
    await send(w.op("count.record", { id, area: "Rak bar", lines: [{ stockId: "rice", counted: 9_000_000, reason: "" }] }));
    const before = await count(id);
    // The till still showed it as waiting: the cashier recounts and sends it again, then goes on working.
    await w.as(w.people.cashier);
    const again = w.op("count.submit", { id, area: "Rak bar", lines: [{ stockId: "rice", counted: 8_800_000, reason: "" }] });
    assert.equal((await send(again)).rows[0].result.id, again.id);
    await send(w.op("stock.record", { stockId: "rice", kind: "waste", qty: 1000, cost: 0, fromDrawer: false, reason: "jatuh" }));
    assert.deepEqual(await count(id), before);
    assert.equal(await qty(w, "rice"), 8_999_000);
    await w.as(w.people.owner);
  });

  await test("QA counts SEC-1: with a manager's PIN, only the lines that were submitted become stock", async () => {
    const w = await world("Warung Hitung PIN"), id = randomUUID();
    await pin(w, w.people.manager);
    await w.as(w.people.owner);
    await buy(w, "rice", 10_000_000, 3 * HOUR);
    await buy(w, "egg", 50_000, 3 * HOUR);
    await w.as(w.people.cashier);
    await send(ago(w.op("count.submit", { id, area: "Dry store", lines: [{ stockId: "rice", counted: 8_700_000, reason: "" }] }), 2 * HOUR));
    const submitted = await count(id);
    const granted = await approve(w.people.manager, "482915", id);
    // Other figures, another bahan, or one line more than the manager was shown: answered, and the count still waits.
    for (const lines of [[{ stockId: "rice", counted: 0, reason: "" }], [{ stockId: "egg", counted: 0, reason: "" }], [{ stockId: "rice", counted: 8_700_000, reason: "" }, { stockId: "egg", counted: 0, reason: "" }]])
      await send(w.op("count.record", { id, area: "Dry store", lines, approval: granted.id }));
    assert.deepEqual(await count(id), submitted);
    assert.deepEqual([await qty(w, "rice"), await qty(w, "egg")], [10_000_000, 50_000]);
    assert.deepEqual((await read("select operation_id from public.approvals where id=$1", [granted.id])).rows, [{ operation_id: null }]);
    // The lines as submitted, with the reason typed at the review, are approved under the manager's name.
    await send(w.op("count.record", { id, area: "Dry store", lines: [{ stockId: "rice", counted: 8_700_000, reason: "tumpah" }], approval: granted.id }));
    const c = await count(id);
    assert.deepEqual([c.status, c.approver, c.lines.map((l) => [l.stockId, l.counted, l.reason])], ["approved", "manager", [["rice", 8_700_000, "tumpah"]]]);
    assert.equal(await qty(w, "rice"), 8_700_000);
    // Still nobody approves a count without a manager: no approval, no count.
    const other = randomUUID();
    await send(w.op("count.submit", { id: other, area: "Dry store", lines: [{ stockId: "egg", counted: 40_000, reason: "" }] }));
    await assert.rejects(send(w.op("count.record", { id: other, area: "Dry store", lines: [{ stockId: "egg", counted: 40_000, reason: "" }] })), /Manager approval required/);
    await w.as(w.people.owner);
  });

  await test("QA counts SQL-15: count.submit takes only lines that are counts; the phone's and the till's own shape still pass", async () => {
    const w = await world("Warung Baris Hitung");
    await w.as(w.people.kitchen);
    const submit = (lines, id = randomUUID()) => send(w.op("count.submit", { id, area: "Dry store", lines }));
    for (const lines of [
      [{ stockId: "nope", counted: 1000, reason: "" }],
      [{ stockId: "rice", counted: "banyak", reason: "" }],
      [{ stockId: "rice", counted: "5", reason: "" }],
      [{ stockId: "rice", counted: -5, reason: "" }],
      [{ stockId: "rice", counted: 1.5, reason: "" }],
      [{ stockId: "rice", counted: 1_000_000_000_001, reason: "" }],
      [{ stockId: "rice", counted: null, reason: "" }],
      [{ stockId: "rice", reason: "" }],
      [{ counted: 5, reason: "" }],
      [5],
      [{ stockId: "rice", counted: 1000, reason: "x".repeat(201) }],
      [{ stockId: "rice", counted: 1000, reason: "" }, { stockId: "rice", counted: 2000, reason: "" }],
    ]) await assert.rejects(submit(lines), /Invalid count line/, JSON.stringify(lines).slice(0, 80));
    assert.equal((await read("select count(*)::int as n from public.counts where restaurant_id=$1", [w.rid])).rows[0].n, 0);
    // Takar Stok sends {stockId, counted, reason: ''}; the till the same, or no reason at all. Zero is a count of nothing.
    const id = randomUUID();
    await submit([{ stockId: "rice", counted: 0, reason: "" }, { stockId: "egg", counted: 12_000 }], id);
    // Anything else that rode on a line is not kept.
    await submit([{ stockId: "rice", counted: 0, reason: "", junk: "x".repeat(5000) }, { stockId: "egg", counted: 12_000 }], id);
    assert.deepEqual((await count(id)).lines.map((l) => Object.keys(l).sort().join()), ["at,counted,expected,reason,stockId", "at,counted,expected,reason,stockId"]);
    // count.record refuses the same, also a line with no amount (it used to pass the check and fail on the insert).
    await w.as(w.people.owner);
    for (const lines of [[{ stockId: "rice", reason: "" }], [{ stockId: "rice", counted: "5", reason: "" }], [{ stockId: "rice", counted: null }]])
      await assert.rejects(send(w.op("count.record", { id: randomUUID(), area: "Dry store", lines })), /Invalid count line/);
  });

  await test("QA counts SQL-15, SQL-16: stock.record takes the five kinds the Stok page and the phone send, whole amounts and a reason of sane length", async () => {
    const w = await world("Warung Catat Stok");
    const record = (over) => send(w.op("stock.record", { stockId: "rice", kind: "purchase", qty: 1000, cost: 0, fromDrawer: false, reason: "Nota 1", ...over }));
    for (const kind of ["opening", "purchase", "waste", "count", "adjustment"]) await record({ kind });
    for (const kind of ["production", "transfer", "sale", "", null, 7]) await assert.rejects(record({ kind }), /Invalid stock kind/, String(kind));
    await assert.rejects(send(w.op("stock.record", { stockId: "rice", qty: 1000, cost: 0, fromDrawer: false, reason: "tanpa jenis" })), /Invalid stock kind/);
    await assert.rejects(record({ kind: "preparation" }), /Preparation must use order operation/);
    await assert.rejects(record({ reason: null }), /Reason required/);
    await assert.rejects(record({ reason: "   " }), /Reason required/);
    await assert.rejects(record({ qty: null }), /Invalid stock amount/);
    await assert.rejects(record({ cost: null }), /Invalid stock amount/);
    // A megabyte of "reason" from a station is not stored and sent to every device; a long note is.
    await w.as(w.people.kitchen);
    await assert.rejects(record({ kind: "waste", reason: "x".repeat(1_000_000) }), /Reason too long/);
    await assert.rejects(record({ kind: "waste", reason: "x".repeat(2001) }), /Reason too long/);
    await record({ kind: "waste", reason: "x".repeat(2000) });
    // A role without a kind of its own is still turned down by role, also when the kind is missing.
    await assert.rejects(record({ kind: "purchase" }), /Manager permission required/);
    await assert.rejects(record({ kind: null }), /Manager permission required/);
    await w.as(w.people.admin);
    await assert.rejects(record({ kind: "opening" }), /Manager permission required/);
    await assert.rejects(record({ kind: null }), /Manager permission required/);
    // What Takar Stok sends for one delivery line.
    await record({ kind: "purchase", qty: 25_000_000, cost: 300_000, reason: "CV Beras, nota 1" });
    await w.as(w.people.owner);
  });

  await test("QA counts (asked by catalog, menu/F7): the note photo of a delivery may be WebP or JPEG, nothing else", async () => {
    const w = await world("Warung Foto Nota");
    const record = (photo) => send(w.op("stock.record", { stockId: "rice", kind: "purchase", qty: 1000, cost: 0, fromDrawer: false, reason: "Nota 1", photo }));
    await record("data:image/webp;base64,UklGRg==");
    await record("data:image/jpeg;base64,/9j/4AAQ");
    await assert.rejects(record("data:image/png;base64,iVBORw0KGgo="), /Invalid photo/);
    await assert.rejects(record("data:image/jpeg;base64," + "A".repeat(70_000)), /Invalid photo/);
    assert.deepEqual((await read("select count(*)::int as n from public.purchases where restaurant_id=$1 and photo is not null", [w.rid])).rows, [{ n: 2 }]);
  });
};
