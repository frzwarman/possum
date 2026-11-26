// QA 2026-11-25, cluster discounts: what order.save lets a discount be (SQL-01, SQL-16), a manual discount that keeps
// its rule (TILL-02), and an approval that covers up to its amount (DSC-2, TILL-05). Run by scripts/test-db.mjs.
import { readFile } from "node:fs/promises";
export default async ({ db, test, login, read, send, assert, randomUUID, menu, line, world }) => {
  const PIN = "482915";
  const bill = (sub, off) => ({ subtotal: sub, discount: off, service: 0, tax: 0, total: sub - off });
  const nasi = (n) => Array.from({ length: n }, () => line(menu, 1, 25000));
  const teh = { id: "teh", name: "Es teh", category: "Minuman", type: "beverage", price: 10000, active: true, soldOut: false, favorite: false, recipe: [], modifiers: [], version: 1 };
  // A restaurant of its own with the cashier's shift open, the manager's PIN set, and Es teh beside Nasi uji.
  async function till(name, extra) {
    const w = await world(name, extra);
    await send(w.op("catalog.publish", { menu: [teh], stock: [] }));
    await w.as(w.people.manager);
    await db.query("select public.set_approval_pin($1)", [PIN]);
    await w.as(w.people.cashier);
    const shift = randomUUID();
    await send(w.op("shift.open", { id: shift, opening: 0 }));
    // The manager's PIN typed at the till for a discount of this amount: a one-use approval.
    w.pin = async (amount) => (await db.query("select public.approve($1,$2,'discount',null,$3) as r", [w.people.manager, PIN, amount])).rows[0].r.id;
    // A new order of these lines; totals follow the discount (the worlds charge no tax or service).
    w.sale = (lines, more = {}, approval) => {
      const sub = lines.reduce((n, l) => n + l.price * l.qty, 0), o = w.order(shift, lines, bill(sub, more.discount ?? 0), more);
      if (approval) o.payload.approval = approval;
      return o;
    };
    // The same order saved again with other lines or another discount, as the till sends it.
    w.again = (prev, lines, more = {}, approval) => {
      const sub = lines.reduce((n, l) => n + l.price * l.qty, 0), order = { ...prev.payload.order, ...more, lines, revision: prev.payload.order.revision + 1 };
      order.totals = bill(sub, order.discount);
      return w.op("order.save", { order, expectedRevision: prev.payload.order.revision, ...(approval && { approval }) });
    };
    w.stored = async (o) => (await read("select snapshot from public.orders where restaurant_id=$1 and id=$2", [w.rid, o.payload.order.id])).rows[0]?.snapshot;
    return w;
  }
  const refusal = /Manager approval required/;
  const ten = { kind: "percent", value: 10, scope: "order" };

  await test("QA discounts SQL-01: an order whose mode, discount or reason is null or of the wrong type is refused, never priced without an approval", async () => {
    const w = await till("Warung Null");
    // The verifier's request: a cashier's 43.000 off 50.000 with "mode": null and no approval.
    await assert.rejects(send(w.sale(nasi(2), { mode: null, discount: 43000 })), /Invalid order/);
    for (const mode of [5, "delivery", ["dinein"], { is: "dinein" }]) await assert.rejects(send(w.sale(nasi(2), { mode })), /Invalid order/);
    // The same hole one field over: a discount that is not a number never reaches the comparisons that ask for the PIN.
    for (const discount of [null, "5000", [5000], true]) {
      const o = w.sale(nasi(2));
      Object.assign(o.payload.order, { discount, discountReason: "teman", totals: { subtotal: 50000, discount, service: null, tax: null, total: null } });
      await assert.rejects(send(o), /Invalid discount/);
    }
    for (const discountReason of [null, 7, ["x"]]) await assert.rejects(send(w.sale(nasi(2), { discountReason })), /Invalid discount/);
    await assert.rejects(send(w.sale(nasi(2), { discountId: null })), /Invalid discount/);
    // A compliment names its person in text, and carries no saved or manual discount beside its own rule.
    const comp = (more) => w.sale(nasi(2), { mode: "compliment", compliment: { kind: "family", who: "Rino" }, discount: 50000, discountReason: "Keluarga pemilik · Rino", ...more });
    await assert.rejects(send(comp({ compliment: { kind: "family", who: 7 } })), /Invalid compliment/);
    await assert.rejects(send(comp({ compliment: null })), /Invalid compliment/);
    await assert.rejects(send(comp({ discountRule: { kind: "percent", value: 100, scope: "order" } })), /Invalid compliment/);
    await assert.rejects(send(comp({ discountId: "happy" })), /Invalid compliment/);
    await send(comp());
    // Nothing above left an order behind, and the honest baselines still behave.
    assert.equal((await read("select count(*)::int as n from public.orders where restaurant_id=$1", [w.rid])).rows[0].n, 1);
    await assert.rejects(send(w.sale(nasi(2), { discount: 43000, discountReason: "teman" })), refusal);
    await send(w.sale(nasi(2)));
  });

  await test("QA discounts SQL-16: a discount reason is capped at 300 characters, far above the 60 the till lets a cashier type", async () => {
    const w = await till("Warung Panjang");
    await assert.rejects(send(w.sale(nasi(1), { discount: 1000, discountReason: "x".repeat(301) }, await w.pin(1000))), /Invalid discount/);
    const ok = w.sale(nasi(1), { discount: 1000, discountReason: "x".repeat(300) }, await w.pin(1000));
    await send(ok);
    assert.equal((await w.stored(ok)).discountReason.length, 300);
  });

  await test("QA discounts TILL-02: a manual discount carries its rule, the amount must be the rule applied to the lines, and an approval covers up to its amount", async () => {
    const w = await till("Warung Aturan");
    const off = (lines, rule, discount, more = {}) => [lines, { discountRule: rule, discount, discountReason: "Pelanggan tetap", ...more }];
    // The manager approved 10% of four nasi (10.000); three were taken off before the first save: 10% of what is left.
    const approval = await w.pin(10000);
    await assert.rejects(send(w.sale(...off(nasi(1), ten, 10000), approval)), /Invalid manual discount/);
    const o = w.sale(...off(nasi(1), ten, 2500), approval);
    await send(o);
    let s = await w.stored(o);
    assert.deepEqual([s.discount, s.discountApprovedBy, s.discountApproved, s.discountRule], [2500, "manager", 10000, ten]);
    // A used approval is spent, and one for less than the discount covers nothing.
    await assert.rejects(send(w.sale(...off(nasi(1), ten, 2500), approval)), refusal);
    await assert.rejects(send(w.sale(...off(nasi(2), ten, 5000), await w.pin(4999))), refusal);
    await assert.rejects(send(w.sale(...off(nasi(2), ten, 5000))), refusal);
    // The order grows back to four nasi: still within what was approved, no new PIN; the client cannot raise that itself.
    const four = w.again(o, [...o.payload.order.lines, ...nasi(3)], { discount: 10000, discountApproved: 999999, discountApprovedBy: "Kasir" });
    await send(four);
    s = await w.stored(o);
    assert.deepEqual([s.discount, s.discountApprovedBy, s.discountApproved, s.totals.total], [10000, "manager", 10000, 90000]);
    // A fifth: 12.500 is more than the manager approved, so it asks again; the new approval is the new ceiling.
    const five = [...four.payload.order.lines, ...nasi(1)];
    await assert.rejects(send(w.again(four, five, { discount: 12500 })), refusal);
    await assert.rejects(send(w.again(four, five, { discount: 12500 }, await w.pin(12000))), refusal);
    const grown = w.again(four, five, { discount: 12500 }, await w.pin(12500));
    await send(grown);
    s = await w.stored(o);
    assert.deepEqual([s.discount, s.discountApproved, s.revision], [12500, 12500, 3]);
    // Another rule on the same order is another discount: it needs its own approval, even for less.
    const five5 = { kind: "percent", value: 5, scope: "order" };
    await assert.rejects(send(w.again(grown, five, { discountRule: five5, discount: 6250 })), refusal);
    await send(w.again(grown, five, { discountRule: five5, discount: 6250 }, await w.pin(6250)));
    assert.deepEqual((await w.stored(o)).discountApproved, 6250);
    // Drinks only: the rule follows the drinks, and with none left it takes nothing off and needs nobody.
    const drinks = { kind: "percent", value: 50, scope: "beverage" }, tea = line(teh, 1, 10000);
    const d = w.sale(...off([...nasi(1), tea], drinks, 5000), await w.pin(5000));
    await send(d);
    await assert.rejects(send(w.again(d, d.payload.order.lines.slice(0, 1), { discount: 5000 })), /Invalid manual discount/);
    await send(w.again(d, d.payload.order.lines.slice(0, 1), { discount: 0 }));
    assert.deepEqual([(await w.stored(d)).discount, (await w.stored(d)).totals.total], [0, 25000]);
    // What a rule may be: a kind, a whole value in range, a scope, nothing else; never beside a saved discount; with a reason.
    for (const rule of [null, "10%", [], {}, { ...ten, kind: "half" }, { ...ten, value: 0 }, { ...ten, value: 101 }, { ...ten, value: 2.5 }, { ...ten, value: "10" }, { ...ten, value: null }, { kind: "amount", value: 1000000001, scope: "order" }, { ...ten, scope: "table" }, { ...ten, scope: null }, { ...ten, scope: "items" }, { ...ten, scope: "items", items: "nasi" }, { ...ten, scope: "items", items: [7] }, { ...ten, note: "x".repeat(1000) }])
      await assert.rejects(send(w.sale(...off(nasi(1), rule, 2500), await w.pin(2500))), /Invalid discount rule/, JSON.stringify(rule));
    await assert.rejects(send(w.sale(...off(nasi(1), ten, 2500, { discountReason: " " }), await w.pin(2500))), /Invalid discount rule/);
    await assert.rejects(send(w.sale(...off(nasi(1), ten, 2500, { discountId: "happy" }), await w.pin(2500))), /Invalid discount/);
    await send(w.sale(...off([...nasi(1), tea].map((l) => ({ ...l, id: randomUUID() })), { kind: "amount", value: 5000, scope: "items", items: ["teh"] }, 5000), await w.pin(5000)));
  });

  await test("QA discounts TILL-02: an owner or a manager at the till answers for their own manual discount, also when it grows", async () => {
    const w = await world("Warung Pemilik");
    const shift = randomUUID(), more = (discount) => ({ discountRule: ten, discount, discountReason: "Teman pemilik" });
    await send(w.op("shift.open", { id: shift, opening: 0 }));
    const o = w.order(shift, nasi(1), bill(25000, 2500), more(2500));
    await send(o);
    const lines = [...o.payload.order.lines, ...nasi(1)];
    await send(w.op("order.save", { order: { ...o.payload.order, ...more(5000), lines, revision: 2, totals: bill(50000, 5000) }, expectedRevision: 1 }));
    const s = (await read("select snapshot from public.orders where restaurant_id=$1 and id=$2", [w.rid, o.payload.order.id])).rows[0].snapshot;
    assert.deepEqual([s.discount, s.discountApprovedBy, s.discountApproved], [5000, "owner", 5000]);
  });

  await test("QA discounts TILL-02: a rupiah discount approved on a bigger order is not carried onto a smaller one without a new approval", async () => {
    const w = await till("Warung Rupiah");
    const rp = { kind: "amount", value: 20000, scope: "order" }, more = { discountRule: rp, discount: 20000, discountReason: "Komplain" };
    const o = w.sale(nasi(4), more, await w.pin(20000));
    await send(o);
    // Three unsent nasi come off: 20.000 off 25.000 is not what the manager approved on 100.000.
    const one = o.payload.order.lines.slice(0, 1);
    await assert.rejects(send(w.again(o, one, more)), refusal);
    // More lines never need a new PIN for the same rupiah amount; fewer do, and the manager's new approval settles it.
    const six = w.again(o, [...o.payload.order.lines, ...nasi(2)], more);
    await send(six);
    await assert.rejects(send(w.again(six, o.payload.order.lines, more)), refusal);
    await send(w.again(six, o.payload.order.lines, more, await w.pin(20000)));
    assert.deepEqual([(await w.stored(o)).totals, (await w.stored(o)).discountApproved], [bill(100000, 20000), 20000]);
  });

  await test("QA discounts DSC-2, TILL-05: the approval for a saved discount that needs a PIN covers it up to the approved amount", async () => {
    const vip = { id: "vip", name: "Tamu VIP", note: "", kind: "percent", value: 20, scope: "order", from: "2026-01-01", to: "2099-12-31", approval: true };
    const w = await till("Warung VIP", { discounts: [vip] });
    const more = (discount) => ({ discountId: "vip", discount, discountReason: "Tamu VIP" });
    // Approved on two nasi (10.000), one taken off before the first save: 5.000 goes through on that approval.
    const o = w.sale(nasi(1), more(5000), await w.pin(10000));
    await send(o);
    let s = await w.stored(o);
    assert.deepEqual([s.discount, s.discountApprovedBy, s.discountApproved], [5000, "manager", 10000]);
    // An approval for less than the discount is no approval.
    await assert.rejects(send(w.sale(nasi(2), more(10000), await w.pin(9999))), refusal);
    await assert.rejects(send(w.sale(nasi(2), more(10000))), refusal);
    // The order grows past it and the till brings a new approval: that one is used and remembered.
    const three = [...o.payload.order.lines, ...nasi(2)];
    const grown = w.again(o, three, more(15000), await w.pin(15000));
    await send(grown);
    s = await w.stored(o);
    assert.deepEqual([s.discount, s.discountApprovedBy, s.discountApproved], [15000, "manager", 15000]);
    assert.equal((await read("select count(*)::int as n from public.approvals where restaurant_id=$1 and operation_id=$2", [w.rid, grown.id])).rows[0].n, 1);
    // The web app deployed before this fix adds a line to such an order without a new approval: still accepted, approver kept.
    const four = w.again(grown, [...three, ...nasi(1)], more(20000));
    await send(four);
    s = await w.stored(o);
    assert.deepEqual([s.discount, s.discountApprovedBy, s.discountApproved], [20000, "manager", 15000]);
  });

  await test("QA discounts: the web app deployed before this fix still lands its manual discounts, and supabase/pending/discounts_strict.sql closes what that leaves open", async () => {
    const vip = { id: "vip", name: "Tamu VIP", note: "", kind: "percent", value: 20, scope: "order", from: "2026-01-01", to: "2099-12-31", approval: true };
    const w = await till("Warung Lama", { discounts: [vip] });
    const fixed = { discount: 20000, discountReason: "Langganan" };
    // No rule: a fixed amount, approved for exactly that amount, kept as lines come and go (what TILL-02 found).
    await assert.rejects(send(w.sale(nasi(4), fixed, await w.pin(25000))), refusal);
    const o = w.sale(nasi(4), fixed, await w.pin(20000));
    await send(o);
    const one = o.payload.order.lines.slice(0, 1);
    const v = w.sale(nasi(1), { discountId: "vip", discount: 5000, discountReason: "Tamu VIP" }, await w.pin(5000));
    await send(v);
    const two = [...v.payload.order.lines, ...nasi(1)];
    // With the pending file applied (in a transaction that is rolled back, so the checks after this one see the migration).
    const strict = await readFile("supabase/pending/discounts_strict.sql", "utf8");
    await db.exec("reset role;begin");
    try {
      await db.exec(strict);
      await login(w.people.cashier);
      const refused = async (op) => { await db.exec("savepoint s"); await assert.rejects(send(op), refusal); await db.exec("rollback to savepoint s"); };
      await refused(w.again(o, one, fixed));
      await send(w.again(o, [...o.payload.order.lines, ...nasi(1)], fixed));
      await refused(w.again(v, two, { discount: 10000 }));
      await send(w.again(v, two, { discount: 10000 }, await w.pin(10000)));
    } finally {
      await db.exec("rollback");
      await login(w.people.cashier);
    }
    // Without it: accepted, as the deployed web app expects.
    await send(w.again(o, one, fixed));
    assert.deepEqual([(await w.stored(o)).totals, (await w.stored(o)).discountApprovedBy], [bill(25000, 20000), "manager"]);
    await send(w.again(v, two, { discount: 10000 }));
    assert.equal((await w.stored(v)).discount, 10000);
  });
};
