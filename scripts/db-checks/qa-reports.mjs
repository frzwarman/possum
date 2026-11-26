// QA 2026-11-25, cluster reports: the audit log is paged and complete (RPT-5, SQL-06), says one discount once (RPT-10),
// covers what it missed (SQL-07, RPT-9) and keeps photos out (F9); the server's best sellers leave compliments out (CT-07).
// Run by scripts/test-db.mjs.
export default async ({ db, test, read, send, assert, randomUUID, menu, line, world }) => {
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const log = async (...more) => (await db.query("select public.audit_log($1,$2" + more.map((_, i) => `,$${i + 3}`).join("") + ") as a", [day(-1), day(1), ...more])).rows[0].a;
  // A row in the operation log as the till sent it, `ago` seconds old.
  const put = (w, kind, payload, ago = 5, id = randomUUID()) => read("insert into public.sync_operations(id,restaurant_id,actor,device_id,kind,payload,occurred_at,result) values($1,$2,$3,$4,$5,$6,now()-($7||' seconds')::interval,'{}')", [id, w.rid, w.people.cashier, w.till, kind, JSON.stringify({ payload }), ago]).then(() => id);

  await test("QA reports RPT-5, SQL-06: audit_log pages through every entry (1.000 at most per call), nothing is dropped, and an old two-argument caller still gets an array", async () => {
    const w = await world("Warung Audit Panjang");
    await read("insert into public.sync_operations(id,restaurant_id,actor,device_id,kind,payload,occurred_at,result) select gen_random_uuid(),$1,$2,$3,'shift.cash',jsonb_build_object('payload',jsonb_build_object('amount',-1000,'reason','kas '||g)),now()-(g||' seconds')::interval,'{}' from generate_series(1,1150) g", [w.rid, w.people.cashier, w.till]);
    await w.as(w.people.owner);
    const first = await log();
    assert.equal(first.length, 1000, "an old caller still gets the newest 1000");
    const second = await log(first.at(-1).at, first.at(-1).id);
    const all = [...first, ...second];
    assert.equal(new Set(all.map((r) => r.id)).size, all.length, "no entry twice");
    assert.equal(all.filter((r) => r.kind === "shift.cash").length, 1150, "every cash entry is there");
    const small = await log(null, null, 10);
    assert.equal(small.length, 10);
    assert.equal(small[0].id, first[0].id);
  });

  await test("QA reports RPT-10: a discount is one entry however often the order is saved again; a changed discount is a new one", async () => {
    const w = await world("Warung Diskon Sekali");
    const order = randomUUID(), other = randomUUID(), save = (id, discount, reason, ago) => put(w, "order.save", { order: { id, discount, discountReason: reason } }, ago);
    await save(order, 0, "", 50);
    await save(order, 5000, "Teman pemilik", 40);
    await save(order, 5000, "Teman pemilik", 30);
    await save(order, 5000, "Teman pemilik", 20);
    await save(order, 8000, "Teman pemilik", 10);
    await save(other, 3000, "Promo", 45);
    await w.as(w.people.owner);
    const rows = (await log()).filter((r) => r.kind === "order.save");
    assert.deepEqual(rows.map((r) => `${r.payload.order.id === order}:${r.payload.order.discount}`).sort(), ["false:3000", "true:5000", "true:8000"]);
  });

  await test("QA reports SQL-07, RPT-9, F9: drawer cash in purchases and catering, transfers, production, shift open and the changes nobody could see are in the log; photos are not", async () => {
    const w = await world("Warung Jejak Lengkap");
    for (const kind of ["shift.open", "transfer.send", "production.record"]) await put(w, kind, { id: randomUUID() });
    for (const kind of ["purchase.receive", "purchase.pay", "salesorder.pay", "salesorder.cancel"]) {
      await put(w, kind, { id: randomUUID(), payment: "drawer" });
      await put(w, kind, { id: randomUUID(), payment: "outside" });
    }
    await put(w, "catalog.publish", { menu: [{ id: "a", name: "A", price: 1, photo: "data:image/webp;base64,AAAA" }], stock: [{ id: "s", name: "S", photo: "data:image/webp;base64,BBBB" }], photo: "x" });
    await w.as(w.people.owner);
    // Role changes, pairing and a removed cash-book entry write an audit row of their own (a trigger).
    await db.query("select public.manage_staff($1,$2,$3)", [w.people.cashier, "manager", true]);
    const phone = randomUUID();
    await db.query("select public.enroll_device($1,$2)", [phone, "station"]);
    const entry = randomUUID();
    await db.query("select public.ledger_save($1)", [JSON.stringify({ id: entry, day: day(0), kind: "rent", amount: 100000, note: "Sewa" })]);
    await db.query("select public.ledger_remove($1)", [entry]);
    const rows = await log(), kinds = rows.map((r) => r.kind);
    for (const k of ["shift.open", "transfer.send", "production.record", "staff.change", "device.enroll", "ledger.remove"]) assert.ok(kinds.includes(k), k);
    for (const k of ["purchase.receive", "purchase.pay", "salesorder.pay", "salesorder.cancel"]) assert.deepEqual(rows.filter((r) => r.kind === k).map((r) => r.payload.payment), ["drawer"], k);
    const staff = rows.find((r) => r.kind === "staff.change");
    assert.deepEqual([staff.payload.from, staff.payload.to, staff.actorName], ["cashier", "manager", "owner"]);
    assert.equal(rows.find((r) => r.kind === "device.enroll" && r.payload.device === phone).payload.mode, "station");
    const publish = rows.find((r) => r.kind === "catalog.publish" && r.payload.menu[0]?.id === "a").payload;
    assert.deepEqual([publish.menu[0].name, "photo" in publish.menu[0], "photo" in publish.stock[0], "photo" in publish], ["A", false, false, false]);
    // Nobody reads the event table directly.
    await assert.rejects(db.query("select * from public.audit_events"), /permission denied/);
  });

  await test("QA reports CT-07: the server's best sellers (the Telegram morning report) count sales only, not compliments", async () => {
    const w = await world("Warung Terlaris");
    await w.as(w.people.cashier);
    const shift = randomUUID();
    await send(w.op("shift.open", { id: shift, opening: 0 }));
    const sold = async (qty) => {
      const l = { ...line(menu, 1, 25000), qty }, o = w.order(shift, [l], { subtotal: 25000 * qty, discount: 0, service: 0, tax: 0, total: 25000 * qty }), id = o.payload.order.id;
      await send(o);
      await send(w.op("order.prepare", { id, expectedRevision: 1, lineIds: [l.id] }));
      await send(w.op("payment.record", { id, expectedRevision: 2, method: "cash", tendered: 25000 * qty, verified: true }));
      return id;
    };
    await sold(1);
    const staff = await sold(6);
    await read("update public.orders set snapshot=jsonb_set(snapshot,'{mode}','\"compliment\"') where restaurant_id=$1 and id=$2", [w.rid, staff]);
    const summary = (await read("select public.sales_summary($1,$2,$3) as r", [w.rid, day(-1), day(1)])).rows[0].r;
    assert.deepEqual([summary.transactions, summary.sales, summary.bestSellers], [1, 25000, [{ name: "Nasi uji", quantity: 1 }]]);
  });
};
