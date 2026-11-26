-- Ready to apply (not a migration) once every till runs the web app deployed with the 2026-11-25 QA fixes, i.e. after
-- the PWA update prompt has been accepted on each device and no order.save from the older app is still queued.
-- From then on order.save (202611250001_qa_fixes.sql) also refuses, without a new manager approval:
--  - a manual discount kept unchanged while the order's subtotal fell below the last saved one;
--  - a 'needs PIN' saved discount re-priced above the amount last approved on the order.
-- The new web app asks for the PIN again in both cases, so no honest till is refused. Checked by scripts/db-checks/qa-discounts.mjs.
-- REVIEW 2026-11-26: also apply it only when no OPEN order still holds a manual discount saved without a rule (by the older web app):
-- the new till carries that discount over unchanged when lines come off and sends no approval, which the first rule above would refuse.
-- Check with: select count(*) from public.orders where status='open' and (snapshot->>'discount')::bigint>0 and not (snapshot ? 'discountId') and not (snapshot ? 'discountRule') and snapshot->>'mode'<>'compliment'.
create or replace function public.discounts_strict() returns boolean language sql immutable set search_path='' as $$ select true $$;
