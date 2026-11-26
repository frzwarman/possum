-- QA fixes 2026-11-25, discounts at the till (TILL-02, DSC-2, TILL-05). apply_operation (202611250001_qa_fixes.sql) now
-- keeps a manual discount's rule and the amount last approved on the order. Two re-save rules would turn down what the
-- web app deployed before this fix legitimately sends (a rupiah manual discount kept while lines come off, a 'needs PIN'
-- saved discount grown past its approval without a new one), so they wait behind this switch: supabase/pending/
-- discounts_strict.sql flips it once every till runs the new web app. A function, not a copy of apply_operation, so the
-- pending file cannot go stale as other fixes land there.
create or replace function public.discounts_strict() returns boolean language sql immutable set search_path='' as $$ select false $$;
revoke all on function public.discounts_strict() from public,anon,authenticated;
