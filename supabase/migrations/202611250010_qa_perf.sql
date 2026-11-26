-- QA 2026-11-25, cluster perf (SQL-12): indexes only, nothing changes behaviour.
-- (sync_operations(restaurant_id, occurred_at) for audit_log is created in 202611250008_qa_reports.sql.)
-- catalog.remove asks whether an item was ever sold: order_lines had no index on item_id, so it read every line.
create index if not exists order_lines_item on public.order_lines(restaurant_id,item_id);
-- accounting_rows sums movements per day: it read the restaurant's whole history through stock_balance_lookup.
create index if not exists stock_movements_occurred on public.stock_movements(restaurant_id,occurred_at);
