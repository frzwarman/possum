// QA 2026-11-25, cluster accounting: what accounting_data hands the books. Run by scripts/test-db.mjs.
export default async ({ db, test, send, assert, world }) => {
  const books = async () => (await db.query("select public.accounting_data(current_date-1,current_date+1) as b")).rows[0].b;

  await test("QA accounting STOK-1: a priced and an unpriced delivery of one bahan on one day stay two rows", async () => {
    const w = await world("Warung Buku");
    await w.as(w.people.owner);
    await send(w.op("stock.record", { stockId: "rice", kind: "purchase", qty: 1000, cost: 8000, reason: "Kiriman" }));
    await send(w.op("stock.record", { stockId: "rice", kind: "purchase", qty: 1000, cost: 0, reason: "Kiriman" }));
    await send(w.op("stock.record", { stockId: "rice", kind: "purchase", qty: 500, cost: 0, reason: "Kiriman" }));
    const rows = (await books()).moves.filter((m) => m.stockId === "rice" && m.kind === "purchase").sort((a, b) => a.cost - b.cost);
    assert.deepEqual(rows.map((m) => [m.qty, m.cost]), [[1500, 0], [1000, 8000]]);
  });

  await test("QA accounting STK-10: each production batch is its own rows with an id and a time", async () => {
    const w = await world("Warung Batch");
    await w.as(w.people.owner);
    const prep = (id, from, qty) => ({ id, name: id, unit: "g", threshold: 0, production: { inputs: [{ stockId: from, qty }], output: 1000 } });
    await send(w.op("catalog.publish", { menu: [], stock: [prep("bg", "rice", 1000), prep("sambal", "bg", 1000)] }));
    await send(w.op("stock.record", { stockId: "rice", kind: "purchase", qty: 10000, cost: 60000, reason: "Kiriman" }));
    const one = w.op("production.record", { stockId: "bg", qty: 500, inputs: [{ stockId: "rice", qty: 1000 }], note: "" });
    await send(one);
    const two = w.op("production.record", { stockId: "sambal", qty: 100, inputs: [{ stockId: "bg", qty: 300 }, { stockId: "rice", qty: 500 }], note: "" });
    await send(two);
    const made = (await books()).moves.filter((m) => m.kind === "production");
    assert.equal(made.length, 5);
    assert.deepEqual([...new Set(made.map((m) => m.batch))].sort(), [one.id, two.id].sort());
    assert.ok(made.every((m) => m.at && m.batch));
    // bg is made in one batch and used in the other: two rows (+500, -300), not one of +200.
    assert.deepEqual(made.filter((m) => m.stockId === "bg").map((m) => m.qty).sort((a, b) => a - b), [-300, 500]);
    // Other kinds carry no batch or time.
    assert.ok((await books()).moves.filter((m) => m.kind === "purchase").every((m) => !("batch" in m) && !("at" in m)));
  });
};
