-- D3/D4: a refund may be part of the order (payload amount, optional lines). One refund per order stays (refunds primary
-- key); a partial one leaves the order 'paid' with snapshot.refund.amount, a full one is 'refunded' as before. The cash
-- the drawer should hold, and what each EDC settles, drop by the partial amount. apply_operation is patched in place, so any later change to it
-- by another migration is kept. Also: a partial refund's manager approval is bound to its amount (a cashier cannot
-- reuse a small approval for a bigger refund), a refund's reason and lines are bounded, and a shift closed with a gap
-- over the limit must carry its note (the till already asks; deploy the app first, then this migration).
do $m$
declare d text;n text;n2 text;
begin
 d:=pg_get_functiondef('public.apply_operation(jsonb)'::regprocedure);n:=d;
 n2:=replace(n,
  $a$if o.status<>'paid' or length(trim(p->>'reason'))=0 then raise exception 'Invalid refund';end if;$a$,
  $b$if o.status<>'paid' or o.snapshot ? 'refund' or length(trim(p->>'reason'))=0 or (p ? 'amount' and ((p->>'amount')::bigint<1 or (p->>'amount')::bigint>(o.snapshot->'totals'->>'total')::bigint)) or length(p->>'reason')>300 or (p ? 'lines' and (jsonb_typeof(p->'lines')<>'array' or jsonb_array_length(p->'lines')>100)) then raise exception 'Invalid refund';end if;$b$);if n2=n then raise exception 'apply_operation changed: partial refund patch step 1 does not apply';end if;n:=n2;
 n2:=replace(n,
  $a$insert into public.refunds values(rid,oid,opid,(o.snapshot->'totals'->>'total')::bigint,p->>'reason',actor,at,now());$a$,
  $b$insert into public.refunds values(rid,oid,opid,coalesce((p->>'amount')::bigint,(o.snapshot->'totals'->>'total')::bigint),p->>'reason',actor,at,now());$b$);if n2=n then raise exception 'apply_operation changed: partial refund patch step 2 does not apply';end if;n:=n2;
 n2:=replace(n,
  $a$doc:=o.snapshot||jsonb_build_object('status','refunded','refund',jsonb_build_object('reason',p->>'reason','at',operation->>'occurredAt','actor',actor,'approvedBy',approver));$a$,
  $b$doc:=o.snapshot||jsonb_build_object('status',case when coalesce((p->>'amount')::bigint,(o.snapshot->'totals'->>'total')::bigint)>=(o.snapshot->'totals'->>'total')::bigint then 'refunded' else 'paid' end,'refund',jsonb_strip_nulls(jsonb_build_object('reason',p->>'reason','at',operation->>'occurredAt','actor',actor,'approvedBy',approver,'amount',coalesce((p->>'amount')::bigint,(o.snapshot->'totals'->>'total')::bigint),'method',o.snapshot->'payment'->>'method','lines',p->'lines')));$b$);if n2=n then raise exception 'apply_operation changed: partial refund patch step 3 does not apply';end if;n:=n2;
 n2:=replace(n,
  $a$select s.opening+coalesce((select sum((ord.snapshot->'totals'->>'total')::bigint) from public.payments pay$a$,
  $b$select s.opening+coalesce((select sum((ord.snapshot->'totals'->>'total')::bigint-coalesce((ord.snapshot->'refund'->>'amount')::bigint,0)) from public.payments pay$b$);if n2=n then raise exception 'apply_operation changed: partial refund patch step 4 does not apply';end if;n:=n2;
 n2:=replace(n,
  $a$sum((ord.snapshot->'totals'->>'total')::bigint) as expected from public.orders ord$a$,
  $b$sum((ord.snapshot->'totals'->>'total')::bigint-coalesce((ord.snapshot->'refund'->>'amount')::bigint,0)) as expected from public.orders ord$b$);if n2=n then raise exception 'apply_operation changed: partial refund patch step 5 does not apply';end if;n:=n2;
 n2:=replace(n,
  $a$public.use_approval(rid,actor,'refund',oid,null,opid,at,(p->>'approval')::uuid)$a$,
  $b$public.use_approval(rid,actor,'refund',oid,(p->>'amount')::bigint,opid,at,(p->>'approval')::uuid)$b$);if n2=n then raise exception 'apply_operation changed: partial refund patch step 6 does not apply';end if;n:=n2;
 n2:=replace(n,
  $a$approver:=case when role in ('owner','manager') then null when qty>coalesce((restaurant.settings->>'varianceLimit')::bigint,10000) then$a$,
  $b$if qty>coalesce((restaurant.settings->>'varianceLimit')::bigint,10000) and (jsonb_typeof(p->'note') is distinct from 'string' or length(trim(p->>'note')) not between 1 and 200) then raise exception 'Variance note required';end if;
 approver:=case when role in ('owner','manager') then null when qty>coalesce((restaurant.settings->>'varianceLimit')::bigint,10000) then$b$);if n2=n then raise exception 'apply_operation changed: partial refund patch step 7 does not apply';end if;n:=n2;
 execute n;
end $m$;
