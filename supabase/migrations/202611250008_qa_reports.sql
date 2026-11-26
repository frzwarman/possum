-- QA 2026-11-25, cluster reports. Each function is re-created from its latest definition and changed only where a finding
-- needs it; CREATE OR REPLACE keeps every grant and revoke as it was (audit_log changes its signature, so its grants are repeated).
--
-- sales_summary (latest in 202611170001), CT-07: best sellers leave out complimentary items, as sales and transactions already do
-- (compliments are not sales anywhere). "sales" stays gross, a refund listed apart ("refunds"): the one definition of Penjualan
-- the till screens now share (STN-12, RPT-6). sales_report and telegram_report only call it and are unchanged.
create or replace function public.sales_summary(rid uuid,from_day date,to_day date) returns jsonb language plpgsql set search_path='' as $$
declare config jsonb;tz text;cut integer;start_at timestamptz;end_at timestamptz;begin
 select settings into config from public.restaurants where id=rid;tz:=config->>'timezone';cut:=(config->>'cutoff')::int;
 start_at:=(from_day::timestamp+make_interval(hours=>cut)) at time zone tz;end_at:=((to_day+1)::timestamp+make_interval(hours=>cut)) at time zone tz;
 return (with paid as (select p.method,p.edc,o.id,o.snapshot,(o.snapshot->'totals'->>'total')::bigint as total,o.snapshot->>'mode'='compliment' as comp from public.payments p join public.orders o on o.restaurant_id=p.restaurant_id and o.id=p.order_id where p.restaurant_id=rid and p.occurred_at>=start_at and p.occurred_at<end_at)
 select jsonb_build_object('from',from_day,'to',to_day,'asOf',now(),
 'sales',(select coalesce(sum(total),0) from paid where not comp),
 'transactions',(select count(*) from paid where not comp),
 'refunds',(select coalesce(sum(amount),0) from public.refunds where restaurant_id=rid and occurred_at>=start_at and occurred_at<end_at),
 'discounts',(select coalesce(sum((snapshot->>'discount')::bigint),0) from paid where not comp),
 'compliments',(select coalesce(sum((snapshot->>'discount')::bigint),0) from paid where comp),
 'outstanding',(select coalesce(sum((snapshot->'totals'->>'total')::bigint),0) from public.orders where restaurant_id=rid and status='open' and created_at>=start_at and created_at<end_at),
 'methods',(select coalesce(jsonb_object_agg(method,total),'{}') from (select method,sum(total) as total from paid group by method) x),
 'edcs',(select coalesce(jsonb_object_agg(edc,total),'{}') from (select edc,sum(total) as total from paid where edc is not null group by edc) x),
 'bestSellers',(select coalesce(jsonb_agg(x),'[]') from (select l.snapshot->>'name' as name,sum((l.snapshot->>'qty')::bigint) as quantity from public.order_lines l join paid on paid.id=l.order_id where l.restaurant_id=rid and not paid.comp and not coalesce((l.snapshot->>'cancelled')::boolean,false) group by l.snapshot->>'name' order by quantity desc limit 10) x)));
end $$;

-- SQL-07, RPT-9: what the owner could not read before. Role changes, device pairing and cash-book removals changed a row in
-- place and left no trace, so a trigger on each writes one row here, as the person who made the call. Nobody reads this table
-- directly (no grant, no policy); audit_log lists it. occurred_at is kept to the millisecond, as audit_log's cursor is.
create table public.audit_events(
 id uuid primary key default gen_random_uuid(),restaurant_id uuid not null references public.restaurants(id),kind text not null,
 occurred_at timestamptz not null default date_trunc('milliseconds',now()),actor uuid,payload jsonb not null default '{}');
create index audit_events_day on public.audit_events(restaurant_id,occurred_at);
alter table public.audit_events enable row level security;
revoke all on public.audit_events from anon,authenticated;
create function public.audit_membership() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.role is distinct from new.role or old.active is distinct from new.active then
  insert into public.audit_events(restaurant_id,kind,actor,payload) values(new.restaurant_id,'staff.change',auth.uid(),jsonb_build_object('target',new.user_id,'name',new.name,'from',old.role,'to',new.role,'wasActive',old.active,'active',new.active));
 end if;
 return null;
end $$;
create trigger audit_membership after update on public.memberships for each row execute function public.audit_membership();
create function public.audit_device() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' or old.revoked_at is distinct from new.revoked_at or old.mode is distinct from new.mode then
  insert into public.audit_events(restaurant_id,kind,actor,payload) values(new.restaurant_id,case when new.revoked_at is not null then 'device.revoke' else 'device.enroll' end,auth.uid(),jsonb_build_object('device',new.id,'mode',new.mode));
 end if;
 return null;
end $$;
create trigger audit_device after insert or update of revoked_at,mode on public.devices for each row execute function public.audit_device();
create function public.audit_ledger() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.removed_at is null and new.removed_at is not null then
  insert into public.audit_events(restaurant_id,kind,actor,payload) values(new.restaurant_id,'ledger.remove',auth.uid(),jsonb_build_object('entry',new.id,'day',new.day,'entryKind',new.kind,'amount',new.amount,'note',new.note));
 end if;
 return null;
end $$;
create trigger audit_ledger after update of removed_at on public.ledger_entries for each row execute function public.audit_ledger();
revoke all on function public.audit_membership(),public.audit_device(),public.audit_ledger() from public,anon,authenticated;
-- audit_log would otherwise scan every operation of the restaurant by received_at to find a range of occurred_at.
create index sync_operations_occurred on public.sync_operations(restaurant_id,occurred_at);

-- audit_log (latest in 202611200001), RPT-5, SQL-06, RPT-9, RPT-10, SQL-07, F9. The result is still the array older web apps
-- read. New: after_at/after_id, the cursor (the "at" and "id" of the last entry of the page before) and page (up to 1000, the
-- most a call returns): a caller asks again until a page is short, so nothing is dropped silently. An old caller sends two
-- arguments and gets the newest 1000 as before. A new parameter is a new signature, so the old one goes.
-- Also: more kinds (drawer cash in purchases and catering, stock transfers, production, shift open, staff, devices, cash-book
-- removals); an order saved again with the discount it already had is not a second entry (the till saves at "Ke stasiun" and
-- again at "Bayar"); menu and ingredient photos stay out of catalog.publish payloads (one publish carried the whole catalog).
drop function public.audit_log(date,date);
create function public.audit_log(from_day date,to_day date,after_at timestamptz default null,after_id uuid default null,page integer default 1000) returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid;config jsonb;tz text;cut integer;start_at timestamptz;end_at timestamptz;n integer:=least(greatest(coalesce(page,1000),1),1000);begin
 select restaurant_id into rid from public.memberships where user_id=auth.uid() and active and role in ('owner','manager','accountant');
 if rid is null then raise exception 'Manager or accountant required' using errcode='42501';end if;
 if to_day<from_day or to_day-from_day>93 then raise exception 'Audit range limited to 94 days';end if;
 select settings into config from public.restaurants where id=rid;tz:=config->>'timezone';cut:=(config->>'cutoff')::int;
 start_at:=(from_day::timestamp+make_interval(hours=>cut)) at time zone tz;end_at:=((to_day+1)::timestamp+make_interval(hours=>cut)) at time zone tz;
 return (with saves as (
   select so.id,coalesce((so.payload->'payload'->'order'->>'discount')::bigint,0) as disc,coalesce(so.payload->'payload'->'order'->>'discountReason','') as why,
    lag(coalesce((so.payload->'payload'->'order'->>'discount')::bigint,0)) over w as was,lag(coalesce(so.payload->'payload'->'order'->>'discountReason','')) over w as was_why
   from public.sync_operations so where so.restaurant_id=rid and so.kind='order.save' and so.occurred_at>=start_at-interval '2 days' and so.occurred_at<end_at
   window w as (partition by so.payload->'payload'->'order'->>'id' order by so.occurred_at,so.id))
  select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'kind',x.kind,'at',public.iso(x.occurred_at),'actor',x.actor,'actorName',x.name,'role',x.role,'device',x.device_id,'mode',x.mode,'approvedBy',x.approved_by,'payload',x.payload) order by x.occurred_at desc,x.id desc),'[]') from (
  select * from (
   select so.id,so.kind,so.occurred_at,so.actor,m.name,m.role,so.device_id,d.mode,
   case when so.kind='catalog.publish' then jsonb_set(jsonb_set((so.payload->'payload')-'photo','{menu}',coalesce((select jsonb_agg(e-'photo') from jsonb_array_elements(case when jsonb_typeof(so.payload->'payload'->'menu')='array' then so.payload->'payload'->'menu' else '[]'::jsonb end) e),'[]'::jsonb),false),'{stock}',coalesce((select jsonb_agg(e-'photo') from jsonb_array_elements(case when jsonb_typeof(so.payload->'payload'->'stock')='array' then so.payload->'payload'->'stock' else '[]'::jsonb end) e),'[]'::jsonb),false)
    else (so.payload->'payload')-'photo' end as payload,
   (select am.name from public.approvals a join public.memberships am on am.restaurant_id=a.restaurant_id and am.user_id=a.approver where a.restaurant_id=rid and a.operation_id=so.id) as approved_by
   from public.sync_operations so join public.memberships m on m.restaurant_id=so.restaurant_id and m.user_id=so.actor left join public.devices d on d.restaurant_id=so.restaurant_id and d.id=so.device_id left join saves s on s.id=so.id
   where so.restaurant_id=rid and so.occurred_at>=start_at and so.occurred_at<end_at
   and (so.kind in ('order.void','order.voidline','refund.record','catalog.remove','shift.cash','shift.open','stock.record','count.record','catalog.publish','settings.update','shift.close','transfer.send','production.record')
    or (so.kind in ('purchase.receive','purchase.pay','salesorder.pay','salesorder.cancel') and so.payload->'payload'->>'payment'='drawer')
    or (so.kind='order.save' and s.disc>0 and (s.was is null or s.was<>s.disc or s.was_why<>s.why)))
   union all
   select e.id,e.kind,e.occurred_at,e.actor,coalesce(m.name,'Sistem'),m.role,null::uuid,null::text,e.payload,null::text
   from public.audit_events e left join public.memberships m on m.restaurant_id=e.restaurant_id and m.user_id=e.actor
   where e.restaurant_id=rid and e.occurred_at>=start_at and e.occurred_at<end_at
  ) y where after_at is null or (y.occurred_at,y.id)<(after_at,after_id)
  order by y.occurred_at desc,y.id desc limit n) x);
end $$;
revoke all on function public.audit_log(date,date,timestamptz,uuid,integer) from public,anon;
grant execute on function public.audit_log(date,date,timestamptz,uuid,integer) to authenticated;
