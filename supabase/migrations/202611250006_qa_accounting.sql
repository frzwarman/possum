-- Accounting QA fixes: accounting_rows keeps unpriced deliveries and production batches in separate rows.
-- Re-created from 202611230001_maintenance.sql; the only change is the 'moves' block. New keys (batch, at) are ignored by older clients.
create or replace function public.accounting_rows(rid uuid,from_day date,to_day date) returns jsonb language plpgsql stable set search_path='' as $$
declare config jsonb;tz text;cut integer;start_at timestamptz;end_at timestamptz;golive timestamptz;begin
 select settings into config from public.restaurants where id=rid;tz:=config->>'timezone';cut:=(config->>'cutoff')::int;
 start_at:=(from_day::timestamp+make_interval(hours=>cut)) at time zone tz;end_at:=((to_day+1)::timestamp+make_interval(hours=>cut)) at time zone tz;
 golive:=((config->>'goLive')::date::timestamp+make_interval(hours=>cut)) at time zone tz;
 return jsonb_build_object('asOf',public.iso(now()),
 'orders',(select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'receiptId',o.snapshot->'receiptId','mode',o.snapshot->'mode','status',o.status,'cashier',o.snapshot->'cashier','totals',o.snapshot->'totals','createdAt',o.snapshot->'createdAt',
   'lines',(select coalesce(jsonb_agg(jsonb_build_object('itemId',l.value->'itemId','name',l.value->'name','qty',l.value->'qty','price',l.value->'price','cancelled',coalesce((l.value->>'cancelled')::boolean,false),'recipe',coalesce(l.value->'recipe','[]'::jsonb),
    'modifiers',(select coalesce(jsonb_agg(jsonb_build_object('price',x.value->'price','recipe',coalesce(x.value->'recipe','[]'::jsonb))),'[]'::jsonb) from jsonb_array_elements(coalesce(l.value->'modifiers','[]'::jsonb)) x))),'[]'::jsonb) from jsonb_array_elements(o.snapshot->'lines') l))
   ||jsonb_strip_nulls(jsonb_build_object('payment',o.snapshot->'payment','refund',o.snapshot->'refund'))),'[]'::jsonb)
  from public.orders o where o.restaurant_id=rid and (
   exists(select 1 from public.payments p where p.restaurant_id=rid and p.order_id=o.id and p.occurred_at>=start_at and p.occurred_at<end_at)
   or exists(select 1 from public.refunds f where f.restaurant_id=rid and f.order_id=o.id and f.occurred_at>=start_at and f.occurred_at<end_at))),
 -- comp: stock that left for a compliment (a staff meal, the owner's family) is an expense, not cost of sales.
 -- STOK-1: a delivery without a price is its own row, so it is not merged into a priced one of the same day (it joins the
 -- stock at the average, not at nothing). STK-10: a production batch is its own rows (batch, at), so a batch that uses what an
 -- earlier one made the same day is valued in time order.
 'moves',(select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('day',x.d,'stockId',x.stock_id,'kind',x.kind,'comp',x.comp,'qty',x.qty,'cost',x.cost,'batch',x.batch,'at',public.iso(x.at)))),'[]'::jsonb) from (
   select to_char(((m.occurred_at at time zone tz)-make_interval(hours=>cut))::date,'YYYY-MM-DD') as d,m.stock_id,m.kind,
    (m.kind='preparation' and m.record_id in (select c.id::text from public.orders c where c.restaurant_id=rid and c.snapshot->>'mode'='compliment')) as comp,
    case when m.kind='production' then m.record_id end as batch,
    (m.kind in ('purchase','transfer','opening') and m.qty>0 and m.cost=0) as unpriced,
    sum(m.qty) as qty,sum(case when m.qty<0 then -m.cost else m.cost end) as cost,case when m.kind='production' then min(m.occurred_at) end as at
   from public.stock_movements m where m.restaurant_id=rid and m.occurred_at>=start_at and m.occurred_at<end_at group by 1,2,3,4,5,6) x),
 'opening',(select coalesce(jsonb_object_agg(b.stock_id,b.qty),'{}'::jsonb) from (select stock_id,sum(qty) as qty from public.stock_movements where restaurant_id=rid and occurred_at<start_at group by stock_id) b),
 -- Prices known by the end of the range, so a month that has ended keeps its value when a later purchase moves a price.
 'costs',(select coalesce(jsonb_object_agg(c.stock_id,c.unit),'{}'::jsonb) from (select distinct on (m.stock_id) m.stock_id,m.cost::numeric/m.qty as unit from public.stock_movements m where m.restaurant_id=rid and m.kind in ('purchase','production','transfer') and m.qty>0 and m.cost>0 and m.occurred_at<end_at order by m.stock_id,m.occurred_at desc,m.received_at desc) c),
 'shifts',(select coalesce(jsonb_agg(public.shift_json(s,true) order by s.closed_at),'[]'::jsonb) from public.shifts s where s.restaurant_id=rid and s.closed_at>=start_at and s.closed_at<end_at),
 -- Each shift opened in the range with what the drawer held when the shift before it closed: 0 when there was none, or
 -- when it is the first shift after go-live (the books start then, so its whole float comes in from outside the drawer),
 -- null when that one closed without a count. The page books the difference as cash carried out of, or into, the drawer.
 'opened',(select coalesce(jsonb_agg(jsonb_build_object('at',public.iso(x.opened_at),'opening',x.opening,'prior',case when x.first or (x.prev<golive and x.opened_at>=golive) then 0 else x.prior end) order by x.opened_at),'[]'::jsonb) from (
   select d.opened_at,d.opening,lag(d.id) over w is null as first,lag(d.drawer) over w as prior,lag(d.opened_at) over w as prev from (
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
