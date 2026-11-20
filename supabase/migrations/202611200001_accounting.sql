-- Accounting: an accountant role, the books for a range of business days, and a cash book.
--
-- A device holds its newest 500 orders and the stock movements since it signed in. That is enough to run a shift and
-- not enough to close a month, so the Akuntansi page asks the server for the range, complete: the orders paid or
-- refunded in it (trimmed to what the ledger reads), stock movements summed per business day, ingredient and kind,
-- the stock on hand when the range starts, the shifts closed and opened and drawer cash moved in it, and the purchase
-- and catering orders. The page works the reports, the journal, the ledger and the balance sheet out of that
-- (src/domain/accounting.ts), carrying balances and average stock cost forward month by month.
--
-- The cash book is money that never passes the till: rent, salaries, a tax payment, the owner's capital. Entries are
-- written and taken back only through ledger_save and ledger_remove; a removed entry stays in the table with who
-- removed it and when.
--
-- The accountant reads the books and the audit log and writes the cash book, and can do nothing else: apply_operation
-- allows a role by name, so a role it does not name sends no operation, and pull and bootstrap already give a
-- non-office role only the catalog and open orders.
alter table public.memberships drop constraint memberships_role_check;
alter table public.memberships add constraint memberships_role_check check(role in ('owner','manager','admin','chef','cashier','barista','kitchen','accountant'));
create or replace function public.manage_staff(target uuid,new_role text,new_active boolean) returns void language plpgsql security definer set search_path='' as $$
declare rid uuid;me text;was text;begin
 select restaurant_id,role into rid,me from public.memberships where user_id=auth.uid() and active and role in ('owner','manager');
 if rid is null then raise exception 'Owner required' using errcode='42501';end if;
 if target=auth.uid() then raise exception 'Owner cannot change their own access' using errcode='42501';end if;
 if new_role not in ('owner','manager','admin','chef','cashier','barista','kitchen','accountant') or new_active is null then raise exception 'Invalid staff role or access';end if;
 select role into was from public.memberships where restaurant_id=rid and user_id=target;
 if was is null then raise exception 'Staff not found in this restaurant';end if;
 if me<>'owner' and (was='owner' or new_role='owner') then raise exception 'Owner required' using errcode='42501';end if;
 update public.memberships set role=new_role,active=new_active where restaurant_id=rid and user_id=target;
end $$;
create or replace function public.audit_log(from_day date,to_day date) returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid;config jsonb;tz text;cut integer;start_at timestamptz;end_at timestamptz;begin
 select restaurant_id into rid from public.memberships where user_id=auth.uid() and active and role in ('owner','manager','accountant');
 if rid is null then raise exception 'Manager or accountant required' using errcode='42501';end if;
 if to_day<from_day or to_day-from_day>93 then raise exception 'Audit range limited to 94 days';end if;
 select settings into config from public.restaurants where id=rid;tz:=config->>'timezone';cut:=(config->>'cutoff')::int;
 start_at:=(from_day::timestamp+make_interval(hours=>cut)) at time zone tz;end_at:=((to_day+1)::timestamp+make_interval(hours=>cut)) at time zone tz;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'kind',x.kind,'at',public.iso(x.occurred_at),'actor',x.actor,'actorName',x.name,'role',x.role,'device',x.device_id,'mode',x.mode,'approvedBy',x.approved_by,'payload',x.payload) order by x.occurred_at desc),'[]') from (
  select so.id,so.kind,so.occurred_at,so.actor,m.name,m.role,so.device_id,d.mode,(so.payload->'payload')-'photo' as payload,
  (select am.name from public.approvals a join public.memberships am on am.restaurant_id=a.restaurant_id and am.user_id=a.approver where a.restaurant_id=rid and a.operation_id=so.id) as approved_by
  from public.sync_operations so join public.memberships m on m.restaurant_id=so.restaurant_id and m.user_id=so.actor left join public.devices d on d.restaurant_id=so.restaurant_id and d.id=so.device_id
  where so.restaurant_id=rid and so.occurred_at>=start_at and so.occurred_at<end_at
  and (so.kind in ('order.void','order.voidline','refund.record','catalog.remove','shift.cash','stock.record','count.record','catalog.publish','settings.update','shift.close') or (so.kind='order.save' and coalesce((so.payload->'payload'->'order'->>'discount')::bigint,0)>0))
  order by so.occurred_at desc limit 1000) x);
end $$;
create table public.ledger_entries(
 restaurant_id uuid not null references public.restaurants(id),id uuid not null,day date not null,
 kind text not null check(kind in ('rent','payroll','utilities','telecom','supplies','repairs','marketing','bankFees','otherExpense','taxPaid','servicePaid','capital','draw')),
 amount bigint not null check(amount between 1 and 100000000000),note text not null default '' check(length(note)<=200),
 actor uuid not null,created_at timestamptz not null default now(),removed_at timestamptz,removed_by uuid,
 primary key(restaurant_id,id),foreign key(restaurant_id,actor) references public.memberships(restaurant_id,user_id)
);
alter table public.ledger_entries enable row level security;
revoke all on public.ledger_entries from anon,authenticated;
create function public.ledger_save(entry jsonb) returns void language plpgsql security definer set search_path='' as $$
declare rid uuid;tz text;begin
 select restaurant_id into rid from public.memberships where user_id=auth.uid() and active and role in ('owner','manager','accountant');
 if rid is null then raise exception 'Manager or accountant required' using errcode='42501';end if;
 select settings->>'timezone' into tz from public.restaurants where id=rid;
 if (entry->>'day')::date>(now() at time zone tz)::date then raise exception 'Entry date is in the future';end if;
 -- Sent twice (a retry after a lost answer), the same entry is written once.
 insert into public.ledger_entries(restaurant_id,id,day,kind,amount,note,actor) values(rid,(entry->>'id')::uuid,(entry->>'day')::date,entry->>'kind',(entry->>'amount')::bigint,coalesce(trim(entry->>'note'),''),auth.uid()) on conflict do nothing;
end $$;
create function public.ledger_remove(entry_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare rid uuid;begin
 select restaurant_id into rid from public.memberships where user_id=auth.uid() and active and role in ('owner','manager','accountant');
 if rid is null then raise exception 'Manager or accountant required' using errcode='42501';end if;
 update public.ledger_entries set removed_at=now(),removed_by=auth.uid() where restaurant_id=rid and id=entry_id and removed_at is null;
 if not found then raise exception 'Entry not found';end if;
end $$;
revoke all on function public.ledger_save(jsonb),public.ledger_remove(uuid) from public,anon;
grant execute on function public.ledger_save(jsonb),public.ledger_remove(uuid) to authenticated;
create function public.accounting_rows(rid uuid,from_day date,to_day date) returns jsonb language plpgsql stable set search_path='' as $$
declare config jsonb;tz text;cut integer;start_at timestamptz;end_at timestamptz;begin
 select settings into config from public.restaurants where id=rid;tz:=config->>'timezone';cut:=(config->>'cutoff')::int;
 start_at:=(from_day::timestamp+make_interval(hours=>cut)) at time zone tz;end_at:=((to_day+1)::timestamp+make_interval(hours=>cut)) at time zone tz;
 return jsonb_build_object('asOf',public.iso(now()),
 'orders',(select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'receiptId',o.snapshot->'receiptId','mode',o.snapshot->'mode','status',o.status,'cashier',o.snapshot->'cashier','totals',o.snapshot->'totals','createdAt',o.snapshot->'createdAt',
   'lines',(select coalesce(jsonb_agg(jsonb_build_object('itemId',l.value->'itemId','name',l.value->'name','qty',l.value->'qty','price',l.value->'price','cancelled',coalesce((l.value->>'cancelled')::boolean,false),'recipe',coalesce(l.value->'recipe','[]'::jsonb),
    'modifiers',(select coalesce(jsonb_agg(jsonb_build_object('price',x.value->'price','recipe',coalesce(x.value->'recipe','[]'::jsonb))),'[]'::jsonb) from jsonb_array_elements(coalesce(l.value->'modifiers','[]'::jsonb)) x))),'[]'::jsonb) from jsonb_array_elements(o.snapshot->'lines') l))
   ||jsonb_strip_nulls(jsonb_build_object('payment',o.snapshot->'payment','refund',o.snapshot->'refund'))),'[]'::jsonb)
  from public.orders o where o.restaurant_id=rid and (
   exists(select 1 from public.payments p where p.restaurant_id=rid and p.order_id=o.id and p.occurred_at>=start_at and p.occurred_at<end_at)
   or exists(select 1 from public.refunds f where f.restaurant_id=rid and f.order_id=o.id and f.occurred_at>=start_at and f.occurred_at<end_at))),
 -- comp: stock that left for a compliment (a staff meal, the owner's family) is an expense, not cost of sales.
 'moves',(select coalesce(jsonb_agg(jsonb_build_object('day',x.d,'stockId',x.stock_id,'kind',x.kind,'comp',x.comp,'qty',x.qty,'cost',x.cost)),'[]'::jsonb) from (
   select to_char(((m.occurred_at at time zone tz)-make_interval(hours=>cut))::date,'YYYY-MM-DD') as d,m.stock_id,m.kind,
    (m.kind='preparation' and m.record_id in (select c.id::text from public.orders c where c.restaurant_id=rid and c.snapshot->>'mode'='compliment')) as comp,
    sum(m.qty) as qty,sum(case when m.qty<0 then -m.cost else m.cost end) as cost
   from public.stock_movements m where m.restaurant_id=rid and m.occurred_at>=start_at and m.occurred_at<end_at group by 1,2,3,4) x),
 'opening',(select coalesce(jsonb_object_agg(b.stock_id,b.qty),'{}'::jsonb) from (select stock_id,sum(qty) as qty from public.stock_movements where restaurant_id=rid and occurred_at<start_at group by stock_id) b),
 'costs',(select coalesce(jsonb_object_agg(c.stock_id,c.unit),'{}'::jsonb) from (select distinct on (m.stock_id) m.stock_id,m.cost::numeric/m.qty as unit from public.stock_movements m where m.restaurant_id=rid and m.kind in ('purchase','production','transfer') and m.qty>0 and m.cost>0 order by m.stock_id,m.occurred_at desc,m.received_at desc) c),
 'shifts',(select coalesce(jsonb_agg(public.shift_json(s,true) order by s.closed_at),'[]'::jsonb) from public.shifts s where s.restaurant_id=rid and s.closed_at>=start_at and s.closed_at<end_at),
 -- Each shift opened in the range with what the drawer held when the shift before it closed: 0 when there was none,
 -- null when that one closed without a count. The page books the difference as cash carried out of, or into, the drawer.
 'opened',(select coalesce(jsonb_agg(jsonb_build_object('at',public.iso(x.opened_at),'opening',x.opening,'prior',case when x.first then 0 else x.prior end) order by x.opened_at),'[]'::jsonb) from (
   select d.opened_at,d.opening,lag(d.id) over w is null as first,lag(d.drawer) over w as prior from (
    select s.id,s.opened_at,s.opening,s.counted-(select coalesce(sum((e.value->>'slip')::bigint),0) from jsonb_array_elements(coalesce(s.settlements,'[]'::jsonb)) e) as drawer from public.shifts s where s.restaurant_id=rid) d
   window w as (order by d.opened_at)) x where x.opened_at>=start_at and x.opened_at<end_at),
 -- The whole cash book, whatever the range: it is short, and an entry dated back must still reach the opening balances.
 'entries',(select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'day',to_char(e.day,'YYYY-MM-DD'),'kind',e.kind,'amount',e.amount,'note',e.note,'by',m.name) order by e.day,e.created_at),'[]'::jsonb)
  from public.ledger_entries e join public.memberships m on m.restaurant_id=e.restaurant_id and m.user_id=e.actor where e.restaurant_id=rid and e.removed_at is null),
 'cash',(select coalesce(jsonb_agg(public.cash_json(cm) order by cm.occurred_at),'[]'::jsonb) from public.cash_movements cm where cm.restaurant_id=rid and cm.occurred_at>=start_at and cm.occurred_at<end_at),
 -- Every purchase order, so what is still owed shows whenever it was received; the photos of delivery notes stay behind.
 'purchaseOrders',(select coalesce(jsonb_agg(x.doc),'[]'::jsonb) from (select jsonb_set(po.snapshot,'{receipts}',(select coalesce(jsonb_agg(r.value-'photo'),'[]'::jsonb) from jsonb_array_elements(coalesce(po.snapshot->'receipts','[]'::jsonb)) r)) as doc from public.purchase_orders po where po.restaurant_id=rid order by po.created_at desc limit 2000) x),
 'salesOrders',(select coalesce(jsonb_agg(x.snapshot),'[]'::jsonb) from (select so.snapshot from public.sales_orders so where so.restaurant_id=rid order by so.deliver_at desc limit 1000) x));
end $$;
revoke all on function public.accounting_rows(uuid,date,date) from public,anon,authenticated;
create function public.accounting_data(from_day date,to_day date) returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid;begin
 select restaurant_id into rid from public.memberships where user_id=auth.uid() and active and role in ('owner','manager','accountant');
 if rid is null then raise exception 'Manager or accountant required' using errcode='42501';end if;
 if to_day<from_day or to_day-from_day>92 then raise exception 'Accounting range limited to 93 days';end if;
 return public.accounting_rows(rid,from_day,to_day);
end $$;
revoke all on function public.accounting_data(date,date) from public,anon;
grant execute on function public.accounting_data(date,date) to authenticated;
