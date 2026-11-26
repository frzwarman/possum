-- Ready to apply (not a migration) once every till runs the web app deployed with the 2026-11-25 QA fixes, i.e. after
-- the PWA update prompt has been accepted on each device and no order.void or order.voidline from the older app is still queued.
-- The older app asks a manager's approval for a line void and for a whole-order void as action 'void' with no amount, which
-- binds only the order: an approval given for one line then voids any other line or the whole order (SEC-1).
-- From then on order.voidline accepts only an approval of action 'voidline' (order, line, the line's value) and order.void only
-- a 'void' approval for the order's total. The new web app asks that way, by PIN and by Telegram, so no honest till is refused.
-- Checked by scripts/db-checks/qa-voids.mjs.
create or replace function public.voids_strict() returns boolean language sql immutable set search_path='' as $$ select true $$;
