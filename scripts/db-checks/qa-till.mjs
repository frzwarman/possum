// QA 2026-11-25, cluster till: what the server now refuses on a till's lines, payments and shift (SQL-02, SQL-04, SQL-15, SQL-16, SQL-20)
// and what it now accepts after the 12 hours (TILL-08). Run by scripts/test-db.mjs.
export default async ({ db, read, test, send, assert, randomUUID, menu, line, world }) => {
  const bill = { subtotal: 25000, discount: 0, service: 0, tax: 0, total: 25000 };
  const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
  // A restaurant of its own with the cashier's shift open (opened `hours` ago); sold() saves an order of one nasi.
  async function till(name, extra, hours = 0) {
    const w = await world(name, extra);
    await w.as(w.people.cashier);
    const shift = randomUUID(), open = w.op("shift.open", { id: shift, opening: 0 });
    if (hours) open.occurredAt = ago(hours);
    await send(open);
    w.shift = shift;
    w.sold = async (at) => {
      const o = w.order(shift, [line(menu, 1, 25000)], bill);
      if (at) Object.assign(o, { occurredAt: at }), Object.assign(o.payload.order, { createdAt: at, updatedAt: at });
      await send(o);
      return o.payload.order;
    };
    return w;
  }
  const rev = (id, expectedRevision, more = {}) => ({ id, expectedRevision, ...more });

  await test("QA till SQL-04, SQL-15: a line's prepared, cancelled, qty and price have their types; a payment cannot pass an unprepared line", async () => {
    const w = await till("Warung Tipe");
    for (const bad of [{ prepared: null }, { prepared: "true" }, { prepared: 1 }, { cancelled: null }, { cancelled: "false" }, { qty: "2" }, { qty: 0 }, { qty: 1000 }, { qty: 1.5 }, { qty: null }, { price: "25000" }]) {
      const o = w.order(w.shift, [{ ...line(menu, 1, 25000), ...bad }], bill);
      await assert.rejects(send(o), /Invalid line fields|Invalid line count|Missing line fields/, JSON.stringify(bad));
    }
    // The same order with honest types goes through, and a payment on it is refused until the line is prepared.
    const o = w.order(w.shift, [line(menu, 1, 25000)], bill);
    await send(o);
    await assert.rejects(send(w.op("payment.record", rev(o.payload.order.id, 1, { method: "cash", tendered: 25000, verified: true }))), /Prepare before payment/);
    await assert.rejects(send(w.order(w.shift, Array.from({ length: 201 }, () => line(menu, 1, 25000)), { ...bill, subtotal: 25000 * 201, total: 25000 * 201 })), /Invalid line count/);
  });

  await test("QA till SQL-02, SQL-20: a shift closes only with a counted number (a cashless close sends 0); a shift that is not the open one says so", async () => {
    const w = await till("Warung Tutup");
    for (const counted of [undefined, null, "100", -1, 1.5, 1e10]) {
      await assert.rejects(send(w.op("shift.close", { id: w.shift, ...(counted !== undefined && { counted }) })), /Invalid count/, String(counted));
    }
    // Cashless close, as CloseShift.tsx sends it: the drawer is 0 and the slips ride along.
    const c = await till("Warung Tanpa Tunai", { cashless: true, edcs: ["BCA"] });
    await send(c.op("shift.close", { id: c.shift, counted: 0, settlements: [] }));
    await w.as(w.people.cashier);
    // The first shift closes; a second opens; closing the first again is refused for what it is, not as open orders.
    await send(w.op("shift.close", { id: w.shift, counted: 0 }));
    const next = randomUUID();
    await send(w.op("shift.open", { id: next, opening: 0 }));
    await assert.rejects(send(w.op("shift.close", { id: w.shift, counted: 0 })), /Not the open shift/);
    await send(w.op("shift.close", { id: next, counted: 0 }));
  });

  await test("QA till SQL-15: a card or QRIS payment names a machine the store knows, in the settings or already paid on in this shift", async () => {
    const w = await till("Warung EDC", { cashless: true, edcs: ["BCA", "BRI"] });
    const pay = async (edc, method = "card") => {
      const o = await w.sold();
      await send(w.op("order.prepare", rev(o.id, 1, { lineIds: o.lines.map((l) => l.id) })));
      return w.op("payment.record", rev(o.id, 2, { method, tendered: 25000, verified: true, edc }));
    };
    await assert.rejects(send(await pay("EDC PALSU")), /Unknown EDC/);
    await send(await pay("BCA"));
    await send(await pay("BRI", "qris"));
    // BRI leaves the settings mid-shift: it already took a payment in this shift, so it stays honest; a machine never used is refused.
    await w.as(w.people.manager);
    await send(w.op("settings.update", { settings: { ...w.settingsDoc ?? (await db.query("select settings from public.restaurants where id=$1", [w.rid])).rows[0].settings, edcs: ["BCA"] } }));
    await w.as(w.people.cashier);
    await send(await pay("BRI"));
    await assert.rejects(send(await pay("EDC PALSU")), /Unknown EDC/);
  });

  await test("QA till SQL-15: a cashless store that lists no machines sells on the till's three defaults", async () => {
    const w = await till("Warung Bawaan", { cashless: true });
    for (const edc of ["BCA", "BRI", "Mandiri"]) {
      const o = await w.sold();
      await send(w.op("order.prepare", rev(o.id, 1, { lineIds: o.lines.map((l) => l.id) })));
      await send(w.op("payment.record", rev(o.id, 2, { method: "card", tendered: 25000, verified: true, edc })));
    }
  });

  await test("QA till SQL-16: a cash movement's reason is capped far above the screen's 300", async () => {
    const w = await till("Warung Kas");
    await send(w.op("shift.cash", { shiftId: w.shift, amount: 5000, reason: "x".repeat(300) }));
    await assert.rejects(send(w.op("shift.cash", { shiftId: w.shift, amount: 5000, reason: "x".repeat(1001) })), /Invalid cash movement/);
    await assert.rejects(send(w.op("shift.cash", { shiftId: w.shift, amount: 5000 })), /Invalid cash movement/);
    await assert.rejects(send(w.op("shift.cash", { shiftId: w.shift, reason: "tanpa jumlah" })), /Invalid cash movement/);
  });

  await test("QA till TILL-08: after the 12 hours a cash payment and, in the pilot, the prepare that goes with it are accepted; with station tablets the prepare is not", async () => {
    const pilot = await till("Warung Pilot", {}, 13);
    // Saved while the shift was still in force (12.5 hours ago), prepared and paid now (13 hours after it opened).
    const o = await pilot.sold(ago(12.5));
    await assert.rejects(pilot.sold(), /No authorized shift/);
    await send(pilot.op("order.prepare", rev(o.id, 1, { lineIds: o.lines.map((l) => l.id) })));
    await send(pilot.op("payment.record", rev(o.id, 2, { method: "cash", tendered: 30000, verified: true })));
    // A till that sends its lines with the payment also sends 'prepare' late when the shift ran out; the status below proves it landed.
    assert.equal((await read("select status from public.orders where id=$1", [o.id])).rows[0].status, "paid");
    const tablets = await till("Warung Tablet", { stationTablets: true }, 13);
    const t = await tablets.sold(ago(12.5));
    await assert.rejects(send(tablets.op("order.prepare", rev(t.id, 1, { lineIds: t.lines.map((l) => l.id) }))), /No authorized shift/);
  });
};
