// QA 2026-11-25, compat: what the web app deployed before this campaign (git HEAD) legitimately sends and the new SQL must keep accepting.
export default async ({ test, send, assert, randomUUID, menu, line, world }) => {
  await test("QA compat: a pager of 100 digits (Pos.tsx stores 'Pager ' + digits, 106 characters) is accepted; 107 is not", async () => {
    const w = await world("Compat Pager");
    await w.as(w.people.cashier);
    const shift = randomUUID(), bill = { subtotal: 25000, discount: 0, service: 0, tax: 0, total: 25000 };
    await send(w.op("shift.open", { id: shift, opening: 0 }));
    const ok = w.order(shift, [line(menu, 1, 25000)], bill);
    ok.payload.order.label = "Pager " + "1".repeat(100);
    await send(ok);
    const bad = w.order(shift, [line(menu, 1, 25000)], bill);
    bad.payload.order.label = "x".repeat(107);
    await assert.rejects(send(bad), /Invalid order/);
  });
};
