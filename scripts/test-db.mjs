import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const db = new PGlite({ extensions: { pgcrypto } });
let passed = 0;
await db.exec(
  `create schema auth;create schema extensions;create role anon;create role authenticated;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`,
);
for (const file of (await readdir("supabase/migrations")).sort()) {
  try {
    await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
  } catch (e) {
    console.error(`Migration failed: ${file}`, e.message);
    process.exit(1);
  }
}
const rid = randomUUID(),
  other = randomUUID(),
  owner = randomUUID(),
  cashier = randomUUID(),
  outsider = randomUUID(),
  device = randomUUID();
const settings = {
  id: "settings",
  appName: "Meja",
  name: "Warung Uji",
  address: "",
  phone: "",
  footer: "Terima kasih",
  timezone: "Asia/Jakarta",
  cutoff: 4,
  taxBps: 0,
  serviceBps: 0,
  receiptWidth: 80,
  printableWidth: 72,
  goLive: "2026-09-21",
  packaging: [],
};
await db.query("insert into auth.users values ($1),($2),($3)", [
  owner,
  cashier,
  outsider,
]);
await db.query(
  "insert into public.restaurants(id,settings) values($1,$3),($2,$3)",
  [rid, other, JSON.stringify(settings)],
);
await db.query(
  "insert into public.memberships values($1,$2,'owner','Owner',true),($1,$3,'cashier','Kasir',true),($4,$5,'owner','Other',true)",
  [rid, owner, cashier, other, outsider],
);
let actor = owner;
async function login(id) {
  actor = id;
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec("set role authenticated");
}
// Test introspection reads as the superuser: a cashier's own reads are limited by RLS on purpose.
async function read(sql, params) {
  const me = actor;
  await db.exec("reset role");
  try {
    return await db.query(sql, params);
  } finally {
    await login(me);
  }
}
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}:`, e);
    process.exitCode = 1;
  }
}
const op = (kind, payload, id = randomUUID()) => ({
  id,
  kind,
  payload,
  actor,
  restaurantId: rid,
  deviceId: device,
  occurredAt: new Date().toISOString(),
});
const send = (o) =>
  db.query("select public.apply_operation($1::jsonb) as result", [
    JSON.stringify(o),
  ]);
await login(owner);
await db.query("select public.enroll_device($1)", [device]);
const menu = {
  id: "nasi",
  name: "Nasi uji",
  category: "Makanan",
  price: 25000,
  active: true,
  soldOut: false,
  favorite: true,
  recipe: [{ stockId: "rice", qty: 100000 }],
  modifiers: [
    {
      id: "egg",
      name: "Telur",
      price: 5000,
      recipe: [{ stockId: "egg", qty: 1000 }],
    },
  ],
  version: 1,
};
await send(
  op("catalog.publish", {
    menu: [menu],
    stock: [
      { id: "rice", name: "Beras", unit: "g", threshold: 1000000 },
      { id: "egg", name: "Telur", unit: "pcs", threshold: 1000 },
    ],
  }),
);
await test("RLS blocks cross restaurant reads", async () => {
  const { rows } = await db.query("select id from public.restaurants");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, rid);
});
await test("Direct financial writes are denied", async () => {
  await assert.rejects(
    db.exec("insert into public.payments(restaurant_id) values('" + rid + "')"),
    /permission denied/,
  );
});
await login(cashier);
await test("Cashier cannot publish catalog or change own role", async () => {
  await assert.rejects(
    send(op("catalog.publish", { menu: [menu], stock: [] })),
    /Manager permission/,
  );
  await assert.rejects(
    db.exec("update public.memberships set role='owner'"),
    /permission denied/,
  );
  await assert.rejects(
    db.query("select public.sales_report('2026-09-21','2026-09-21')"),
    /Manager required/,
  );
});
const shift = randomUUID();
await send(op("shift.open", { id: shift, opening: 200000 }));
function makeOrder() {
  const o = op("order.save", {});
  const order = {
    id: randomUUID(),
    restaurantId: rid,
    shiftId: shift,
    actor,
    cashier: "Kasir",
    revision: 1,
    receiptId: "MJ-" + o.id.toUpperCase(),
    label: "Meja 03",
    mode: "dinein",
    lines: [
      {
        id: randomUUID(),
        itemId: "nasi",
        name: menu.name,
        price: 25000,
        qty: 1,
        modifiers: [menu.modifiers[0]],
        note: "Tidak pedas",
        recipe: menu.recipe,
        catalogVersion: 1,
        prepared: false,
        cancelled: false,
      },
    ],
    status: "open",
    prep: "new",
    discount: 0,
    discountReason: "",
    settings,
    totals: { subtotal: 30000, discount: 0, service: 0, tax: 0, total: 30000 },
    createdAt: o.occurredAt,
    updatedAt: o.occurredAt,
  };
  o.payload = { order, expectedRevision: 0 };
  return o;
}
const orderOp = makeOrder(),
  order = orderOp.payload.order;
await test("Order and line saved atomically", async () => {
  await send(orderOp);
  const { rows } = await read("select * from public.order_lines");
  assert.equal(rows.length, 1);
});
await test("Duplicate operation replay returns same receipt", async () => {
  const a = await send(orderOp),
    b = await send(orderOp);
  assert.deepEqual(a.rows, b.rows);
  assert.equal(
    (await read("select count(*)::int as n from public.orders")).rows[0].n,
    1,
  );
});
await test("Same ID with changed payload is rejected", async () => {
  const altered = structuredClone(orderOp);
  altered.payload.order.label = "changed";
  await assert.rejects(send(altered), /reused with different payload/);
});
await test("Rollback includes partial line failure", async () => {
  const bad = makeOrder();
  bad.payload.order.lines.push({
    ...bad.payload.order.lines[0],
    id: "not-a-uuid",
  });
  bad.payload.order.totals = {
    subtotal: 60000,
    discount: 0,
    service: 0,
    tax: 0,
    total: 60000,
  };
  await assert.rejects(send(bad));
  assert.equal(
    (await read("select count(*)::int as n from public.orders")).rows[0].n,
    1,
  );
});
await test("Server rejects client price tampering", async () => {
  const bad = makeOrder();
  bad.payload.order.lines[0].price = 1;
  await assert.rejects(send(bad), /Catalog snapshot mismatch/);
});
await test("Cashier discount without a manager approval is denied", async () => {
  const bad = makeOrder();
  bad.payload.order.discount = 1000;
  bad.payload.order.discountReason = "test";
  bad.payload.order.totals = { ...bad.payload.order.totals, discount: 1000, total: 29000 };
  await assert.rejects(send(bad), /Manager approval required/);
});
const prep = op("order.prepare", {
  id: order.id,
  expectedRevision: 1,
  lineIds: order.lines.map((l) => l.id),
});
await test("Preparation consumes recipe plus modifiers once", async () => {
  await send(prep);
  await send(prep);
  const { rows } = await read(
    "select stock_id,qty::float8 as qty from public.stock_movements order by stock_id",
  );
  assert.deepEqual(rows, [
    { stock_id: "egg", qty: -1000 },
    { stock_id: "rice", qty: -100000 },
  ]);
  await assert.rejects(
    send(op("order.prepare", { ...prep.payload, expectedRevision: 2 })),
    /already prepared/,
  );
});
await test("Insufficient tender does not commit payment", async () => {
  await assert.rejects(
    send(
      op("payment.record", {
        id: order.id,
        expectedRevision: 2,
        method: "cash",
        tendered: 1,
        verified: true,
      }),
    ),
    /Insufficient/,
  );
  assert.equal(
    (await read("select count(*)::int as n from public.payments")).rows[0]
      .n,
    0,
  );
});
const payment = op("payment.record", {
  id: order.id,
  expectedRevision: 2,
  method: "cash",
  tendered: 50000,
  verified: true,
});
await test("Commit then lost acknowledgment is safe to retry", async () => {
  await send(payment);
  await send(payment);
  assert.equal(
    (await read("select count(*)::int as n from public.payments")).rows[0]
      .n,
    1,
  );
});
await test("Completed financial records cannot be changed", async () => {
  const bad = structuredClone(orderOp);
  bad.id = randomUUID();
  bad.payload.expectedRevision = 3;
  bad.payload.order.revision = 4;
  await assert.rejects(send(bad), /revision\/state conflict/);
});
await test("Cashier refund without a manager approval is denied", async () => {
  await assert.rejects(
    send(
      op("refund.record", { id: order.id, expectedRevision: 3, reason: "uji" }),
    ),
    /Manager approval required/,
  );
});
const snapshot = (await read("select snapshot from public.orders")).rows[0]
  .snapshot;
await login(owner);
await test("Server rejects remote or unbounded menu photos", async () => {
  await assert.rejects(
    send(
      op("catalog.publish", {
        menu: [{ ...menu, photo: "https://example.com/menu.jpg", version: 2 }],
        stock: [],
      }),
    ),
    /Invalid menu photo/,
  );
});
await test("Compressed optional photo syncs while historical receipt remains unchanged", async () => {
  const photo = "data:image/webp;base64,UklGRg==";
  await send(
    op("catalog.publish", {
      menu: [{ ...menu, photo, price: 35000, version: 2 }],
      stock: [],
    }),
  );
  assert.deepEqual(
    (await db.query("select snapshot from public.orders")).rows[0].snapshot,
    snapshot,
  );
  assert.equal(
    (
      await db.query(
        "select snapshot->>'photo' as photo from public.catalog_versions where restaurant_id=$1 and item_id='nasi' and version=2",
        [rid],
      )
    ).rows[0].photo,
    photo,
  );
});
await login(outsider);
await test("Cross restaurant operation denied", async () => {
  await assert.rejects(
    send(
      op("order.void", { id: order.id, expectedRevision: 3, reason: "attack" }),
    ),
    /Membership denied/,
  );
  assert.equal(
    (await db.query("select count(*)::int as n from public.orders")).rows[0].n,
    0,
  );
});
await login(cashier);
await test("Cash purchase cannot double deduct drawer", async () => {
  await assert.rejects(
    send(
      op("stock.record", {
        stockId: "rice",
        kind: "purchase",
        qty: 1000,
        cost: 10000,
        fromDrawer: true,
        shiftId: shift,
        reason: "test",
      }),
    ),
    /Manager permission/,
  );
});
const approve = async (approver, pin, action, orderId = null, amount = null) =>
  (await db.query("select public.approve($1,$2,$3,$4,$5) as r", [approver, pin, action, orderId, amount])).rows[0].r;
const discounted = (amount, approval) => {
  const o = makeOrder();
  Object.assign(o.payload.order, { discount: amount, discountReason: "Langganan", totals: { ...o.payload.order.totals, discount: amount, total: 30000 - amount } });
  if (approval) o.payload.approval = approval;
  return o;
};
await login(owner);
await test("Managers set their own 6-digit approval PIN; cashiers cannot, and nobody reads hashes", async () => {
  await assert.rejects(db.query("select public.set_approval_pin('111111')"), /not trivial/);
  await assert.rejects(db.query("select public.set_approval_pin('12345')"), /6 digits/);
  await db.query("select public.set_approval_pin('482915')");
  await assert.rejects(db.query("select * from public.approval_pins"), /permission denied/);
  await login(cashier);
  await assert.rejects(db.query("select public.set_approval_pin('482915')"), /Manager required/);
});
await test("A cashier voids only with a manager's PIN approval for that very order", async () => {
  const o = makeOrder();
  await send(o);
  const id = o.payload.order.id;
  const voiding = (approval) => op("order.void", { id, expectedRevision: 1, reason: "Salah meja", ...(approval && { approval }) });
  await assert.rejects(send(voiding()), /Manager approval required/);
  assert.deepEqual(await approve(owner, "000001", "void", id), { error: "wrong-pin" });
  await assert.rejects(approve(cashier, "482915", "void", id), /active manager/);
  const elsewhere = await approve(owner, "482915", "void", randomUUID());
  await assert.rejects(send(voiding(elsewhere.id)), /Manager approval required/);
  const granted = await approve(owner, "482915", "void", id);
  assert.equal(granted.by, "Owner");
  await send(voiding(granted.id));
  const { rows } = await read("select snapshot->>'status' as status,snapshot->>'voidApprovedBy' as by from public.orders where id=$1", [id]);
  assert.deepEqual(rows, [{ status: "void", by: "Owner" }]);
});
await test("A discount approval covers one order with exactly the approved amount", async () => {
  const granted = await approve(owner, "482915", "discount", null, 5000);
  await assert.rejects(send(discounted(4000, granted.id)), /Manager approval required/);
  const first = discounted(5000, granted.id);
  await send(first);
  await assert.rejects(send(discounted(5000, granted.id)), /Manager approval required/);
  const { rows } = await read("select snapshot->>'discountApprovedBy' as by from public.orders where id=$1", [first.payload.order.id]);
  assert.deepEqual(rows, [{ by: "Owner" }]);
  // Saving the order again without changing the discount keeps the approver; the client cannot rename it.
  const again = op("order.save", { order: { ...first.payload.order, revision: 2, label: "Meja 7", discountApprovedBy: "Kasir" }, expectedRevision: 1 });
  await send(again);
  assert.deepEqual((await read("select snapshot->>'discountApprovedBy' as by from public.orders where id=$1", [first.payload.order.id])).rows, [{ by: "Owner" }]);
  const cancel = await approve(owner, "482915", "void", first.payload.order.id);
  await send(op("order.void", { id: first.payload.order.id, expectedRevision: 2, reason: "Uji selesai", approval: cancel.id }));
});
await test("Cash out by a cashier needs an approval for that amount; cash in does not", async () => {
  await assert.rejects(send(op("shift.cash", { shiftId: shift, amount: -5000, reason: "Es batu" })), /Manager approval required/);
  const granted = await approve(owner, "482915", "cashout", null, 5000);
  await send(op("shift.cash", { shiftId: shift, amount: -5000, reason: "Es batu", approval: granted.id }));
  await send(op("shift.cash", { shiftId: shift, amount: 5000, reason: "Kembalian ditukar" }));
});
await test("Wrong PINs lock approvals for the restaurant, even with the right PIN", async () => {
  // One wrong PIN already failed above; the third failure in five minutes locks.
  for (let i = 0; i < 2; i++) assert.equal((await approve(owner, "000002", "void", order.id)).error, "wrong-pin");
  assert.deepEqual(await approve(owner, "482915", "void", order.id), { error: "locked" });
});
await test("Shift closes with expected cash derived from payments", async () => {
  await send(op("shift.close", { id: shift, counted: 230000 }));
  const { rows } = await read(
    "select expected::int,variance::int from public.shifts",
  );
  assert.deepEqual(rows, [{ expected: 230000, variance: 0 }]);
});
await test("A cashier reads no sales history from the API, and bootstrap closes the drawer blind", async () => {
  assert.equal((await db.query("select count(*)::int as n from public.payments")).rows[0].n, 0);
  const boot = (await db.query("select public.bootstrap($1) as b", [device])).rows[0].b;
  assert.deepEqual(boot.shifts.map((s) => [s.counted, s.expected, s.variance]), [[230000, null, null]]);
  assert.deepEqual(boot.orders, []);
  await login(owner);
  assert.equal((await db.query("select count(*)::int as n from public.payments")).rows[0].n, 1);
  const own = (await db.query("select public.bootstrap($1) as b", [device])).rows[0].b;
  assert.deepEqual(own.shifts.map((s) => s.expected), [230000]);
  assert.deepEqual(own.cash.filter((c) => c.amount < 0).map((c) => c.approvedBy), ["Owner"]);
  await login(cashier);
});
const phone = randomUUID();
await login(cashier);
await test("Cashier cannot claim the till device", async () => {
  await assert.rejects(
    db.query("select public.enroll_device($1)", [phone]),
    /Manager required/,
  );
});
await login(owner);
await test("Owner moves the till device to any other device, shift and audit follow", async () => {
  // Sif disiapkan sebagai superuser: klien memang tidak punya hak tulis ke tabel mana pun.
  const shiftId = randomUUID();
  await db.exec("reset role");
  await db.query(
    "insert into public.shifts(restaurant_id,id,actor,device_id,opened_at,expires_at,opening,cashier,catalog) values($1,$2,$3,$4,now(),now()+interval '12 hours',0,'Owner','{}')",
    [rid, shiftId, owner, device],
  );
  await login(owner);
  await db.query("select public.enroll_device($1)", [phone]);
  assert.equal(
    (
      await db.query(
        "select primary_device_id from public.restaurants where id=$1",
        [rid],
      )
    ).rows[0].primary_device_id,
    phone,
  );
  assert.notEqual(
    (
      await db.query(
        "select revoked_at from public.devices where restaurant_id=$1 and id=$2",
        [rid, device],
      )
    ).rows[0].revoked_at,
    null,
  );
  assert.equal(
    (
      await db.query("select device_id from public.shifts where id=$1", [
        shiftId,
      ])
    ).rows[0].device_id,
    phone,
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from public.device_handovers where restaurant_id=$1",
        [rid],
      )
    ).rows[0].n,
    1,
  );
  await db.exec("reset role");
  await db.query("update public.shifts set closed_at=now() where id=$1", [
    shiftId,
  ]);
  await login(owner);
  await db.query("select public.enroll_device($1)", [device]);
});
await login(cashier);
await test("Cashier cannot manage staff", async () => {
  await assert.rejects(
    db.query("select public.manage_staff($1,$2,$3)", [cashier, "owner", true]),
    /Owner required/,
  );
});
await login(owner);
await test("Owner changes staff role and access, never their own", async () => {
  await db.query("select public.manage_staff($1,$2,$3)", [
    cashier,
    "manager",
    false,
  ]);
  assert.deepEqual(
    (
      await db.query(
        "select role,active from public.memberships where user_id=$1",
        [cashier],
      )
    ).rows,
    [{ role: "manager", active: false }],
  );
  await assert.rejects(
    db.query("select public.manage_staff($1,$2,$3)", [owner, "cashier", true]),
    /own access/,
  );
  await assert.rejects(
    db.query("select public.manage_staff($1,$2,$3)", [
      outsider,
      "cashier",
      true,
    ]),
    /not found/,
  );
  await db.query("select public.manage_staff($1,$2,$3)", [
    cashier,
    "cashier",
    true,
  ]);
});
const qty = async (stock, restaurant = rid) =>
  (await read("select coalesce(sum(qty),0)::float8 as q from public.stock_movements where restaurant_id=$1 and stock_id=$2", [restaurant, stock])).rows[0].q;
const row = async (table, id) => (await read(`select status,snapshot from public.${table} where id=$1`, [id])).rows[0];
const purchaseOrder = (lines, supplier = "Pasar Cihapit", extra = {}) => {
  const o = op("purchase.save", {});
  const order = { id: randomUUID(), number: "PO-" + o.id.slice(0, 8).toUpperCase(), supplier, note: "", lines, total: lines.reduce((n, l) => n + l.cost, 0), receipts: [], payments: [], status: "ordered", revision: 1, createdAt: o.occurredAt, updatedAt: o.occurredAt, ...extra };
  o.payload = { order, expectedRevision: 0 };
  return o;
};
const ownerShift = randomUUID();
await test("Suppliers keep contact details, and a purchase order can name one", async () => {
  const supplier = { id: randomUUID(), name: "CV Beras Makmur", phone: "+62 812-3456-7890", address: "Jl. Pasar 1", note: "", active: true };
  await assert.rejects(send(op("supplier.save", { supplier: { ...supplier, phone: "telepon saja" } })), /Invalid supplier/);
  await send(op("supplier.save", { supplier }));
  await send(op("supplier.save", { supplier: { ...supplier, note: "Tempo 14 hari" } }));
  assert.equal((await read("select snapshot->>'note' as note from public.suppliers where id=$1", [supplier.id])).rows[0].note, "Tempo 14 hari");
  await assert.rejects(send(purchaseOrder([{ stockId: "rice", qty: 1000, cost: 1 }], "Entah", { supplierId: randomUUID() })), /Invalid purchase order/);
  await send(purchaseOrder([{ stockId: "rice", qty: 1000, cost: 1 }], supplier.name, { supplierId: supplier.id }));
});
await test("A purchase order arrives in several deliveries, is paid in parts, and completes once all arrived", async () => {
  await send(op("shift.open", { id: ownerShift, opening: 100000 }));
  const save = purchaseOrder([{ stockId: "rice", qty: 10000000, cost: 150000 }, { stockId: "egg", qty: 30000, cost: 60000 }]);
  const po = save.payload.order;
  await send(save);
  const rice = await qty("rice");
  const first = op("purchase.receive", { id: po.id, expectedRevision: 1, lines: [{ stockId: "rice", qty: 5000000, cost: 75000 }], payment: "drawer", shiftId: ownerShift });
  await send(first);
  await send(first);
  assert.equal((await qty("rice")) - rice, 5000000);
  assert.equal((await row("purchase_orders", po.id)).status, "partial");
  await assert.rejects(send(op("purchase.receive", { id: po.id, expectedRevision: 2, lines: [{ stockId: "rice", qty: 1000, cost: 1 }, { stockId: "nasi-goreng", qty: 1000, cost: 1 }], payment: "unpaid" })), /Invalid purchase line|not on the purchase order/);
  await assert.rejects(send(op("purchase.save", { order: { ...po, revision: 2 }, expectedRevision: 2 })), /revision\/state conflict/);
  await send(op("purchase.receive", { id: po.id, expectedRevision: 2, lines: [{ stockId: "rice", qty: 5000000, cost: 75000 }, { stockId: "egg", qty: 30000, cost: 60000 }], payment: "unpaid" }));
  const done = await row("purchase_orders", po.id);
  assert.deepEqual([done.status, done.snapshot.receipts.length, done.snapshot.payments.map((x) => x.amount)], ["received", 2, [75000]]);
  await assert.rejects(send(op("purchase.pay", { id: po.id, expectedRevision: 3, amount: 135001, payment: "outside" })), /not payable/);
  await send(op("purchase.pay", { id: po.id, expectedRevision: 3, amount: 100000, payment: "outside" }));
  await send(op("purchase.pay", { id: po.id, expectedRevision: 4, amount: 35000, payment: "outside" }));
  await assert.rejects(send(op("purchase.pay", { id: po.id, expectedRevision: 5, amount: 1, payment: "outside" })), /not payable/);
  assert.deepEqual((await read("select amount::int from public.cash_movements where shift_id=$1", [ownerShift])).rows, [{ amount: -75000 }]);
});
await test("A purchase order closed short stops waiting; one never delivered is cancelled", async () => {
  const short = purchaseOrder([{ stockId: "egg", qty: 30000, cost: 60000 }], "CV Telur Jaya");
  await send(short);
  await send(op("purchase.receive", { id: short.payload.order.id, expectedRevision: 1, lines: [{ stockId: "egg", qty: 20000, cost: 40000 }], payment: "unpaid" }));
  await send(op("purchase.cancel", { id: short.payload.order.id, expectedRevision: 2, reason: "Sisa tidak tersedia" }));
  const closed = await row("purchase_orders", short.payload.order.id);
  assert.deepEqual([closed.status, closed.snapshot.closeReason], ["received", "Sisa tidak tersedia"]);
  const never = purchaseOrder([{ stockId: "rice", qty: 1000000, cost: 15000 }]);
  await send(never);
  const rice = await qty("rice");
  await send(op("purchase.cancel", { id: never.payload.order.id, expectedRevision: 1, reason: "Pemasok tutup" }));
  await assert.rejects(send(op("purchase.receive", { id: never.payload.order.id, expectedRevision: 2, lines: never.payload.order.lines, payment: "outside" })), /Invalid purchase receipt/);
  assert.equal(await qty("rice"), rice);
});
await test("Production costs a batch at the latest input prices; a recipe cannot use itself", async () => {
  const sambal = { id: "sambal", name: "Sambal ijo (porsi)", unit: "pcs", threshold: 0, production: { inputs: [{ stockId: "egg", qty: 2000 }], output: 10000 } };
  await assert.rejects(send(op("catalog.publish", { menu: [], stock: [{ ...sambal, production: { inputs: [{ stockId: "sambal", qty: 1000 }], output: 1000 } }] })), /Invalid production recipe/);
  await send(op("catalog.publish", { menu: [], stock: [sambal] }));
  const egg = await qty("egg");
  await send(op("production.record", { stockId: "sambal", qty: 20000, inputs: [{ stockId: "egg", qty: 4000 }], note: "2 batch" }));
  assert.deepEqual([await qty("sambal"), egg - (await qty("egg"))], [20000, 4000]);
  // Latest egg price: 20 eggs for Rp40.000, so 4 eggs cost Rp8.000.
  assert.deepEqual((await read("select reason,cost::int from public.stock_movements where stock_id='sambal'")).rows, [{ reason: "Produksi Sambal ijo (porsi) · 2 batch", cost: 8000 }]);
  await assert.rejects(send(op("production.record", { stockId: "sambal", qty: 1000, inputs: [{ stockId: "sambal", qty: 1000 }] })), /Invalid production/);
});
const salesOrder = (lines, extra = {}) => {
  const o = op("salesorder.save", {});
  const subtotal = lines.reduce((n, l) => n + l.qty * l.price, 0);
  const order = { id: randomUUID(), number: "SO-" + o.id.slice(0, 8).toUpperCase(), customer: { name: "PT Maju Jaya", phone: "0812 1111 2222", address: "Jl. Asia Afrika 8" }, deliverAt: new Date(Date.now() + 86400000).toISOString(), lines, discount: 0, note: "", totals: { subtotal, discount: 0, service: 0, tax: 0, total: subtotal }, payments: [], status: "confirmed", revision: 1, createdAt: o.occurredAt, updatedAt: o.occurredAt, ...extra };
  o.payload = { order, expectedRevision: 0 };
  return o;
};
const catering = () => [{ id: randomUUID(), itemId: "nasi", name: "Nasi uji", qty: 40, price: 20000, catalogVersion: 2 }];
await test("A catering order takes a down payment, uses its recipes from stock on delivery, and is settled later", async () => {
  const bad = salesOrder(catering());
  bad.payload.order.totals = { ...bad.payload.order.totals, total: 1 };
  await assert.rejects(send(bad), /total mismatch/);
  const save = salesOrder(catering()), id = save.payload.order.id;
  await send(save);
  await assert.rejects(send(op("salesorder.pay", { id, expectedRevision: 1, amount: 800001, payment: "outside" })), /not payable/);
  await send(op("salesorder.pay", { id, expectedRevision: 1, amount: 300000, payment: "drawer", shiftId: ownerShift }));
  assert.deepEqual((await read("select amount::int from public.cash_movements where shift_id=$1 and amount>0", [ownerShift])).rows, [{ amount: 300000 }]);
  const rice = await qty("rice");
  await send(op("salesorder.deliver", { id, expectedRevision: 2 }));
  assert.equal(rice - (await qty("rice")), 40 * 100000);
  await assert.rejects(send(op("salesorder.cancel", { id, expectedRevision: 3, reason: "Batal" })), /Invalid sales order cancellation/);
  await send(op("salesorder.pay", { id, expectedRevision: 3, amount: 500000, payment: "outside" }));
  const settled = await row("sales_orders", id);
  assert.deepEqual([settled.status, settled.snapshot.payments.map((x) => x.amount)], ["delivered", [300000, 500000]]);
});
await test("A cancelled catering order can return its down payment, never more than was paid", async () => {
  const save = salesOrder(catering()), id = save.payload.order.id;
  await send(save);
  await send(op("salesorder.pay", { id, expectedRevision: 1, amount: 100000, payment: "outside" }));
  await assert.rejects(send(op("salesorder.cancel", { id, expectedRevision: 2, reason: "Acara batal", refund: 100001, payment: "outside" })), /Invalid sales order cancellation/);
  await send(op("salesorder.cancel", { id, expectedRevision: 2, reason: "Acara batal", refund: 100000, payment: "outside" }));
  const cancelled = await row("sales_orders", id);
  assert.deepEqual([cancelled.status, cancelled.snapshot.payments.map((x) => x.amount)], ["cancelled", [100000, -100000]]);
});
const device2 = randomUUID();
const atOther = (kind, payload) => ({ id: randomUUID(), kind, payload, actor: outsider, restaurantId: other, deviceId: device2, occurredAt: new Date().toISOString() });
const transfer = (lines) => {
  const o = op("transfer.send", {});
  o.payload = { transfer: { id: randomUUID(), number: "TR-" + o.id.slice(0, 8).toUpperCase(), to: other, lines, note: "" } };
  return o;
};
await test("Linked outlets transfer stock: it leaves at once, the other outlet books it in; unlinked outlets cannot", async () => {
  await login(outsider);
  await db.query("select public.enroll_device($1)", [device2]);
  await send(atOther("catalog.publish", { menu: [], stock: [{ id: "beras", name: "Beras", unit: "g", threshold: 0 }, { id: "telor", name: "Telor", unit: "pcs", threshold: 0 }] }));
  await login(owner);
  await assert.rejects(send(transfer([{ stockId: "rice", qty: 2000000 }])), /not a linked outlet/);
  await db.exec("reset role");
  const group = randomUUID();
  await db.query("update public.restaurants set group_id=$1 where id in ($2,$3)", [group, rid, other]);
  await login(owner);
  const rice = await qty("rice");
  const sent = transfer([{ stockId: "rice", qty: 2000000 }, { stockId: "egg", qty: 10000 }]), id = sent.payload.transfer.id;
  await send(sent);
  assert.equal(rice - (await qty("rice")), 2000000);
  await login(outsider);
  const seen = (await db.query("select public.outlet_transfers() as t")).rows[0].t;
  assert.deepEqual([seen.outlets.map((o) => o.id), seen.transfers[0].lines.map((l) => [l.stockId, l.value])], [[rid], [["rice", 30000], ["egg", 20000]]]);
  await assert.rejects(send(atOther("transfer.cancel", { id, reason: "bukan milik kami" })), /Invalid transfer cancellation/);
  await assert.rejects(send(atOther("transfer.receive", { id, lines: [{ stockId: "rice", target: "telor", qty: 2000000 }, { stockId: "egg", target: "telor", qty: 10000 }] })), /same unit/);
  await send(atOther("transfer.receive", { id, lines: [{ stockId: "rice", target: "beras", qty: 2000000 }, { stockId: "egg", target: "telor", qty: 9000 }] }));
  assert.deepEqual([await qty("beras", other), await qty("telor", other)], [2000000, 9000]);
  assert.deepEqual((await read("select cost::int from public.stock_movements where restaurant_id=$1 order by stock_id", [other])).rows, [{ cost: 30000 }, { cost: 18000 }]);
  await assert.rejects(send(atOther("transfer.receive", { id, lines: [] })), /not in transit/);
  await login(owner);
  const back = transfer([{ stockId: "egg", qty: 5000 }]);
  const eggs = await qty("egg");
  await send(back);
  await send(op("transfer.cancel", { id: back.payload.transfer.id, reason: "Kurir tidak datang" }));
  assert.equal(await qty("egg"), eggs);
});
await test("Managers get the back office at sign-in; a cashier gets none of it and cannot write it", async () => {
  const own = (await db.query("select public.bootstrap($1) as b", [device])).rows[0].b;
  assert.deepEqual([own.suppliers.length, own.salesOrders.length, own.purchaseOrders.length, own.outletData.outlets.length], [1, 2, 4, 1]);
  assert.deepEqual(own.stock.find((x) => x.id === "sambal").production, { inputs: [{ stockId: "egg", qty: 2000 }], output: 10000 });
  assert.equal(own.stock.find((x) => x.id === "rice").production, undefined);
  assert.equal(own.costs.sambal, 0.4);
  await login(cashier);
  const theirs = (await db.query("select public.bootstrap($1) as b", [device])).rows[0].b;
  assert.deepEqual([theirs.purchaseOrders, theirs.suppliers, theirs.salesOrders, theirs.outletData], [[], [], [], null]);
  await assert.rejects(send(purchaseOrder([{ stockId: "rice", qty: 1000, cost: 1 }])), /Manager permission/);
  await send(op("production.record", { stockId: "sambal", qty: 1000, inputs: [{ stockId: "egg", qty: 1000 }] })); // batches are the cashier's too
  await assert.rejects(send(salesOrder(catering())), /Manager permission/);
  await assert.rejects(send(transfer([{ stockId: "rice", qty: 1000 }])), /Manager permission/);
  await assert.rejects(db.query("select public.outlet_transfers()"), /Manager required/);
  await login(owner);
});
// ---- Takar (202611060009): roles, paired devices, stations, option deltas, counts, variance, pull, audit ----
const station = randomUUID(), laptop = randomUUID();
const kitchen = randomUUID(), admin = randomUUID(), chef = randomUUID(), mgr = randomUUID();
await db.exec("reset role");
await db.query("insert into auth.users values($1),($2),($3),($4)", [kitchen, admin, chef, mgr]);
await db.query("insert into public.memberships values($1,$2,'kitchen','Dapur',true),($1,$3,'admin','Admin',true),($1,$4,'chef','Chef',true),($1,$5,'manager','Manajer',true)", [rid, kitchen, admin, chef, mgr]);
await db.query("delete from public.approval_failures");
await login(owner);
const opOn = (dev, kind, payload) => ({ ...op(kind, payload), deviceId: dev });
const snap = async (id) => (await read("select revision,snapshot from public.orders where id=$1", [id])).rows[0];
await test("Pairing a station or office device never moves the till; only owners and managers pair", async () => {
  await db.query("select public.enroll_device($1,'station')", [station]);
  await db.query("select public.enroll_device($1,'office')", [laptop]);
  assert.equal((await db.query("select primary_device_id from public.restaurants where id=$1", [rid])).rows[0].primary_device_id, device);
  assert.deepEqual((await read("select mode from public.devices where restaurant_id=$1 and id in ($2,$3) order by mode", [rid, station, laptop])).rows, [{ mode: "office" }, { mode: "station" }]);
  await login(kitchen);
  await assert.rejects(db.query("select public.enroll_device($1,'station')", [randomUUID()]), /Manager required/);
  await login(owner);
});
const photo = "data:image/webp;base64,UklGRg==";
const nasiV2 = { ...menu, photo, price: 35000, version: 2 };
const oat = { id: "milk-oat", name: "Oat", price: 5000, recipe: [{ stockId: "milk", qty: -195000 }, { stockId: "oat", qty: 195000 }], group: "milk" };
const latte = { id: "latte", name: "Latte", category: "Minuman", type: "beverage", station: "bar", price: 30000, active: true, soldOut: false, favorite: false, recipe: [{ stockId: "milk", qty: 195000 }], groups: [{ id: "milk", name: "Susu", kind: "swap", required: true }], modifiers: [{ id: "milk-fresh", name: "Susu segar", price: 0, recipe: [], group: "milk", default: true }, oat], version: 1, tags: ["kopi"], aliases: ["kopi susu"], lowAt: 5 };
const takarStock = [{ id: "rice", name: "Beras", unit: "g", threshold: 1000000, area: "Dry store", packs: [{ name: "karung", qty: 25000000 }], aliases: ["nasi"] }, { id: "egg", name: "Telur", unit: "pcs", threshold: 1000 }, { id: "milk", name: "Susu segar", unit: "ml", threshold: 1000000, area: "Kulkas bar" }, { id: "oat", name: "Susu oat", unit: "ml", threshold: 1000000, area: "Kulkas bar" }];
await test("A catalog carries types, stations, packs and option deltas; a base recipe may not go negative", async () => {
  await assert.rejects(send(op("catalog.publish", { menu: [nasiV2, { ...latte, recipe: [{ stockId: "milk", qty: -1000 }] }], stock: takarStock })), /Invalid ingredient/);
  await assert.rejects(send(op("catalog.publish", { menu: [nasiV2, { ...latte, groups: [{ id: "milk", name: "Susu", kind: "giant" }] }], stock: takarStock })), /Invalid menu/);
  await send(op("catalog.publish", { menu: [nasiV2, latte], stock: takarStock }));
  const boot = (await db.query("select public.bootstrap($1) as b", [station])).rows[0].b;
  assert.deepEqual(boot.device, { mode: "station", enrolled: true, primary: false });
  assert.deepEqual(boot.stock.find((s) => s.id === "rice").packs, [{ name: "karung", qty: 25000000 }]);
  assert.ok(boot.team.some((m) => m.role === "kitchen" && m.name === "Dapur"));
  assert.ok(boot.now);
});
await test("Publishing an active item without a recipe is the chef's call only with a manager's PIN", async () => {
  await login(chef);
  const bare = { ...latte, id: "bare", name: "Bare", recipe: [], modifiers: [], groups: [] };
  await assert.rejects(send(opOn(laptop, "catalog.publish", { menu: [nasiV2, latte, bare], stock: [] })), /Manager approval required/);
  await send(opOn(laptop, "catalog.publish", { menu: [nasiV2, latte, { ...bare, active: false }], stock: [] }));
  const granted = await approve(owner, "482915", "publish");
  await send(opOn(laptop, "catalog.publish", { menu: [nasiV2, latte, { ...bare, version: 2 }], stock: [], approval: granted.id }));
  // Re-sending the accepted version (as saving an ingredient does) needs no PIN.
  await send(opOn(laptop, "catalog.publish", { menu: [nasiV2, latte, { ...bare, version: 2 }], stock: [] }));
  await login(owner);
});
const ticket = () => {
  const o = op("order.save", {});
  const order = { id: randomUUID(), restaurantId: rid, shiftId: ownerShift, actor, cashier: "Owner", revision: 1, receiptId: "MJ-" + o.id.toUpperCase(), label: "Pager 7", mode: "dinein", status: "open", prep: "new", discount: 0, discountReason: "", settings, createdAt: o.occurredAt, updatedAt: o.occurredAt,
    lines: [{ id: randomUUID(), itemId: "nasi", name: "Nasi uji", price: 35000, qty: 1, modifiers: [], note: "", recipe: menu.recipe, catalogVersion: 2, prepared: false, cancelled: false, station: "kitchen" }, { id: randomUUID(), itemId: "latte", name: "Latte", price: 30000, qty: 1, modifiers: [oat], note: "", recipe: latte.recipe, catalogVersion: 1, prepared: false, cancelled: false, station: "bar" }],
    totals: { subtotal: 70000, discount: 0, service: 0, tax: 0, total: 70000 } };
  o.payload = { order, expectedRevision: 0 };
  return o;
};
const t1 = ticket(), tid = t1.payload.order.id;
await test("Sending a ticket stamps the station and time, and a swap never pushes an ingredient below zero", async () => {
  await send(t1);
  const milk = await qty("milk"), oatMilk = await qty("oat");
  await send(op("order.prepare", { id: tid, expectedRevision: 1, lineIds: t1.payload.order.lines.map((l) => l.id) }));
  assert.deepEqual([milk - (await qty("milk")), oatMilk - (await qty("oat"))], [0, 195000]);
  const { snapshot } = await snap(tid);
  assert.ok(snapshot.lines.every((l) => l.prepared && l.preparedAt && ["kitchen", "bar"].includes(l.station)));
});
await test("A station marks only its own lines ready, leaves the revision alone, and the till's next save still lands", async () => {
  await login(kitchen);
  await send(opOn(station, "order.ready", { id: tid, station: "kitchen" }));
  let o = await snap(tid);
  assert.deepEqual([o.revision, o.snapshot.prep, o.snapshot.lines.map((l) => Boolean(l.readyAt))], [2, "preparing", [true, false]]);
  await assert.rejects(send(opOn(station, "payment.record", { id: tid, expectedRevision: 2, method: "cash", tendered: 70000, verified: true })), /Manager permission/);
  await login(owner);
  const lines = o.snapshot.lines.map(({ readyAt, ...l }) => l);
  await send(op("order.save", { order: { ...o.snapshot, lines, label: "Pager 12", prep: "preparing", revision: 3 }, expectedRevision: 2 }));
  o = await snap(tid);
  assert.deepEqual([o.revision, o.snapshot.label, Boolean(o.snapshot.lines[0].readyAt), o.snapshot.prep], [3, "Pager 12", true, "preparing"]);
  await send(op("payment.record", { id: tid, expectedRevision: 3, method: "qris", tendered: 0, verified: true }));
  // Ziggy pays at the counter first: the bar still serves the paid order and marks it ready.
  await send(opOn(station, "order.ready", { id: tid, station: "bar" }));
  o = await snap(tid);
  assert.deepEqual([o.revision, o.snapshot.status, o.snapshot.prep], [4, "paid", "ready"]);
});
await test("Station crew log waste and batches from the station tablet, nothing else", async () => {
  await login(kitchen);
  const rice = await qty("rice");
  await send(opOn(station, "stock.record", { stockId: "rice", kind: "waste", qty: 1000, cost: 0, fromDrawer: false, reason: "jatuh" }));
  assert.equal(rice - (await qty("rice")), 1000);
  await assert.rejects(send(opOn(station, "stock.record", { stockId: "rice", kind: "purchase", qty: 1000, cost: 0, fromDrawer: false, reason: "beli" })), /Manager permission/);
  await send(opOn(station, "production.record", { stockId: "sambal", qty: 1000, inputs: [{ stockId: "egg", qty: 100 }], note: "" }));
  await assert.rejects(send(opOn(station, "order.save", t1.payload.order)), /Manager permission/);
  await login(admin);
  await assert.rejects(send(opOn(laptop, "stock.record", { stockId: "rice", kind: "adjustment", qty: 1000, cost: 0, fromDrawer: false, reason: "ubah" })), /Manager permission/);
  await send(opOn(laptop, "stock.record", { stockId: "rice", kind: "purchase", qty: 1000, cost: 0, fromDrawer: false, reason: "beli" }));
  await login(owner);
  await assert.rejects(send(opOn(station, "shift.cash", { shiftId: ownerShift, amount: 1000, reason: "tes" })), /Primary cashier device/);
});
await test("A count becomes stock only with a manager's PIN, and every line leaves a movement and a record", async () => {
  await login(admin);
  const rice = await qty("rice"), eggs = await qty("egg"), id = randomUUID();
  const count = (approval) => opOn(laptop, "count.record", { id, area: "Dry store", lines: [{ stockId: "rice", counted: rice - 500000, reason: "tumpah" }, { stockId: "egg", counted: eggs }], ...(approval && { approval }) });
  await assert.rejects(send(count()), /Manager approval required/);
  const granted = await approve(owner, "482915", "count", id);
  await send(count(granted.id));
  assert.equal(rice - (await qty("rice")), 500000);
  assert.deepEqual((await read("select reason,qty::int as qty from public.stock_movements where operation_id=(select operation_id from public.counts where id=$1) order by stock_id", [id])).rows, [{ reason: "Hitung Dry store", qty: 0 }, { reason: "Hitung Dry store: tumpah", qty: -500000 }]);
  assert.deepEqual((await read("select approver,jsonb_array_length(lines)::int as n from public.counts where id=$1", [id])).rows, [{ approver: "Owner", n: 2 }]);
  await login(owner);
  await send(op("count.record", { id: randomUUID(), area: "Dry store", lines: [{ stockId: "rice", counted: await qty("rice") }] }));
});
await test("A cashier's gap over the limit needs a PIN; an owner closes anyone's shift, also after the 12 hours", async () => {
  await send(op("shift.close", { id: ownerShift, counted: 0 }));
  await login(cashier);
  const s1 = randomUUID();
  await send(op("shift.open", { id: s1, opening: 100000 }));
  await assert.rejects(send(op("shift.close", { id: s1, counted: 200000 })), /Manager approval required/);
  await send(op("shift.close", { id: s1, counted: 110000 }));
  const s2 = randomUUID();
  await send(op("shift.open", { id: s2, opening: 100000 }));
  const granted = await approve(owner, "482915", "variance", null, 100000);
  await send(op("shift.close", { id: s2, counted: 200000, approval: granted.id }));
  assert.deepEqual((await read("select variance::int as v,variance_approved_by as by from public.shifts where id=$1", [s2])).rows, [{ v: 100000, by: "Owner" }]);
  const s3 = randomUUID();
  await send(op("shift.open", { id: s3, opening: 0 }));
  const left = ticket(); left.payload.order.shiftId = s3; left.payload.order.cashier = "Kasir"; left.payload.order.lines = [left.payload.order.lines[0]]; left.payload.order.totals = { subtotal: 35000, discount: 0, service: 0, tax: 0, total: 35000 };
  await send(left);
  await send(op("order.prepare", { id: left.payload.order.id, expectedRevision: 1, lineIds: [left.payload.order.lines[0].id] }));
  await db.exec("reset role");
  await db.query("update public.shifts set opened_at=now()-interval '13 hours',expires_at=now()-interval '1 hour' where id=$1", [s3]);
  await login(cashier);
  await assert.rejects(send(ticket()), /No authorized shift/);
  await send(op("payment.record", { id: left.payload.order.id, expectedRevision: 2, method: "cash", tendered: 35000, verified: true }));
  const gone = ticket(); gone.payload.order.shiftId = s3; gone.payload.order.cashier = "Kasir";
  await db.exec("reset role");
  await db.query("update public.shifts set opened_at=now()-interval '1 hour',expires_at=now()+interval '1 hour' where id=$1", [s3]);
  await login(cashier);
  await send(gone);
  await login(owner);
  await send(op("order.void", { id: gone.payload.order.id, expectedRevision: 1, reason: "Pelanggan pergi" }));
  await send(op("shift.close", { id: s3, counted: 35000 }));
  assert.deepEqual((await read("select variance::int as v from public.shifts where id=$1", [s3])).rows, [{ v: 0 }]);
});
await test("pull() hands every paired device what changed since its last pull, filtered by role", async () => {
  const later = () => new Promise((r) => setTimeout(r, 5));
  const before = (await db.query("select now() as t")).rows[0].t;
  await later();
  const s4 = randomUUID();
  await send(op("shift.open", { id: s4, opening: 50000 }));
  const t2 = ticket(); t2.payload.order.shiftId = s4;
  await send(t2);
  await send(op("stock.record", { stockId: "rice", kind: "waste", qty: 2000, cost: 0, fromDrawer: false, reason: "basi" }));
  const pulled = (await db.query("select public.pull($1,$2) as p", [before, device])).rows[0].p;
  assert.deepEqual([pulled.orders.map((o) => o.id), pulled.shifts.map((s) => s.id), pulled.movements.map((m) => [m.stockId, m.qty, m.kind])], [[t2.payload.order.id], [s4], [["rice", -2000, "waste"]]]);
  assert.deepEqual(pulled.device, { mode: "pos", enrolled: true, primary: true });
  assert.equal(pulled.catalog, undefined);
  await later();
  const again = (await db.query("select public.pull($1,$2) as p", [pulled.now, device])).rows[0].p;
  assert.deepEqual([again.orders, again.shifts, again.movements], [[], [], []]);
  await later();
  await send(op("catalog.publish", { menu: [nasiV2, { ...latte, price: 31000, version: 2 }], stock: [] }));
  assert.ok((await db.query("select public.pull($1,$2) as p", [pulled.now, device])).rows[0].p.catalog.menu.length >= 2);
  await login(kitchen);
  const crew = (await db.query("select public.pull($1,$2) as p", [before, device])).rows[0].p;
  assert.deepEqual([crew.orders.map((o) => o.id), crew.shifts.map((s) => s.expected)], [[t2.payload.order.id], [null]]);
  await login(owner);
  await send(op("order.void", { id: t2.payload.order.id, expectedRevision: 1, reason: "uji" }));
  await send(op("shift.close", { id: s4, counted: 50000 }));
});
await test("A late Siap on a void order is accepted and changes nothing; a fresh sign-in never double counts", async () => {
  const s5 = randomUUID();
  await send(op("shift.open", { id: s5, opening: 0 }));
  const t3 = ticket(); t3.payload.order.shiftId = s5;
  await send(t3);
  await send(op("order.void", { id: t3.payload.order.id, expectedRevision: 1, reason: "uji" }));
  await send(opOn(station, "order.ready", { id: t3.payload.order.id, station: "kitchen" }));
  assert.equal((await snap(t3.payload.order.id)).snapshot.status, "void");
  await send(op("shift.close", { id: s5, counted: 0 }));
  await send(op("stock.record", { stockId: "egg", kind: "waste", qty: 500, cost: 0, fromDrawer: false, reason: "pecah" }));
  const boot = (await db.query("select public.bootstrap($1) as b", [device])).rows[0].b;
  const baseline = boot.movements.find((m) => m.stockId === "egg")?.qty ?? 0; // every egg movement may be younger than 10 s here
  const pulled = (await db.query("select public.pull($1,$2) as p", [new Date(Date.parse(boot.now) - 10000).toISOString(), device])).rows[0].p;
  assert.equal(baseline + pulled.movements.filter((m) => m.stockId === "egg").reduce((n, m) => n + m.qty, 0), await qty("egg"));
  assert.ok(pulled.movements.some((m) => m.stockId === "egg" && m.qty === -500));
});
await test("The cashier records waste and batches and submits a count; the manager approves it from the laptop", async () => {
  await login(cashier);
  await send(op("stock.record", { stockId: "egg", kind: "waste", qty: 100, cost: 0, fromDrawer: false, reason: "pecah" }));
  await send(op("production.record", { stockId: "sambal", qty: 1000, inputs: [{ stockId: "egg", qty: 100 }], note: "" }));
  const id = randomUUID(), eggs = await qty("egg");
  await send(op("count.submit", { id, area: "Kulkas bar", lines: [{ stockId: "egg", counted: eggs - 1000, reason: "" }] }));
  assert.deepEqual((await read("select status,approver from public.counts where id=$1", [id])).rows, [{ status: "submitted", approver: null }]);
  await assert.rejects(send(op("count.record", { id, area: "Kulkas bar", lines: [{ stockId: "egg", counted: eggs - 1000 }] })), /Manager approval required/);
  await login(owner);
  const pulled = (await db.query("select public.pull($1,$2) as p", [new Date(Date.now() - 60000).toISOString(), laptop])).rows[0].p;
  assert.ok(pulled.counts.some((c) => c.id === id && c.status === "submitted"));
  await send(opOn(laptop, "count.record", { id, area: "Kulkas bar", lines: [{ stockId: "egg", counted: eggs - 1000, reason: "hilang" }] }));
  assert.deepEqual((await read("select status,approver from public.counts where id=$1", [id])).rows, [{ status: "approved", approver: "Owner" }]);
  assert.equal(await qty("egg"), eggs - 1000);
});
await test("Three wrong PINs lock approvals for five minutes", async () => {
  for (let i = 0; i < 3; i++) assert.equal((await approve(owner, "000002", "void", tid)).error, "wrong-pin");
  assert.deepEqual(await approve(owner, "482915", "void", tid), { error: "locked" });
  await db.exec("reset role");
  await db.query("delete from public.approval_failures");
  await login(owner);
});
await test("The audit log names who did what, from which device, and who approved it", async () => {
  const rows = (await db.query("select public.audit_log($1,$2) as a", [new Date(Date.now() - 86400000).toISOString().slice(0, 10), new Date(Date.now() + 86400000).toISOString().slice(0, 10)])).rows[0].a;
  const count = rows.find((r) => r.kind === "count.record" && r.approvedBy === "Owner");
  assert.deepEqual([count.actorName, count.mode], ["Admin", "office"]);
  assert.ok(rows.some((r) => r.kind === "order.void" && r.actorName === "Owner"));
  assert.ok(rows.some((r) => r.kind === "stock.record" && r.actorName === "Dapur" && r.mode === "station"));
  await login(cashier);
  await assert.rejects(db.query("select public.audit_log('2026-01-01','2026-01-02')"), /Manager required/);
  await login(owner);
});
await test("A manager manages staff below the owner; the owner stays out of reach", async () => {
  await login(mgr);
  await db.query("select public.manage_staff($1,$2,$3)", [cashier, "barista", true]);
  await assert.rejects(db.query("select public.manage_staff($1,$2,$3)", [owner, "cashier", true]), /Owner required/);
  await assert.rejects(db.query("select public.manage_staff($1,$2,$3)", [cashier, "owner", true]), /Owner required/);
  await db.query("select public.manage_staff($1,$2,$3)", [cashier, "cashier", true]);
  await login(owner);
});
// Independent database restoration, never a live environment.
await db.exec("reset role");
const paymentsBefore = (await db.query("select count(*)::int n from public.payments")).rows[0].n;
const dump = await db.dumpDataDir();
const restored = new PGlite({ loadDataDir: dump, extensions: { pgcrypto } });
await test("Separate PostgreSQL restore retains IDs and receipts", async () => {
  const { rows } = await restored.query("select snapshot from public.orders where id=$1", [order.id]);
  assert.deepEqual(rows[0].snapshot, snapshot);
  assert.equal(
    (await restored.query("select count(*)::int n from public.payments"))
      .rows[0].n,
    paymentsBefore,
  );
});
// Generate table Row types from the migrated PostgreSQL schema (no credentials).
const columns = (
  await db.query(
    "select table_name,column_name,data_type,is_nullable from information_schema.columns where table_schema='public' order by table_name,ordinal_position",
  )
).rows;
let types =
  "// Generated by scripts/test-db.mjs from applied SQL migrations. Do not edit.\nexport type Json = string | number | boolean | null | { [key:string]: Json | undefined } | Json[]\nexport interface Database { public: { Tables: {\n";
for (const table of [...new Set(columns.map((c) => c.table_name))]) {
  types += `  ${table}: { Row: {\n`;
  for (const c of columns.filter((c) => c.table_name === table)) {
    const t =
      c.data_type === "jsonb"
        ? "Json"
        : ["integer", "bigint", "numeric"].includes(c.data_type)
          ? "number"
          : c.data_type === "boolean"
            ? "boolean"
            : "string";
    types += `    ${c.column_name}: ${t}${c.is_nullable === "YES" ? " | null" : ""}\n`;
  }
  types += "  }; Insert: never; Update: never; Relationships: [] }\n";
}
types +=
  "}; Views: Record<string, never>; Functions: { apply_operation: { Args: { operation: Json }; Returns: Json }; bootstrap: { Args: { device_id: string }; Returns: Json }; enroll_device: { Args: { device_id: string; mode?: string }; Returns: undefined }; pull: { Args: { since: string }; Returns: Json }; audit_log: { Args: { from_day: string; to_day: string }; Returns: Json }; manage_staff: { Args: { target: string; new_role: string; new_active: boolean }; Returns: undefined }; set_approval_pin: { Args: { pin: string }; Returns: undefined }; outlet_transfers: { Args: Record<string, never>; Returns: Json }; approve: { Args: { approver: string; pin: string; action: string; order_id?: string; amount?: number }; Returns: Json }; sales_report: { Args: { from_day: string; to_day: string }; Returns: Json } }; Enums: Record<string, never>; CompositeTypes: Record<string, never> } }\n";
await writeFile("src/lib/database.types.ts", types);
await restored.close();
await db.close();
console.log(
  `\n${passed} PostgreSQL integration checks passed. Auth JWT context emulated; Supabase hosted verification still required.`,
);
