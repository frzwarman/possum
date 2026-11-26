// QA 2026-11-25, cluster stock: purchases, catering orders, transfers between outlets. Run by scripts/test-db.mjs.
export default async ({ db, test, read, send, assert, randomUUID, world }) => {
  const cash = async (w) => (await read("select coalesce(sum(amount),0)::int as n from public.cash_movements where restaurant_id=$1", [w.rid])).rows[0].n;
  const qty = async (rid, stock) => Number((await read("select coalesce(sum(qty),0)::text as q from public.stock_movements where restaurant_id=$1 and stock_id=$2", [rid, stock])).rows[0].q);
  // A second, paired office device (the laptop) for the signed-in member.
  const laptop = async (w) => { const id = randomUUID(); await db.query("select public.enroll_device($1,'office')", [id]); return id; };
  const po = (w, deviceId, lines) => {
    const o = w.opOn(deviceId, "purchase.save", {});
    o.payload = { order: { id: randomUUID(), number: "PO-" + o.id.slice(0, 8).toUpperCase(), supplier: "Pasar", note: "", lines, total: lines.reduce((n, l) => n + l.cost, 0), receipts: [], payments: [], status: "ordered", revision: 1, createdAt: o.occurredAt, updatedAt: o.occurredAt }, expectedRevision: 0 };
    return o;
  };
  const so = (w, deviceId, qty = 2) => {
    const o = w.opOn(deviceId, "salesorder.save", {}), lines = [{ id: randomUUID(), itemId: "nasi", name: "Nasi uji", qty, price: 20000, catalogVersion: 1 }], total = qty * 20000;
    o.payload = { order: { id: randomUUID(), number: "SO-" + o.id.slice(0, 8).toUpperCase(), customer: { name: "PT Maju", phone: "", address: "" }, deliverAt: new Date(Date.now() + 86400000).toISOString(), lines, discount: 0, note: "", totals: { subtotal: total, discount: 0, service: 0, tax: 0, total }, payments: [], status: "confirmed", revision: 1, createdAt: o.occurredAt, updatedAt: o.occurredAt }, expectedRevision: 0 };
    return o;
  };

  await test("QA stock CT-03, STK-05, CAT-6: the actor's own open shift takes a drawer payment from any paired device; someone else's shift does not", async () => {
    const w = await world("Warung Laci"), shift = randomUUID();
    await w.as(w.people.manager);
    const lap = await laptop(w);
    await send(w.op("shift.open", { id: shift, opening: 100000 }));
    // Purchase order: receive paid from the drawer, then a second one paid later, both sent by the laptop.
    const p = po(w, lap, [{ stockId: "rice", qty: 5000, cost: 40000 }]), pid = p.payload.order.id;
    await send(p);
    await send(w.opOn(lap, "purchase.receive", { id: pid, expectedRevision: 1, lines: [{ stockId: "rice", qty: 3000, cost: 24000 }], payment: "drawer", shiftId: shift, complete: false }));
    await send(w.opOn(lap, "purchase.receive", { id: pid, expectedRevision: 2, lines: [{ stockId: "rice", qty: 1000, cost: 8000 }], payment: "unpaid", complete: false }));
    await send(w.opOn(lap, "purchase.pay", { id: pid, expectedRevision: 3, amount: 4000, payment: "drawer", shiftId: shift }));
    assert.equal(await cash(w), -28000);
    // Catering: a down payment into the drawer and a refund out of it.
    const s = so(w, lap), sid = s.payload.order.id;
    await send(s);
    await send(w.opOn(lap, "salesorder.pay", { id: sid, expectedRevision: 1, amount: 10000, payment: "drawer", shiftId: shift }));
    assert.equal(await cash(w), -18000);
    await send(w.opOn(lap, "salesorder.cancel", { id: sid, expectedRevision: 2, reason: "Batal", refund: 10000, payment: "drawer", shiftId: shift }));
    assert.equal(await cash(w), -28000);
    // The drawer is still the actor's own: the owner has no shift, and another member's shift is not his.
    await w.as(w.people.owner);
    const ownerLap = await laptop(w), q = po(w, ownerLap, [{ stockId: "rice", qty: 1000, cost: 8000 }]);
    await send(q);
    await assert.rejects(send(w.opOn(ownerLap, "purchase.receive", { id: q.payload.order.id, expectedRevision: 1, lines: [{ stockId: "rice", qty: 1000, cost: 8000 }], payment: "drawer", shiftId: shift })), /Drawer payment requires your active shift/);
    const t = so(w, ownerLap);
    await send(t);
    await assert.rejects(send(w.opOn(ownerLap, "salesorder.pay", { id: t.payload.order.id, expectedRevision: 1, amount: 1000, payment: "drawer", shiftId: shift })), /Drawer payment requires your active shift/);
    assert.equal(await cash(w), -28000);
  });

  await test("QA stock SQL-10: a transfer receipt never books more than was sent", async () => {
    const a = await world("Outlet A"), b = await world("Outlet B");
    await db.exec("reset role");
    await db.query("update public.restaurants set group_id=$1 where id in ($2,$3)", [randomUUID(), a.rid, b.rid]);
    await a.as(a.people.owner);
    await a.send(a.op("stock.record", { stockId: "rice", kind: "purchase", qty: 10_000_000, cost: 1_500_000, fromDrawer: false, reason: "Kiriman" }));
    const t = a.op("transfer.send", {}), id = randomUUID();
    t.payload = { transfer: { id, number: "TR-" + t.id.slice(0, 8).toUpperCase(), to: b.rid, lines: [{ stockId: "rice", qty: 1000 }], note: "" } };
    await send(t);
    await b.as(b.people.owner);
    const receive = (n) => b.op("transfer.receive", { id, lines: [{ stockId: "rice", target: "rice", qty: n }] });
    await assert.rejects(send(receive(1_000_000)), /Invalid transfer receipt/);
    await assert.rejects(send(receive(1001)), /Invalid transfer receipt/);
    assert.equal(await qty(b.rid, "rice"), 0);
    await send(receive(1000));
    assert.equal(await qty(b.rid, "rice"), 1000);
    // Less than was sent (lost on the way) stays fine.
    await a.as(a.people.owner);
    const t2 = a.op("transfer.send", {}), id2 = randomUUID();
    t2.payload = { transfer: { id: id2, number: "TR-" + t2.id.slice(0, 8).toUpperCase(), to: b.rid, lines: [{ stockId: "rice", qty: 1000 }], note: "" } };
    await send(t2);
    await b.as(b.people.owner);
    await send(b.op("transfer.receive", { id: id2, lines: [{ stockId: "rice", target: "rice", qty: 400 }] }));
    assert.equal(await qty(b.rid, "rice"), 1400);
  });

  await test("QA stock STK-12: the admin reads linked outlets and transfers; a cashier still does not", async () => {
    const a = await world("Outlet C"), b = await world("Outlet D");
    await db.exec("reset role");
    await db.query("update public.restaurants set group_id=$1 where id in ($2,$3)", [randomUUID(), a.rid, b.rid]);
    await a.as(a.people.admin);
    const seen = (await db.query("select public.outlet_transfers() as t")).rows[0].t;
    assert.deepEqual(seen.outlets.map((o) => o.id), [b.rid]);
    await a.as(a.people.cashier);
    await assert.rejects(db.query("select public.outlet_transfers()"), /Manager required/);
  });

  await test("QA stock SQL-16: purchase and catering payloads far above any screen are refused", async () => {
    const w = await world("Warung Besar");
    await w.as(w.people.manager);
    const big = "x".repeat(300_000);
    const p = po(w, w.till, [{ stockId: "rice", qty: 1000, cost: 8000 }]);
    await send(p);
    await assert.rejects(send(w.op("purchase.receive", { id: p.payload.order.id, expectedRevision: 1, lines: [{ stockId: "rice", qty: 1000, cost: 8000, note: big }], payment: "unpaid", complete: true })), /too large/);
    const s = so(w, w.till);
    s.payload.order.junk = big;
    await assert.rejects(send(s), /too large/);
  });
};
