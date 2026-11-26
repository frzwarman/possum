// QA 2026-11-25, cluster outbox: what a device sends (size). Run by scripts/test-db.mjs.
export default async ({ test, send, assert, randomUUID, world }) => {
  await test("QA outbox SQL-16: an operation above 64 MiB is refused (P0001), a large honest one (3 MB of photos) is not", async () => {
    const w = await world("Warung Besar");
    await w.as(w.people.manager);
    const shift = randomUUID();
    await send(w.op("shift.open", { id: shift, opening: 100000 }));
    // 5 MB of free text under an unknown key rides along: the server ignores it, the size cap does not.
    await send(w.op("shift.cash", { shiftId: shift, amount: 1000, reason: "uji", extra: "x".repeat(3_000_000) }));
    await assert.rejects(send(w.op("shift.cash", { shiftId: shift, amount: 1000, reason: "uji", extra: "x".repeat(70_000_000) })), (e) => e.code === "P0001" && /Operation too large/.test(e.message));
  });
};
