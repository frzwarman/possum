import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const db = new PGlite();
let passed = 0;
await db.exec(
  `create schema auth;create role anon;create role authenticated;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`,
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
  const { rows } = await db.query("select * from public.order_lines");
  assert.equal(rows.length, 1);
});
await test("Duplicate operation replay returns same receipt", async () => {
  const a = await send(orderOp),
    b = await send(orderOp);
  assert.deepEqual(a.rows, b.rows);
  assert.equal(
    (await db.query("select count(*)::int as n from public.orders")).rows[0].n,
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
    (await db.query("select count(*)::int as n from public.orders")).rows[0].n,
    1,
  );
});
await test("Server rejects client price tampering", async () => {
  const bad = makeOrder();
  bad.payload.order.lines[0].price = 1;
  await assert.rejects(send(bad), /Catalog snapshot mismatch/);
});
await test("Cashier discount escalation is denied", async () => {
  const bad = makeOrder();
  bad.payload.order.discount = 1000;
  bad.payload.order.discountReason = "test";
  await assert.rejects(send(bad), /Discount requires manager/);
});
const prep = op("order.prepare", {
  id: order.id,
  expectedRevision: 1,
  lineIds: order.lines.map((l) => l.id),
});
await test("Preparation consumes recipe plus modifiers once", async () => {
  await send(prep);
  await send(prep);
  const { rows } = await db.query(
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
    (await db.query("select count(*)::int as n from public.payments")).rows[0]
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
    (await db.query("select count(*)::int as n from public.payments")).rows[0]
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
await test("Cashier refund is denied", async () => {
  await assert.rejects(
    send(
      op("refund.record", { id: order.id, expectedRevision: 3, reason: "uji" }),
    ),
    /Manager permission/,
  );
});
const snapshot = (await db.query("select snapshot from public.orders")).rows[0]
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
await test("Shift closes with expected cash derived from payments", async () => {
  await send(op("shift.close", { id: shift, counted: 230000 }));
  const { rows } = await db.query(
    "select expected::int,variance::int from public.shifts",
  );
  assert.deepEqual(rows, [{ expected: 230000, variance: 0 }]);
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
// Independent database restoration, never a live environment.
await db.exec("reset role");
const dump = await db.dumpDataDir();
const restored = new PGlite({ loadDataDir: dump });
await test("Separate PostgreSQL restore retains IDs and receipts", async () => {
  const { rows } = await restored.query("select snapshot from public.orders");
  assert.deepEqual(rows[0].snapshot, snapshot);
  assert.equal(
    (await restored.query("select count(*)::int n from public.payments"))
      .rows[0].n,
    1,
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
  "}; Views: Record<string, never>; Functions: { apply_operation: { Args: { operation: Json }; Returns: Json }; bootstrap: { Args: { device_id: string }; Returns: Json }; enroll_device: { Args: { device_id: string }; Returns: undefined }; manage_staff: { Args: { target: string; new_role: string; new_active: boolean }; Returns: undefined }; sales_report: { Args: { from_day: string; to_day: string }; Returns: Json } }; Enums: Record<string, never>; CompositeTypes: Record<string, never> } }\n";
await writeFile("src/lib/database.types.ts", types);
await restored.close();
await db.close();
console.log(
  `\n${passed} PostgreSQL integration checks passed. Auth JWT context emulated; Supabase hosted verification still required.`,
);
