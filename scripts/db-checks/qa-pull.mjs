// QA 2026-11-25, cluster pull: what a device receives at sign-in (bootstrap) and from pull, and the two server rules
// that go with it (settings.update, and a new order's copy of tax, service and packaging). Run by scripts/test-db.mjs.
export default async function ({ db, test, read, send, assert, randomUUID, settings, menu, line, world }) {
  const pull = async (since, device) => (await db.query("select public.pull($1::timestamptz,$2::uuid) as r", [since, device])).rows[0].r;
  const boot = async (device) => (await db.query("select public.bootstrap($1::uuid) as r", [device])).rows[0].r;
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const nasi = (w, shift, copy, tax = 0, service = 0, more = {}) => w.order(shift, [line(menu, 1, 25000)], { subtotal: 25000, discount: 0, service, tax, total: 25000 + service + tax }, { settings: copy, ...more });
  const openShift = async (w) => { await w.as(w.people.cashier); const id = randomUUID(); await send(w.op("shift.open", { id, opening: 0 })); return id; };
  const save = async (w, next) => { await w.as(w.people.owner); await send(w.op("settings.update", { settings: next })); };

  await test("HARNESS-F2: the till's order priced with the tax, service or packaging in force since its shift opened is accepted", async () => {
    const w = await world("Warung F2"), base = { ...settings, name: "Warung F2" };
    const shift = await openShift(w);
    // The laptop turns PB1 on; the till has not pulled yet and rings one order up without it.
    await save(w, { ...base, taxBps: 1000 });
    await w.as(w.people.cashier);
    await send(nasi(w, shift, base));
    // After its pull the till prices with the tax; then the manager turns it off again before the till's next pull.
    await send(nasi(w, shift, { ...base, taxBps: 1000 }, 2500));
    await save(w, base);
    await w.as(w.people.cashier);
    await send(nasi(w, shift, { ...base, taxBps: 1000 }, 2500));
    // Service and packaging the same way: each order is priced right by the copy the till held.
    await save(w, { ...base, serviceBps: 500, packaging: [{ stockId: "rice", qty: 1000 }] });
    await w.as(w.people.cashier);
    await send(nasi(w, shift, base, 0, 0, { mode: "takeaway" }));
    await send(nasi(w, shift, { ...base, serviceBps: 500, packaging: [{ stockId: "rice", qty: 1000 }] }, 0, 1250, { mode: "takeaway" }));
    assert.equal((await read("select count(*)::int n from public.orders where restaurant_id=$1", [w.rid])).rows[0].n, 5);
    // Values the outlet never had are still refused, each priced right by its own copy.
    await assert.rejects(send(nasi(w, shift, { ...base, taxBps: 500 }, 1250)), /Invalid initial snapshot/);
    await assert.rejects(send(nasi(w, shift, { ...base, serviceBps: 1000 }, 0, 2500)), /Invalid initial snapshot/);
    await assert.rejects(send(nasi(w, shift, { ...base, packaging: [{ stockId: "egg", qty: 1000 }] })), /Invalid initial snapshot/);
    // Mixed from two different times (the old tax with the new service) was never in force either.
    await assert.rejects(send(nasi(w, shift, { ...base, taxBps: 1000, serviceBps: 500, packaging: [{ stockId: "rice", qty: 1000 }] }, 2625, 1250)), /Invalid initial snapshot/);
  });

  await test("HARNESS-F2: values replaced before the shift opened are not accepted; a save that changes none of the three keeps nothing; old ones are dropped after 13 hours", async () => {
    const w = await world("Warung F2b"), base = { ...settings, name: "Warung F2b" };
    const retired = async () => (await read("select retired_pricing from public.restaurants where id=$1", [w.rid])).rows[0].retired_pricing;
    await save(w, { ...base, footer: "Sampai jumpa", tagline: "Kemang" });
    assert.deepEqual(await retired(), []);
    await save(w, { ...base, taxBps: 1000 });
    await save(w, base);
    assert.deepEqual((await retired()).map((r) => [r.taxBps, r.serviceBps, r.packaging]), [[0, 0, []], [1000, 0, []]]);
    // A shift opened after the tax went back to 0 never saw 10%.
    const shift = await openShift(w);
    await assert.rejects(send(nasi(w, shift, { ...base, taxBps: 1000 }, 2500)), /Invalid initial snapshot/);
    await send(nasi(w, shift, base));
    // 13 hours on, the next save that changes one of the three drops what is older and keeps the value it replaces.
    await read("update public.restaurants set retired_pricing=(select jsonb_agg(e||jsonb_build_object('until',now()-interval '14 hours')) from jsonb_array_elements(retired_pricing) e) where id=$1", [w.rid]);
    await save(w, { ...base, serviceBps: 500 });
    assert.deepEqual((await retired()).map((r) => [r.taxBps, r.serviceBps]), [[0, 0]]);
  });

  await test("SQL-15: settings.update refuses a missing or null required key", async () => {
    const w = await world("Warung SQL15"), base = { ...settings, name: "Warung SQL15" };
    await w.as(w.people.owner);
    for (const key of ["id", "name", "appName", "cutoff", "taxBps", "serviceBps", "receiptWidth", "printableWidth", "goLive", "packaging", "timezone"]) {
      const { [key]: _, ...without } = base;
      await assert.rejects(send(w.op("settings.update", { settings: without })), /Invalid restaurant settings/, `without ${key}`);
      await assert.rejects(send(w.op("settings.update", { settings: { ...base, [key]: null } })), /Invalid restaurant settings/, `${key}: null`);
    }
    await assert.rejects(send(w.op("settings.update", { settings: { ...base, id: "lain" } })), /Invalid restaurant settings/);
    assert.deepEqual((await read("select settings from public.restaurants where id=$1", [w.rid])).rows[0].settings, base);
    // What the app sends (every key of the form, optional ones included) is saved as before.
    const full = { ...base, tagline: "Kemang", stations: { kitchen: 15, bar: 8 }, varianceLimit: 10000, lowAt: 5, stationTablets: false, cashless: false, edcs: ["BCA"], complimentBudget: 0, lockMinutes: 2, family: [] };
    await send(w.op("settings.update", { settings: full }));
    assert.deepEqual((await read("select settings from public.restaurants where id=$1", [w.rid])).rows[0].settings, full);
  });

  // One purchase order, one supplier and one catering order, written by the admin on a back-office laptop.
  async function documents(w) {
    const laptop = randomUUID();
    await w.as(w.people.owner);
    await db.query("select public.enroll_device($1,'office')", [laptop]);
    await w.as(w.people.admin);
    const supplier = { id: randomUUID(), name: "Toko Beras Jaya", phone: "0812 3333 4444", address: "Pasar Kemang", note: "", active: true };
    await send(w.opOn(laptop, "supplier.save", { supplier }));
    const po = w.opOn(laptop, "purchase.save", {});
    po.payload = { order: { id: randomUUID(), number: "PO-" + po.id.slice(0, 8).toUpperCase(), supplierId: supplier.id, supplier: supplier.name, note: "", lines: [{ stockId: "rice", qty: 25000000, cost: 350000 }], total: 350000, receipts: [], payments: [], status: "ordered", revision: 1, createdAt: po.occurredAt, updatedAt: po.occurredAt }, expectedRevision: 0 };
    await send(po);
    const so = w.opOn(laptop, "salesorder.save", {});
    so.payload = { order: { id: randomUUID(), number: "SO-" + so.id.slice(0, 8).toUpperCase(), customer: { name: "Ibu Ratna", phone: "0812 9999 1234", address: "Jl. Kemang Raya 12" }, deliverAt: new Date(Date.now() + 86400000).toISOString(), lines: [{ id: randomUUID(), itemId: "nasi", name: "Nasi uji", qty: 40, price: 25000, catalogVersion: 1 }], discount: 0, note: "", totals: { subtotal: 1000000, discount: 0, service: 0, tax: 0, total: 1000000 }, payments: [], status: "confirmed", revision: 1, createdAt: so.occurredAt, updatedAt: so.occurredAt }, expectedRevision: 0 };
    await send(so);
    return { laptop, supplier, po: po.payload.order, so: so.payload.order };
  }

  await test("CAT-1, STK-04, SYNC-12: purchase orders, suppliers and catering orders changed since the cursor ride in pull", async () => {
    const w = await world("Warung Dokumen"), since = ago(60000);
    const d = await documents(w);
    await w.as(w.people.manager);
    const first = await pull(since, d.laptop);
    assert.deepEqual([first.purchaseOrders.map((x) => x.id), first.suppliers.map((x) => x.id), first.salesOrders.map((x) => x.id)], [[d.po.id], [d.supplier.id], [d.so.id]]);
    assert.deepEqual(first.salesOrders[0].customer, d.so.customer);
    // From a cursor after those writes nothing is sent again.
    await new Promise((r) => setTimeout(r, 20));
    const cursor = new Date().toISOString();
    const idle = await pull(cursor, d.laptop);
    assert.deepEqual([idle.purchaseOrders, idle.suppliers, idle.salesOrders], [[], [], []]);
    // The admin takes a down payment and receives the delivery: each change comes with the next pull, and only what changed.
    await w.as(w.people.admin);
    await send(w.opOn(d.laptop, "salesorder.pay", { id: d.so.id, expectedRevision: 1, amount: 300000, payment: "outside" }));
    await send(w.opOn(d.laptop, "purchase.receive", { id: d.po.id, expectedRevision: 1, lines: d.po.lines, payment: "unpaid", complete: true }));
    await w.as(w.people.manager);
    const next = await pull(cursor, d.laptop);
    assert.deepEqual([next.salesOrders.map((x) => [x.revision, x.payments[0].amount]), next.purchaseOrders.map((x) => [x.revision, x.status]), next.suppliers], [[[2, 300000]], [[2, "received"]], []]);
    await w.as(w.people.admin);
    await send(w.opOn(d.laptop, "supplier.save", { supplier: { ...d.supplier, name: "Toko Beras Jaya Abadi" } }));
    await w.as(w.people.manager);
    assert.deepEqual((await pull(cursor, d.laptop)).suppliers.map((x) => x.name), ["Toko Beras Jaya Abadi"]);
    // Who gets them is who gets them at sign-in: the office for purchases and suppliers, and catering only where it is worked on.
    const got = {};
    for (const role of ["owner", "admin", "chef", "cashier", "barista", "kitchen", "accountant"]) {
      await w.as(w.people[role]);
      const r = await pull(since, d.laptop);
      got[role] = [r.purchaseOrders.length, r.suppliers.length, r.salesOrders.length];
    }
    assert.deepEqual(got, { owner: [1, 1, 1], admin: [1, 1, 1], chef: [1, 1, 0], cashier: [0, 0, 0], barista: [0, 0, 0], kitchen: [0, 0, 0], accountant: [0, 0, 0] });
  });

  await test("catering/SEC-1: sign-in gives catering customers only to owner, manager and admin", async () => {
    const w = await world("Warung Katering");
    const d = await documents(w), got = {};
    for (const role of ["owner", "manager", "admin", "chef", "cashier", "barista", "kitchen", "accountant"]) {
      await w.as(w.people[role]);
      const b = await boot(d.laptop);
      got[role] = [b.salesOrders.map((x) => x.customer.phone).join(), b.purchaseOrders.length, b.suppliers.length];
    }
    const yes = ["0812 9999 1234", 1, 1];
    assert.deepEqual(got, { owner: yes, manager: yes, admin: yes, chef: ["", 1, 1], cashier: ["", 0, 0], barista: ["", 0, 0], kitchen: ["", 0, 0], accountant: ["", 0, 0] });
  });

  await test("STK-02, STK-03: every role but the accountant learns of a count and of its approval, from pull and from sign-in", async () => {
    const w = await world("Warung Hitung"), since = ago(60000), id = randomUUID();
    await w.as(w.people.kitchen);
    await send(w.op("count.submit", { id, area: "Dry store", lines: [{ stockId: "rice", counted: 9000000, reason: "" }] }));
    const seen = async (how) => {
      const out = {};
      for (const role of ["owner", "manager", "admin", "chef", "cashier", "barista", "kitchen", "accountant"]) {
        await w.as(w.people[role]);
        const r = how === "pull" ? await pull(since, w.till) : await boot(w.till);
        out[role] = r.counts.filter((c) => c.id === id).map((c) => c.status).join();
      }
      return out;
    };
    const all = (status) => ({ owner: status, manager: status, admin: status, chef: status, cashier: status, barista: status, kitchen: status, accountant: "" });
    assert.deepEqual(await seen("pull"), all("submitted"));
    assert.deepEqual(await seen("bootstrap"), all("submitted"));
    await w.as(w.people.manager);
    await send(w.op("count.record", { id, area: "Dry store", lines: [{ stockId: "rice", counted: 9000000, reason: "" }] }));
    assert.deepEqual(await seen("pull"), all("approved"));
    assert.deepEqual(await seen("bootstrap"), all("approved"));
    // Today's shape, as the Hitung stok page reads it.
    await w.as(w.people.cashier);
    const c = (await pull(since, w.till)).counts.find((x) => x.id === id);
    assert.deepEqual(Object.keys(c).sort(), ["approvedAt", "approvedBy", "area", "id", "lines", "startedAt", "startedBy", "status", "submittedAt"]);
    assert.deepEqual([c.area, c.approvedBy, c.lines[0].stockId, c.lines[0].counted], ["Dry store", "manager", "rice", 9000000]);
  });

  await test("STK-06: sign-in sends the last 8 days of stock movements one by one and one baseline row per item for the rest", async () => {
    const w = await world("Warung Riwayat");
    await w.as(w.people.owner);
    const rec = (stockId, kind, qty, cost = 0) => send(w.op("stock.record", { stockId, kind, qty, cost, fromDrawer: false, reason: "uji" }));
    // Long ago: opening stock and a delivery. Then, within the week: a delivery and waste.
    await rec("rice", "opening", 10000000);
    await rec("rice", "purchase", 5000000, 70000);
    await rec("egg", "opening", 50000);
    await read("update public.stock_movements set occurred_at=occurred_at-interval '9 days',received_at=received_at-interval '9 days' where restaurant_id=$1", [w.rid]);
    await rec("rice", "purchase", 2000000, 30000);
    await rec("rice", "waste", 300000);
    await read("update public.stock_movements set occurred_at=occurred_at-interval '7 days 23 hours',received_at=received_at-interval '7 days 23 hours' where restaurant_id=$1 and kind='waste'", [w.rid]);
    await w.as(w.people.cashier);
    const b = await boot(w.till), rows = b.movements;
    const baseline = rows.filter((m) => m.recordId === "server-baseline"), recent = rows.filter((m) => m.recordId !== "server-baseline");
    assert.deepEqual(baseline.map((m) => [m.id, m.stockId, m.qty, m.kind, m.cost]).sort(), [["baseline-egg", "egg", 50000, "opening", 0], ["baseline-rice", "rice", 15000000, "opening", 0]]);
    assert.deepEqual(Object.keys(baseline[0]).sort(), ["actor", "at", "cost", "id", "kind", "qty", "reason", "recordId", "stockId"]);
    assert.deepEqual(recent.map((m) => [m.stockId, m.kind, m.qty, m.cost]).sort(), [["rice", "purchase", 2000000, 30000], ["rice", "waste", -300000, 0]]);
    // The balance is the server's, and the baseline sorts before everything that follows it (a running balance reads by time).
    const total = (id) => rows.filter((m) => m.stockId === id).reduce((n, m) => n + m.qty, 0);
    assert.deepEqual([total("rice"), total("egg")], [16700000, 50000]);
    assert.ok(recent.every((m) => m.at >= baseline[0].at), "the baseline is the oldest row");
    // What arrives in the seconds before sign-in is sent as itself: the pull that follows upserts it by id, never twice.
    await w.as(w.people.owner);
    await rec("egg", "waste", 1000);
    await w.as(w.people.cashier);
    const again = await boot(w.till), pulled = await pull(ago(10000), w.till);
    const ids = new Set(again.movements.map((m) => m.id));
    assert.ok(pulled.movements.length > 0 && pulled.movements.every((m) => ids.has(m.id)), "rows of the last seconds carry their own id");
  });

  await test("pull tells the device who its person is now; a member switched off is refused as before", async () => {
    const w = await world("Warung Peran");
    await w.as(w.people.cashier);
    assert.deepEqual((await pull(ago(1000), w.till)).member, { role: "cashier", active: true });
    await w.as(w.people.owner);
    await db.query("select public.manage_staff($1,'admin',true)", [w.people.cashier]);
    await w.as(w.people.cashier);
    const r = await pull(ago(1000), w.till);
    assert.deepEqual([r.member, r.device], [{ role: "admin", active: true }, { mode: "pos", enrolled: true, primary: true }]);
    await w.as(w.people.owner);
    await db.query("select public.manage_staff($1,'admin',false)", [w.people.cashier]);
    await w.as(w.people.cashier);
    await assert.rejects(pull(ago(1000), w.till), /No active staff membership/);
    await w.as(w.people.owner);
  });
}
