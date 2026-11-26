// QA 2026-11-25, cluster perf (SQL-12): the indexes the slow paths need exist and the planner uses them. Run by scripts/test-db.mjs.
export default async ({ db, test, assert }) => {
  await test("QA perf SQL-12: order_lines(item) and stock_movements(occurred_at) are indexed for catalog.remove and the accounting sums", async () => {
    const have = (await db.query("select indexname from pg_indexes where schemaname='public' and indexname in ('order_lines_item','stock_movements_occurred','sync_operations_occurred')")).rows.map((r) => r.indexname).sort();
    assert.deepEqual(have, ["order_lines_item", "stock_movements_occurred", "sync_operations_occurred"]);
    for (const [sql, index] of [["select 1 from public.order_lines where restaurant_id=$1 and item_id='x'", "order_lines_item"], ["select 1 from public.stock_movements where restaurant_id=$1 and occurred_at>=now()-interval '1 day'", "stock_movements_occurred"]]) {
      await db.query("set enable_seqscan=off");
      const plan = (await db.query("explain " + sql, ["00000000-0000-0000-0000-000000000001"])).rows.map((r) => r["QUERY PLAN"]).join("\n");
      await db.query("reset enable_seqscan");
      assert.match(plan, new RegExp(index), plan);
    }
  });
};
