// QA 2026-11-25, review of lane money: SQL-16 for order.save (an order with a huge extra field was stored and pushed to every
// device). Honest orders are far below the cap: 200 lines of a few KB each. Run by scripts/test-db.mjs.
export default async ({ test, send, assert, randomUUID, menu, line, world }) => {
  const bill = { subtotal: 25000, discount: 0, service: 0, tax: 0, total: 25000 };
  await test("QA money review SQL-16: order.save refuses an order carrying megabytes of extra keys, and takes an honest one", async () => {
    const w = await world("Warung Besar");
    await w.as(w.people.cashier);
    const shift = randomUUID();
    await send(w.op("shift.open", { id: shift, opening: 0 }));
    const fat = w.order(shift, [line(menu, 1, 25000)], bill);
    fat.payload.order.junk = "x".repeat(5_000_000);
    await assert.rejects(send(fat), /Invalid order/);
    await send(w.order(shift, [line(menu, 1, 25000)], bill));
  });
};
