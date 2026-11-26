// QA 2026-11-25, cluster station: a bump marks ready only what the station showed (STN-03). Run by scripts/test-db.mjs.
export default async ({ read, test, send, assert, randomUUID, menu, line, world }) => {
  async function twoRounds() {
    const w = await world("Warung Stasiun");
    await w.as(w.people.cashier);
    const shift = randomUUID();
    const open = w.op("shift.open", { id: shift, opening: 0 });open.occurredAt = new Date(Date.now() - 120000).toISOString();
    await send(open);
    const a = line(menu, 1, 25000), b = line(menu, 1, 25000);
    const o = w.order(shift, [a, b], { subtotal: 50000, discount: 0, service: 0, tax: 0, total: 50000 }), id = o.payload.order.id;
    await send(o);
    const at = (s) => new Date(Date.now() + s * 1000).toISOString();
    const first = w.op("order.prepare", { id, expectedRevision: 1, lineIds: [a.id] });first.occurredAt = at(-60);
    await send(first);
    const second = w.op("order.prepare", { id, expectedRevision: 2, lineIds: [b.id] });second.occurredAt = at(0);
    await send(second);
    await w.as(w.people.kitchen);
    const stored = async () => (await read("select snapshot from public.orders where id=$1", [id])).rows[0].snapshot.lines.map((l) => [l.id, Boolean(l.readyAt)]);
    return { w, id, a, b, at, stored };
  }
  await test("QA station STN-03: a bump that names its lines marks those only", async () => {
    const { w, id, a, b, stored } = await twoRounds();
    await send(w.op("order.ready", { id, station: "kitchen", lines: [a.id] }));
    assert.deepEqual(await stored(), [[a.id, true], [b.id, false]]);
  });
  await test("QA station STN-03: the old form (no lines) marks only lines prepared at or before the bump", async () => {
    const { w, id, a, b, at, stored } = await twoRounds();
    const bump = w.op("order.ready", { id, station: "kitchen" });bump.occurredAt = at(-30);
    await send(bump);
    assert.deepEqual(await stored(), [[a.id, true], [b.id, false]]);
  });
  await test("QA station STN-03: lines must be a list of ids", async () => {
    const { w, id } = await twoRounds();
    await assert.rejects(send(w.op("order.ready", { id, station: "kitchen", lines: "all" })), /Invalid ready lines/);
    await assert.rejects(send(w.op("order.ready", { id, station: "kitchen", lines: [1] })), /Invalid ready lines/);
  });
};
