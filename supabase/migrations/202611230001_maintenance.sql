-- Maintenance after the 23 Nov 2026 audit. Each object is re-created from its latest definition and changed only where a
-- finding needs it; CREATE OR REPLACE keeps every grant and revoke as it was.
--
-- apply_operation (latest in 202611170003):
--  - a new order's copy of the settings must match the server's only in tax, service and packaging, the three things the
--    server reads from it, so a settings save on the laptop mid-shift no longer halts the till's outbox;
--  - a saved discount changed, ended or removed is kept 13 hours (restaurants.retired_discounts), and an order priced by
--    a definition that was live since its shift opened is accepted;
--  - the cash close expects what the cash orders came to after voided lines, as the EDC part already does;
--  - removing a never-sold menu item keeps its versions, so an order still queued on the till with it syncs;
--  - the accountant sends no order.ready.
-- use_approval (202611020006): an approval is spent within 12 hours of when it was given, by the server's clock.
-- approve (202611170002): nobody approves their own request; three wrong PINs pause only the person who typed them.
-- telegram_request (202611170001): what an approval is bound to, the order or the count, from the server.
-- accounting_rows (202611200001): prices known by the end of the range; the first shift after go-live brings its whole
-- float in from outside the drawer.
-- Device ids are for owners and managers: other members read neither devices nor restaurants.primary_device_id.
alter table public.restaurants add column retired_discounts jsonb not null default '[]';
-- The till's id is what apply_operation trusts as "the POS device", so only owners and managers (who pair devices) see
-- device ids. Every other column of a restaurant stays readable by its members; a column added later must be granted here.
drop policy member_read on public.devices;
create policy manager_read on public.devices for select to authenticated using(public.member_role(restaurant_id) in ('owner','manager'));
revoke select on public.restaurants from authenticated;
grant select(id,settings,created_at,group_id,settings_at,catalog_at,logo,logo_at) on public.restaurants to authenticated;

-- Only apply_operation calls this. Marks the approval used and returns the approver's name. occurredAt is the till's word,
-- so the approval must also be spent within 12 hours (the offline limit) of when it was given, by the server's clock.
-- There is no lower bound on occurredAt: a till whose clock runs behind would have every approval refused.
create or replace function public.use_approval(rid uuid,actor uuid,act text,target uuid,amount bigint,opid uuid,occurred timestamptz,approval uuid) returns text language plpgsql set search_path='' as $$
declare who text;begin
 update public.approvals a set operation_id=opid
 where a.id=approval and a.restaurant_id=rid and a.requested_by=actor and a.action=act and a.order_id is not distinct from target
 and a.amount is not distinct from use_approval.amount and a.operation_id is null and occurred<=a.created_at+interval '1 hour' and now()<=a.created_at+interval '12 hours'
 returning (select m.name from public.memberships m where m.restaurant_id=rid and m.user_id=a.approver) into who;
 if who is null then raise exception 'Manager approval required' using errcode='42501';end if;
 return who;
end $$;
create or replace function public.approve(approver uuid,pin text,action text,order_id uuid default null,amount bigint default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid;who text;hash text;granted uuid;begin
 select m.restaurant_id into rid from public.memberships m where m.user_id=auth.uid() and m.active;
 if rid is null then raise exception 'No active staff membership' using errcode='42501';end if;
 if approve.action not in ('discount','void','refund','cashout','count','variance','publish') then raise exception 'Unknown approval action';end if;
 -- Wrong PINs pause only the person who typed them, and one person's calls run one at a time, so parallel guesses
 -- cannot all slip under the count.
 perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
 if (select count(*) from public.approval_failures f where f.restaurant_id=rid and f.requested_by=auth.uid() and f.at>now()-interval '5 minutes')>=3 then return '{"error":"locked"}';end if;
 select m.name,p.pin_hash into who,hash from public.memberships m left join public.approval_pins p on p.restaurant_id=m.restaurant_id and p.user_id=m.user_id
 where m.restaurant_id=rid and m.user_id=approve.approver and m.active and m.role in ('owner','manager','admin');
 if who is null then raise exception 'Approver must be an active owner, manager or admin' using errcode='42501';end if;
 if approve.approver=auth.uid() then raise exception 'Cannot approve your own request' using errcode='42501';end if;
 if hash is null then return '{"error":"no-pin"}';end if;
 if approve.pin is null or extensions.crypt(approve.pin,hash)<>hash then
  insert into public.approval_failures(restaurant_id,requested_by) values(rid,auth.uid());return '{"error":"wrong-pin"}';end if;
 insert into public.approvals(restaurant_id,approver,requested_by,action,order_id,amount)
 values(rid,approve.approver,auth.uid(),approve.action,approve.order_id,approve.amount) returning id into granted;
 return jsonb_build_object('id',granted,'by',who);
end $$;
-- Who hears about a request: every linked, active owner and manager of that restaurant, while it is open. What the
-- approval is bound to comes from the server, the order (receipt, label, status, total, the items not voided) or the
-- count (area, number of lines); what is only the requester's own note.
create or replace function public.telegram_request(request uuid) returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('action',r.action,'amount',r.amount,'what',r.what,'by',m.name,
  'order',(select jsonb_build_object('receipt',o.snapshot->>'receiptId','label',o.snapshot->>'label','status',o.status,'total',(o.snapshot->'totals'->>'total')::bigint,
    'items',(select string_agg((x.value->>'qty')||'× '||(x.value->>'name'),', ') from jsonb_array_elements(o.snapshot->'lines') x where not coalesce((x.value->>'cancelled')::boolean,false)))
   from public.orders o where o.restaurant_id=r.restaurant_id and o.id=r.order_id),
  'count',(select jsonb_build_object('area',c.area,'lines',jsonb_array_length(c.lines)) from public.counts c where c.restaurant_id=r.restaurant_id and c.id=r.order_id),
  'chats',(select coalesce(jsonb_agg(l.chat_id),'[]') from public.telegram_links l join public.memberships a on a.restaurant_id=l.restaurant_id and a.user_id=l.user_id
   where l.restaurant_id=r.restaurant_id and a.active and a.role in ('owner','manager')))
 from public.approval_requests r join public.memberships m on m.restaurant_id=r.restaurant_id and m.user_id=r.requested_by
 where r.id=request and r.status='pending' and r.created_at>now()-interval '5 minutes' $$;

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
 'moves',(select coalesce(jsonb_agg(jsonb_build_object('day',x.d,'stockId',x.stock_id,'kind',x.kind,'comp',x.comp,'qty',x.qty,'cost',x.cost)),'[]'::jsonb) from (
   select to_char(((m.occurred_at at time zone tz)-make_interval(hours=>cut))::date,'YYYY-MM-DD') as d,m.stock_id,m.kind,
    (m.kind='preparation' and m.record_id in (select c.id::text from public.orders c where c.restaurant_id=rid and c.snapshot->>'mode'='compliment')) as comp,
    sum(m.qty) as qty,sum(case when m.qty<0 then -m.cost else m.cost end) as cost
   from public.stock_movements m where m.restaurant_id=rid and m.occurred_at>=start_at and m.occurred_at<end_at group by 1,2,3,4) x),
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

create or replace function public.apply_operation(operation jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 rid uuid:=(operation->>'restaurantId')::uuid;opid uuid:=(operation->>'id')::uuid;actor uuid:=auth.uid();device uuid:=(operation->>'deviceId')::uuid;k text:=operation->>'kind';p jsonb:=operation->'payload';at timestamptz:=(operation->>'occurredAt')::timestamptz;
 role text;canonical jsonb;previous public.sync_operations%rowtype;restaurant public.restaurants%rowtype;s public.shifts%rowtype;o public.orders%rowtype;
 doc jsonb;l jsonb;m jsonb;v jsonb;oldline jsonb;old jsonb;recipe jsonb;total jsonb;oid uuid;qty bigint;cost bigint;balance bigint;amount bigint;expected_value bigint;prepared jsonb;seen text[];result jsonb;settled jsonb;approver text;u record;st text;selling boolean;allowed boolean;saved jsonb;begin
 if actor is null or operation->>'actor' is distinct from actor::text then raise exception 'Authenticated actor mismatch' using errcode='42501';end if;
 role:=public.member_role(rid);if role is null then raise exception 'Membership denied' using errcode='42501';end if;
 select * into restaurant from public.restaurants where id=rid for update;
 canonical:=jsonb_build_object('kind',k,'payload',p,'actor',actor,'device',device,'occurredAt',at,'restaurant',rid);
 select * into previous from public.sync_operations where id=opid;
 if found then if previous.restaurant_id<>rid or previous.payload<>canonical then raise exception 'Operation ID reused with different payload';end if;return previous.result;end if;
 -- Who may send what. The message is the one older clients already show for a refused role.
 selling:=k in ('shift.open','shift.close','shift.cash','order.save','order.prepare','order.void','order.voidline','payment.record','refund.record');
 allowed:=(selling and role in ('owner','manager','cashier')) or (k='order.ready' and role<>'accountant')
  or (k='catalog.publish' and role in ('owner','manager','admin','chef')) or (k='catalog.remove' and role in ('owner','manager')) or (k='settings.update' and role in ('owner','manager'))
  or (k='stock.record' and (role in ('owner','manager') or (role='admin' and p->>'kind' in ('purchase','waste')) or (role in ('chef','cashier','barista','kitchen') and p->>'kind'='waste')))
  or (k in ('production.record','count.record','count.submit') and role in ('owner','manager','admin','chef','cashier','barista','kitchen'))
  or (split_part(k,'.',1) in ('purchase','supplier','salesorder','transfer') and role in ('owner','manager','admin'));
 if not allowed then raise exception 'Manager permission required' using errcode='42501';end if;
 if not exists(select 1 from public.devices where restaurant_id=rid and id=device and revoked_at is null) then raise exception 'Device not enrolled';end if;
 if selling and restaurant.primary_device_id is distinct from device then raise exception 'Primary cashier device required';end if;
 if at>now()+interval '2 minutes' or at<now()-interval '7 days' then raise exception 'Operation timestamp outside recovery window';end if;
 if k='shift.open' then
 if exists(select 1 from public.shifts where restaurant_id=rid and closed_at is null) then raise exception 'Shift already open';end if;
 insert into public.shifts(restaurant_id,id,actor,device_id,opened_at,expires_at,opening,cashier,catalog) values(rid,(p->>'id')::uuid,actor,device,at,at+interval '12 hours',(p->>'opening')::bigint,(select name from public.memberships where restaurant_id=rid and user_id=actor),(select coalesce(jsonb_object_agg(id,version),'{}') from public.catalog_items where restaurant_id=rid));
 elsif k='settings.update' then
 doc:=p->'settings';
 if length(doc->>'name') not between 1 and 100 or length(doc->>'appName') not between 1 and 30 or (doc->>'cutoff')::int not between 0 and 23 or (doc->>'taxBps')::int not between 0 and 10000 or (doc->>'serviceBps')::int not between 0 and 10000 or (doc->>'receiptWidth')::int not in (58,80) or (doc->>'printableWidth')::int not between 32 and (doc->>'receiptWidth')::int-4 or not exists(select 1 from pg_timezone_names where name=doc->>'timezone')
 or coalesce((doc->'stations'->>'kitchen')::int,15) not between 1 and 600 or coalesce((doc->'stations'->>'bar')::int,8) not between 1 and 600 or coalesce((doc->>'varianceLimit')::bigint,0) not between 0 and 1000000000 or coalesce((doc->>'lowAt')::int,5) not between 0 and 999
 or (doc ? 'cashless' and jsonb_typeof(doc->'cashless')<>'boolean') or coalesce((doc->>'complimentBudget')::bigint,0) not between 0 and 1000000000 or coalesce((doc->>'lockMinutes')::int,2) not between 0 and 120
 or (doc ? 'edcs' and (case when jsonb_typeof(doc->'edcs')='array' then jsonb_array_length(doc->'edcs')>10 or exists(select 1 from jsonb_array_elements(doc->'edcs') e where jsonb_typeof(e.value)<>'string' or length(trim(e.value#>>'{}')) not between 1 and 30) else true end)) then raise exception 'Invalid restaurant settings';end if;
 -- Saved discounts (Figma Manager 7) ride in the settings; order.save prices them, so their shape is checked here.
 if doc ? 'discounts' and (jsonb_typeof(doc->'discounts')<>'array' or jsonb_array_length(doc->'discounts')>100 or exists(select 1 from jsonb_array_elements(doc->'discounts') d where jsonb_typeof(d.value)<>'object'
  or coalesce(length(d.value->>'id'),0) not between 1 and 64 or coalesce(length(trim(d.value->>'name')),0) not between 1 and 60 or coalesce(length(d.value->>'note'),0)>60
  or coalesce(d.value->>'kind','') not in ('percent','amount') or jsonb_typeof(d.value->'value')<>'number' or (d.value->>'value')::numeric<>floor((d.value->>'value')::numeric)
  or (d.value->>'kind'='percent' and (d.value->>'value')::numeric not between 1 and 100) or (d.value->>'kind'='amount' and (d.value->>'value')::numeric not between 1 and 1000000000)
  or coalesce(d.value->>'scope','') not in ('order','food','beverage','snack','items') or (d.value->>'scope'='items' and (jsonb_typeof(d.value->'items')<>'array' or jsonb_array_length(d.value->'items') not between 1 and 500))
  or coalesce((d.value->>'minSpend')::numeric,0) not between 0 and 1000000000 or (d.value->>'from')::date>(d.value->>'to')::date))
  or (select count(distinct d.value->>'id') from jsonb_array_elements(coalesce(doc->'discounts','[]'::jsonb)) d)<>jsonb_array_length(coalesce(doc->'discounts','[]'::jsonb)) then raise exception 'Invalid saved discounts';end if;
 perform (doc->>'goLive')::date;perform public.validate_recipe(rid,doc->'packaging');
 -- A saved discount changed or removed here is kept 13 hours (a shift lasts at most 12), so the till's orders priced by
 -- its own copy before its next pull still land (order.save below); older ones are dropped on the way.
 update public.restaurants set settings=doc,settings_at=now(),retired_discounts=(select coalesce(jsonb_agg(x.e),'[]'::jsonb) from (select r.value as e from jsonb_array_elements(restaurant.retired_discounts) r
  union all select jsonb_build_object('d',d.value,'until',now()) from jsonb_array_elements(coalesce(restaurant.settings->'discounts','[]'::jsonb)) d where not exists(select 1 from jsonb_array_elements(coalesce(doc->'discounts','[]'::jsonb)) n where n.value=d.value)) x
  where (x.e->>'until')::timestamptz>now()-interval '13 hours') where id=rid;
 elsif k='catalog.remove' then
 -- A menu item that was never sold (no order line, no catering line) leaves the menu for good; one that was sold stays,
 -- switched off, so its receipts and reports keep their item. Its versions stay: a till that put it in a cart before its
 -- next pull still syncs that order. The removal itself is in the audit log.
 if jsonb_typeof(p->'ids')<>'array' or jsonb_array_length(p->'ids') not between 1 and 500 then raise exception 'Invalid removal';end if;
 for v in select value from jsonb_array_elements(p->'ids') loop
 if jsonb_typeof(v)<>'string' or not exists(select 1 from public.catalog_items where restaurant_id=rid and id=v#>>'{}') then raise exception 'Unknown menu item';end if;
 if exists(select 1 from public.order_lines where restaurant_id=rid and item_id=v#>>'{}')
 or exists(select 1 from public.sales_orders so,jsonb_array_elements(so.snapshot->'lines') x where so.restaurant_id=rid and x.value->>'itemId'=v#>>'{}') then raise exception 'Menu already sold';end if;
 delete from public.catalog_items where restaurant_id=rid and id=v#>>'{}';
 end loop;
 update public.restaurants set catalog_at=now() where id=rid;
 elsif k='catalog.publish' then
 if jsonb_array_length(p->'menu')>500 or jsonb_array_length(p->'stock')>1000 then raise exception 'Catalog too large';end if;
 for v in select value from jsonb_array_elements(p->'stock') loop
 if length(v->>'name') not between 1 and 100 or (v->>'threshold')::numeric<>trunc((v->>'threshold')::numeric) or coalesce(length(v->>'area'),0)>50
 or jsonb_typeof(coalesce(v->'aliases','[]'))<>'array' or jsonb_array_length(coalesce(v->'aliases','[]'))>20 or jsonb_typeof(coalesce(v->'packs','[]'))<>'array' or jsonb_array_length(coalesce(v->'packs','[]'))>20
 or (v->>'station' is not null and v->>'station' not in ('kitchen','bar')) or (v->>'shelfLife')::int not between 1 and 100000 then raise exception 'Invalid stock item';end if;
 if exists(select 1 from jsonb_array_elements(coalesce(v->'packs','[]')) x where length(x.value->>'name') not between 1 and 30 or (x.value->>'qty')::numeric<>trunc((x.value->>'qty')::numeric) or (x.value->>'qty')::bigint not between 1 and 1000000000000) then raise exception 'Invalid pack';end if;
 if exists(select 1 from public.inventory_items where restaurant_id=rid and id=v->>'id' and unit<>v->>'unit') then raise exception 'Base unit is immutable';end if;
 insert into public.inventory_items(restaurant_id,id,name,unit,threshold,production,aliases,area,packs,shelf_life,station,updated_at) values(rid,v->>'id',v->>'name',v->>'unit',(v->>'threshold')::bigint,nullif(v->'production','null'::jsonb),coalesce(v->'aliases','[]'),coalesce(v->>'area',''),coalesce(v->'packs','[]'),(v->>'shelfLife')::int,v->>'station',now())
 on conflict(restaurant_id,id) do update set name=excluded.name,threshold=excluded.threshold,production=excluded.production,aliases=excluded.aliases,area=excluded.area,packs=excluded.packs,shelf_life=excluded.shelf_life,station=excluded.station,updated_at=now();
 end loop;
 -- Batch recipes are checked once every stock item exists: an input may be listed after its output.
 for v in select value from jsonb_array_elements(p->'stock') loop
 if nullif(v->'production','null'::jsonb) is not null then
 perform public.validate_recipe(rid,v->'production'->'inputs');
 if jsonb_array_length(v->'production'->'inputs')=0 or exists(select 1 from jsonb_array_elements(v->'production'->'inputs') i where i.value->>'stockId'=v->>'id')
 or (v->'production'->>'output')::numeric<>trunc((v->'production'->>'output')::numeric) or (v->'production'->>'output')::bigint not between 1 and 1000000000000 then raise exception 'Invalid production recipe';end if;
 end if;
 end loop;
 -- MENU-7: a chef or admin publishing a NEW version of an active item with no recipe needs a manager's PIN; re-sending an accepted version does not.
 if role in ('admin','chef') and exists(select 1 from jsonb_array_elements(p->'menu') x where (x.value->>'active')::boolean and jsonb_array_length(x.value->'recipe')=0 and not exists(select 1 from public.catalog_versions cv where cv.restaurant_id=rid and cv.item_id=x.value->>'id' and cv.version=(x.value->>'version')::int)) then perform public.use_approval(rid,actor,'publish',null,null,opid,at,(p->>'approval')::uuid);end if;
 for v in select value from jsonb_array_elements(p->'menu') loop
 if length(v->>'name') not between 1 and 100 or length(v->>'category') not between 1 and 50 or (v->>'price')::numeric<>trunc((v->>'price')::numeric)
 or (v->>'type' is not null and v->>'type' not in ('food','beverage','snack')) or (v->>'station' is not null and v->>'station' not in ('kitchen','bar')) or (v->>'lowAt')::int not between 0 and 999
 or jsonb_typeof(coalesce(v->'tags','[]'))<>'array' or jsonb_array_length(coalesce(v->'tags','[]'))>20 or jsonb_typeof(coalesce(v->'aliases','[]'))<>'array' or jsonb_array_length(coalesce(v->'aliases','[]'))>20
 or exists(select 1 from jsonb_array_elements_text(coalesce(v->'tags','[]')||coalesce(v->'aliases','[]')) t where length(t) not between 1 and 50)
 or jsonb_typeof(coalesce(v->'groups','[]'))<>'array' or jsonb_array_length(coalesce(v->'groups','[]'))>10
 or exists(select 1 from jsonb_array_elements(coalesce(v->'groups','[]')) g where coalesce(length(g.value->>'id'),0)=0 or length(g.value->>'name') not between 1 and 50 or g.value->>'kind' not in ('add','swap','level','size')) then raise exception 'Invalid menu';end if;
 if v ? 'photo' and (length(v->>'photo')>70000 or (v->>'photo' !~ '^data:image/webp;base64,[A-Za-z0-9+/=]+$' and v->>'photo' !~ '^https://images\.unsplash\.com/[A-Za-z0-9_./?=&%-]+$')) then raise exception 'Invalid menu photo';end if;
 perform public.validate_recipe(rid,v->'recipe');seen:='{}';
 for m in select value from jsonb_array_elements(v->'modifiers') loop
 if m->>'id'=any(seen) or length(m->>'name') not between 1 and 100 or (m->>'price')::numeric<>trunc((m->>'price')::numeric) or (m->>'price')::bigint not between 0 and 1000000000
 or (m->>'group' is not null and not exists(select 1 from jsonb_array_elements(coalesce(v->'groups','[]')) g where g.value->>'id'=m->>'group')) then raise exception 'Invalid modifier';end if;
 seen:=array_append(seen,m->>'id');perform public.validate_recipe(rid,m->'recipe',true);end loop;
 if exists(select 1 from public.catalog_versions where restaurant_id=rid and item_id=v->>'id' and version=(v->>'version')::int and snapshot<>v) then raise exception 'Catalog version immutable';end if;
 if exists(select 1 from public.catalog_items where restaurant_id=rid and id=v->>'id' and version>(v->>'version')::int) then raise exception 'Stale catalog version';end if;
 insert into public.catalog_versions(restaurant_id,item_id,version,snapshot) values(rid,v->>'id',(v->>'version')::int,v) on conflict do nothing;
 insert into public.catalog_items values(rid,v->>'id',(v->>'version')::int) on conflict(restaurant_id,id) do update set version=excluded.version;
 end loop;
 else
 select * into s from public.shifts where restaurant_id=rid and closed_at is null for update;
 if selling then
 if s.id is null or at<s.opened_at or s.device_id<>device then raise exception 'No authorized shift for operation';end if;
 if s.actor<>actor and not (role in ('owner','manager') and k in ('shift.close','order.void','order.voidline')) then raise exception 'No authorized shift for operation';end if;
 if at>s.expires_at and k not in ('shift.close','order.void','order.voidline') and not (k='payment.record' and p->>'method'='cash') then raise exception 'No authorized shift for operation';end if;
 end if;
 if k='order.save' then
 doc:=p->'order';if not (doc ?& array['id','shiftId','restaurantId','actor','cashier','revision','status','mode','label','discount','discountReason','settings','receiptId','prep','createdAt','lines','totals']) then raise exception 'Missing order fields';end if;oid:=(doc->>'id')::uuid;
 select * into o from public.orders where restaurant_id=rid and id=oid for update;
 if coalesce(o.revision,0)<>(p->>'expectedRevision')::int or o.status is not null and o.status<>'open' then raise exception 'Order revision/state conflict';end if;
 if (doc->>'shiftId')::uuid<>s.id or doc->>'restaurantId'<>rid::text or doc->>'actor'<>actor::text or doc->>'cashier'<>s.cashier or (doc->>'revision')::int<>coalesce(o.revision,0)+1 or doc->>'status'<>'open' or doc->>'mode' not in ('dinein','takeaway','compliment') or length(doc->>'label')>100 or (doc ? 'name' and coalesce(length(trim(doc->>'name')),0) not between 1 and 60) then raise exception 'Invalid order';end if;
 -- Compliment: a staff meal or the owner's family, named; priced by rule below, so it needs no manager's PIN.
 if (doc->>'mode'='compliment')<>(doc ? 'compliment') or (doc ? 'compliment' and (coalesce(doc->'compliment'->>'kind','') not in ('staff','family') or coalesce(length(trim(doc->'compliment'->>'who')),0) not between 1 and 60)) then raise exception 'Invalid compliment';end if;
 if o.id is null then
 -- The order keeps the till's copy of the settings, and the server reads only tax, service and packaging from it, so only
 -- those must match: a settings save on another device mid-shift never turns the till's next order down.
 if (doc->'settings'->'taxBps') is distinct from (restaurant.settings->'taxBps') or (doc->'settings'->'serviceBps') is distinct from (restaurant.settings->'serviceBps')
 or coalesce(doc->'settings'->'packaging','[]'::jsonb)<>coalesce(restaurant.settings->'packaging','[]'::jsonb) or doc->>'receiptId'<>'MJ-'||upper(opid::text) or doc->>'prep'<>'new' or (doc->>'createdAt')::timestamptz<>at then raise exception 'Invalid initial snapshot';end if;
 else
 if (doc->'settings')-'discounts'<>(o.snapshot->'settings')-'discounts' or doc->>'receiptId'<>o.snapshot->>'receiptId' or doc->>'createdAt'<>o.snapshot->>'createdAt' then raise exception 'Historical snapshot changed';end if;
 -- A station may have marked a sent line ready meanwhile: that flag is the server's, not the till's.
 for oldline in select value from jsonb_array_elements(o.snapshot->'lines') where (value->>'prepared')::boolean loop
 if not exists(select 1 from jsonb_array_elements(doc->'lines') where value-'readyAt'=oldline-'readyAt') then raise exception 'Prepared line immutable';end if;end loop;
 end if;
 doc:=doc-'discountApprovedBy';
 -- A saved discount (Figma Manager 7) is priced by its own rule once the lines are checked, so a cashier applies it without
 -- a PIN unless the manager set it to need one, and then only when it first goes on the order. It must be running on the
 -- business day it goes on.
 saved:=null;
 if doc ? 'discountId' and doc->>'mode'<>'compliment' then
 -- The till prices it by its own copy until its next pull, so the live definition and any changed or removed since this
 -- shift opened are candidates. The first that is running (when it first goes on), gives the till's amount and needs
 -- the approval the till brought is the one the checks below use; with none, they fail as before.
 select x.d into saved from (select d.value as d from jsonb_array_elements(coalesce(restaurant.settings->'discounts','[]'::jsonb)) d
  union all select r.value->'d' from jsonb_array_elements(restaurant.retired_discounts) r where (r.value->>'until')::timestamptz>=s.opened_at) x where x.d->>'id'=doc->>'discountId'
  order by (doc->>'discountId' is not distinct from o.snapshot->>'discountId' or (not coalesce((x.d->>'ended')::boolean,false) and ((at at time zone (restaurant.settings->>'timezone'))-make_interval(hours=>coalesce((restaurant.settings->>'cutoff')::int,4)))::date between (x.d->>'from')::date and (x.d->>'to')::date)) desc,
  (doc->>'discount')::bigint=public.saved_discount(rid,doc->'lines',x.d) desc,coalesce((x.d->>'approval')::boolean,false)=(p ? 'approval') desc limit 1;
 if saved is null then raise exception 'Unknown saved discount';end if;
 if doc->>'discountId' is distinct from o.snapshot->>'discountId' and (coalesce((saved->>'ended')::boolean,false) or ((at at time zone (restaurant.settings->>'timezone'))-make_interval(hours=>coalesce((restaurant.settings->>'cutoff')::int,4)))::date not between (saved->>'from')::date and (saved->>'to')::date) then raise exception 'Saved discount not running';end if;
 if coalesce((saved->>'approval')::boolean,false) and doc->>'discountId' is distinct from o.snapshot->>'discountId' then
 doc:=doc||jsonb_build_object('discountApprovedBy',case when role in ('owner','manager') then (select name from public.memberships where restaurant_id=rid and user_id=actor) else public.use_approval(rid,actor,'discount',null,(doc->>'discount')::bigint,opid,at,(p->>'approval')::uuid) end);
 elsif o.snapshot ? 'discountApprovedBy' and doc->>'discountId' is not distinct from o.snapshot->>'discountId' then doc:=doc||jsonb_build_object('discountApprovedBy',o.snapshot->'discountApprovedBy');
 end if;
 elsif doc->>'mode'<>'compliment' and (doc->>'discount')::bigint<>(case when o.snapshot->>'mode'='compliment' then 0 else coalesce((o.snapshot->>'discount')::bigint,0) end) then
 if length(trim(doc->>'discountReason'))=0 then raise exception 'Discount requires manager and reason';end if;
 doc:=doc||jsonb_build_object('discountApprovedBy',case when role in ('owner','manager') then (select name from public.memberships where restaurant_id=rid and user_id=actor) else public.use_approval(rid,actor,'discount',null,(doc->>'discount')::bigint,opid,at,(p->>'approval')::uuid) end);
 elsif doc->>'mode'<>'compliment' and o.snapshot ? 'discountApprovedBy' and o.snapshot->>'mode'<>'compliment' then doc:=doc||jsonb_build_object('discountApprovedBy',o.snapshot->'discountApprovedBy');
 end if;
 if jsonb_array_length(doc->'lines') not between 1 and 200 then raise exception 'Invalid line count';end if;seen:='{}';prepared:='[]';
 for l in select value from jsonb_array_elements(doc->'lines') loop
 if not (l ?& array['id','itemId','name','price','qty','modifiers','note','recipe','catalogVersion','prepared','cancelled']) then raise exception 'Missing line fields';end if;
 -- A line voided earlier (order.voidline) rides along unchanged; the server's copy is kept.
 if (l->>'cancelled')::boolean then
 old:=null;if o.id is not null then select value into old from jsonb_array_elements(o.snapshot->'lines') where value->>'id'=l->>'id' and (value->>'cancelled')::boolean;end if;
 if l->>'id'=any(seen) or old is null or old-'readyAt'<>l-'readyAt' then raise exception 'Invalid/duplicate line';end if;
 seen:=array_append(seen,l->>'id');prepared:=prepared||jsonb_build_array(old);continue;
 end if;
 if l->>'id'=any(seen) or (l->>'cancelled')::boolean or length(l->>'note')>300 or (l->>'station' is not null and l->>'station' not in ('kitchen','bar')) then raise exception 'Invalid/duplicate line';end if;seen:=array_append(seen,l->>'id');
 select snapshot into v from public.catalog_versions where restaurant_id=rid and item_id=l->>'itemId' and version=(l->>'catalogVersion')::int;
 if v is null or not (v->>'active')::boolean or (v->>'soldOut')::boolean or l->>'name'<>v->>'name' or l->'price'<>v->'price' or l->'recipe'<>v->'recipe' then raise exception 'Catalog snapshot mismatch';end if;
 if (select count(*) from jsonb_array_elements(l->'modifiers'))<>(select count(distinct value->>'id') from jsonb_array_elements(l->'modifiers')) then raise exception 'Duplicate modifier';end if;
 for m in select value from jsonb_array_elements(l->'modifiers') loop if not exists(select 1 from jsonb_array_elements(v->'modifiers') where value=m) then raise exception 'Modifier snapshot mismatch';end if;end loop;
 if (l->>'prepared')::boolean and not exists(select 1 from public.preparations where restaurant_id=rid and order_id=oid and line_id=(l->>'id')::uuid) then raise exception 'Preparation not recorded';end if;
 if o.id is not null then select value into old from jsonb_array_elements(o.snapshot->'lines') where value->>'id'=l->>'id';if old ? 'readyAt' then l:=l||jsonb_build_object('readyAt',old->'readyAt');end if;end if;
 prepared:=prepared||jsonb_build_array(l);
 end loop;
 doc:=doc||jsonb_build_object('lines',prepared,'prep',public.prep_state(prepared));
 if doc->>'mode'='compliment' and (doc->>'discount')::bigint<>public.compliment_discount(rid,doc->'lines',doc->'compliment'->>'kind') then raise exception 'Invalid compliment';end if;
 if saved is not null and (doc->>'discount')::bigint<>public.saved_discount(rid,doc->'lines',saved) then raise exception 'Invalid saved discount';end if;
 total:=public.order_total(doc);if total<>doc->'totals' then raise exception 'Client total mismatch';end if;
 if doc ? 'payment' or doc ? 'refund' then raise exception 'Financial fields require separate operation';end if;
 insert into public.orders(restaurant_id,id,shift_id,actor,revision,status,created_at,updated_at,snapshot) values(rid,oid,s.id,actor,(doc->>'revision')::int,'open',(doc->>'createdAt')::timestamptz,at,doc) on conflict(restaurant_id,id) do update set revision=excluded.revision,updated_at=excluded.updated_at,snapshot=excluded.snapshot,received_at=now();
 delete from public.order_lines where restaurant_id=rid and order_id=oid and not ((snapshot->>'prepared')::boolean);
 for l in select value from jsonb_array_elements(doc->'lines') loop insert into public.order_lines values(rid,oid,(l->>'id')::uuid,l->>'itemId',(l->>'catalogVersion')::int,l) on conflict do nothing;end loop;
 elsif k='order.ready' then
 -- A station tablet: marks its prepared lines ready, no revision bump, so it never conflicts with the till.
 oid:=(p->>'id')::uuid;select * into o from public.orders where restaurant_id=rid and id=oid for update;
 if o.id is null then raise exception 'Order not found';end if;
 st:=p->>'station';if st is not null and st not in ('kitchen','bar') then raise exception 'Unknown station';end if;
 -- Paid orders still have tickets to serve (pay at the counter, then make). A void or refunded one is simply done.
 if o.status in ('open','paid') then
 doc:=o.snapshot;
 if st is null and exists(select 1 from jsonb_array_elements(doc->'lines') where not (value->>'prepared')::boolean) then raise exception 'Prepare all lines first';end if;
 prepared:='[]';
 for l in select value from jsonb_array_elements(doc->'lines') loop
 if (l->>'prepared')::boolean and not (l->>'cancelled')::boolean and not (l ? 'readyAt') and (st is null or coalesce(l->>'station','kitchen')=st) then l:=l||jsonb_build_object('readyAt',operation->>'occurredAt');end if;
 prepared:=prepared||jsonb_build_array(l);end loop;
 doc:=doc||jsonb_build_object('lines',prepared,'prep',public.prep_state(prepared));
 update public.orders set snapshot=doc,received_at=now() where restaurant_id=rid and id=oid;
 end if;
 elsif k='order.voidline' then
 -- One made line off an open or paid order: manager's PIN, reason on the line, totals recomputed. On a paid order the
 -- cashier voids the difference on the EDC too; the settlement then expects the new total.
 oid:=(p->>'id')::uuid;select * into o from public.orders where restaurant_id=rid and id=oid for update;
 if o.id is null or o.shift_id<>s.id or o.revision<>(p->>'expectedRevision')::int then raise exception 'Order revision conflict';end if;
 if o.status not in ('open','paid') or coalesce(length(trim(p->>'reason')),0) not between 1 and 300
 or not exists(select 1 from jsonb_array_elements(o.snapshot->'lines') x where x.value->>'id'=p->>'lineId' and (x.value->>'prepared')::boolean and not (x.value->>'cancelled')::boolean)
 or (select count(*) from jsonb_array_elements(o.snapshot->'lines') x where not (x.value->>'cancelled')::boolean)<2 then raise exception 'Invalid line void';end if;
 approver:=case when role in ('owner','manager') then (select name from public.memberships where restaurant_id=rid and user_id=actor) else public.use_approval(rid,actor,'void',oid,null,opid,at,(p->>'approval')::uuid) end;
 prepared:='[]';
 for l in select value from jsonb_array_elements(o.snapshot->'lines') loop
 if l->>'id'=p->>'lineId' then l:=l||jsonb_build_object('cancelled',true,'voidReason',trim(p->>'reason'),'voidApprovedBy',approver);update public.order_lines set snapshot=l where restaurant_id=rid and order_id=oid and id=(l->>'id')::uuid;end if;
 prepared:=prepared||jsonb_build_array(l);end loop;
 doc:=o.snapshot||jsonb_build_object('lines',prepared);
 if doc->>'mode'='compliment' then doc:=doc||jsonb_build_object('discount',public.compliment_discount(rid,prepared,doc->'compliment'->>'kind'));end if;
 -- A saved discount follows the lines left, as a compliment does; one deleted since keeps the amount it had.
 if doc ? 'discountId' then select d.value into saved from jsonb_array_elements(coalesce(restaurant.settings->'discounts','[]'::jsonb)) d where d.value->>'id'=doc->>'discountId';
 if saved is not null then doc:=doc||jsonb_build_object('discount',public.saved_discount(rid,prepared,saved));end if;end if;
 doc:=doc||jsonb_build_object('totals',public.order_total(doc),'revision',o.revision+1,'updatedAt',operation->>'occurredAt');
 update public.orders set revision=o.revision+1,updated_at=at,received_at=now(),snapshot=doc where restaurant_id=rid and id=oid;
 elsif k in ('order.prepare','order.void','payment.record','refund.record') then
 oid:=(p->>'id')::uuid;select * into o from public.orders where restaurant_id=rid and id=oid for update;
 if o.id is null or o.shift_id<>s.id or o.revision<>(p->>'expectedRevision')::int then raise exception 'Order revision conflict';end if;
 if k='refund.record' then
 if o.status<>'paid' or length(trim(p->>'reason'))=0 then raise exception 'Invalid refund';end if;
 approver:=case when role in ('owner','manager') then (select name from public.memberships where restaurant_id=rid and user_id=actor) else public.use_approval(rid,actor,'refund',oid,null,opid,at,(p->>'approval')::uuid) end;
 insert into public.refunds values(rid,oid,opid,(o.snapshot->'totals'->>'total')::bigint,p->>'reason',actor,at,now());
 doc:=o.snapshot||jsonb_build_object('status','refunded','refund',jsonb_build_object('reason',p->>'reason','at',operation->>'occurredAt','actor',actor,'approvedBy',approver));
 else
 if o.status<>'open' then raise exception 'Order is not open';end if;
 doc:=o.snapshot;
 if k='order.prepare' then
 if jsonb_array_length(p->'lineIds')=0 then raise exception 'No new preparation lines';end if;prepared:='[]';
 for l in select value from jsonb_array_elements(doc->'lines') loop
 if (p->'lineIds') ? (l->>'id') then
 if (l->>'prepared')::boolean then raise exception 'Line already prepared';end if;
 insert into public.preparations values(rid,oid,(l->>'id')::uuid,opid,at,actor);
 select snapshot into v from public.catalog_versions where restaurant_id=rid and item_id=l->>'itemId' and version=(l->>'catalogVersion')::int;
 recipe:=l->'recipe';for m in select value from jsonb_array_elements(l->'modifiers') loop recipe:=recipe||(m->'recipe');end loop;
 if doc->>'mode'='takeaway' then recipe:=recipe||(doc->'settings'->'packaging');end if;
 -- Per line, option deltas net against the base recipe and never below zero.
 for u in select x.value->>'stockId' as stock_id,sum((x.value->>'qty')::bigint) as q from jsonb_array_elements(recipe) x group by 1 having sum((x.value->>'qty')::bigint)>0 loop
 qty:=-(u.q*(l->>'qty')::bigint);
 insert into public.stock_movements values(rid,opid::text||'-'||u.stock_id,u.stock_id,qty,'preparation','Persiapan '||coalesce(nullif(doc->>'label',''),doc->>'receiptId'),actor,at,now(),oid::text,opid,0)
 on conflict(restaurant_id,id) do update set qty=public.stock_movements.qty+excluded.qty;
 end loop;
 l:=l||jsonb_build_object('prepared',true,'preparedAt',operation->>'occurredAt');
 if not (l ? 'station') then l:=l||jsonb_build_object('station',coalesce(v->>'station',case when v->>'type'='beverage' or (v->>'type' is null and coalesce(v->>'category','') ~* 'minum|drink|kopi|coffee|tea|teh|juice|jus') then 'bar' else 'kitchen' end));end if;
 update public.order_lines set snapshot=l where restaurant_id=rid and order_id=oid and id=(l->>'id')::uuid;
 end if;prepared:=prepared||jsonb_build_array(l);end loop;
 if (select count(*) from public.preparations where restaurant_id=rid and operation_id=opid)<>jsonb_array_length(p->'lineIds') then raise exception 'Unknown preparation line';end if;
 doc:=doc||jsonb_build_object('lines',prepared,'prep',public.prep_state(prepared));
 elsif k='order.void' then
 if length(trim(p->>'reason'))=0 then raise exception 'Void reason required';end if;
 approver:=case when role in ('owner','manager') then (select name from public.memberships where restaurant_id=rid and user_id=actor) else public.use_approval(rid,actor,'void',oid,null,opid,at,(p->>'approval')::uuid) end;
 doc:=doc||jsonb_build_object('status','void','voidReason',p->>'reason','voidApprovedBy',approver);
 elsif k='payment.record' then
 if exists(select 1 from jsonb_array_elements(doc->'lines') where not (value->>'prepared')::boolean) then raise exception 'Prepare before payment';end if;
 total:=public.order_total(doc);amount:=(total->>'total')::bigint;
 if p->>'method' not in ('cash','qris','card','none') or (p->>'method' in ('qris','card') and not coalesce((p->>'verified')::boolean,false)) then raise exception 'Online merchant verification required';end if;
 -- Cashless: card or QRIS on a named EDC, approval code from the slip optional; a free compliment pays 'none'.
 if (p->>'method'='none' and amount<>0) or (p->>'method'<>'none' and amount=0 and doc->>'mode'='compliment') then raise exception 'Invalid payment method';end if;
 if p->>'method'='cash' and coalesce((restaurant.settings->>'cashless')::boolean,false) then raise exception 'Cashless outlet';end if;
 if (p ? 'edc' and p->>'method' not in ('qris','card')) or coalesce(length(p->>'edc'),0)>30 or coalesce(length(p->>'approvalCode'),0)>30
 or (p->>'method' in ('qris','card') and (coalesce((restaurant.settings->>'cashless')::boolean,false) or jsonb_array_length(coalesce(restaurant.settings->'edcs','[]'))>0) and coalesce(length(trim(p->>'edc')),0)=0) then raise exception 'EDC required';end if;
 cost:=case when p->>'method'='cash' then (p->>'tendered')::bigint else amount end;
 if cost<amount then raise exception 'Insufficient tender';end if;
 insert into public.payments values(rid,oid,opid,p->>'method',amount,cost,cost-amount,true,at,now(),actor,nullif(trim(p->>'edc'),''),nullif(trim(p->>'approvalCode'),''));
 doc:=doc||jsonb_build_object('status','paid','payment',jsonb_build_object('method',p->>'method','tendered',cost,'change',cost-amount,'verified',true,'at',operation->>'occurredAt')||jsonb_strip_nulls(jsonb_build_object('edc',nullif(trim(p->>'edc'),''),'approvalCode',nullif(trim(p->>'approvalCode'),''))));
 end if;end if;
 doc:=doc||jsonb_build_object('revision',o.revision+1,'updatedAt',operation->>'occurredAt');update public.orders set revision=o.revision+1,status=doc->>'status',updated_at=at,received_at=now(),snapshot=doc where restaurant_id=rid and id=oid;
 elsif split_part(k,'.',1)='purchase' then perform public.op_purchase(rid,actor,device,opid,at,operation->>'occurredAt',k,p,s);
 elsif k='production.record' then perform public.op_production(rid,actor,opid,at,p);
 elsif k='supplier.save' then perform public.op_supplier(rid,p,at);
 elsif split_part(k,'.',1)='salesorder' then perform public.op_sales_order(rid,actor,device,opid,at,operation->>'occurredAt',k,p,s,restaurant.settings);
 elsif split_part(k,'.',1)='transfer' then perform public.op_transfer(rid,actor,opid,at,operation->>'occurredAt',k,p,restaurant);
 elsif k='stock.record' then
 if length(trim(p->>'reason'))=0 then raise exception 'Reason required';end if;
 qty:=(p->>'qty')::bigint;cost:=(p->>'cost')::bigint;if cost not between 0 and 1000000000 or abs(qty)>1000000000000 then raise exception 'Invalid stock amount';end if;
 if p->>'kind' in ('opening','purchase') and qty<=0 or p->>'kind'='count' and qty<0 then raise exception 'Invalid stock quantity';end if;
 if p->>'kind'='preparation' then raise exception 'Preparation must use order operation';end if;
 if p->>'photo' is not null and (length(p->>'photo')>70000 or p->>'photo' !~ '^data:image/webp;base64,[A-Za-z0-9+/=]+$') then raise exception 'Invalid photo';end if;
 if p->>'kind'='purchase' then insert into public.purchases(restaurant_id,id,stock_id,qty,cost,reason,actor,occurred_at,photo) values(rid,opid,p->>'stockId',qty,cost,p->>'reason',actor,at,p->>'photo');end if;
 if p->>'kind'='count' then select coalesce(sum(sm.qty),0) into balance from public.stock_movements sm where restaurant_id=rid and stock_id=p->>'stockId';qty:=qty-balance;end if;
 if p->>'kind'='waste' then qty:=-abs(qty);end if;
 insert into public.stock_movements values(rid,opid::text,p->>'stockId',qty,p->>'kind',p->>'reason',actor,at,now(),opid::text,opid,cost);
 if (p->>'fromDrawer')::boolean then
 if s.id is null or s.actor<>actor or p->>'kind'<>'purchase' or (p->>'shiftId')::uuid<>s.id then raise exception 'Cash purchase requires active shift';end if;
 insert into public.cash_movements values(rid,opid,s.id,-cost,'Pembelian: '||(p->>'reason'),actor,at,opid);end if;
 elsif k='count.record' then
 -- CNT-3: one approved count = one movement per line that differs, plus the record for the variance report.
 if coalesce(length(trim(p->>'area')),0)=0 or length(p->>'area')>50 or jsonb_typeof(p->'lines')<>'array' or jsonb_array_length(p->'lines') not between 1 and 1000 then raise exception 'Invalid count';end if;
 approver:=case when role in ('owner','manager') then (select name from public.memberships where restaurant_id=rid and user_id=actor) else public.use_approval(rid,actor,'count',(p->>'id')::uuid,null,opid,at,(p->>'approval')::uuid) end;
 prepared:='[]';seen:='{}';
 for l in select value from jsonb_array_elements(p->'lines') loop
 if l->>'stockId'=any(seen) or (l->>'counted')::numeric<>trunc((l->>'counted')::numeric) or (l->>'counted')::bigint not between 0 and 1000000000000 or coalesce(length(l->>'reason'),0)>200 or not exists(select 1 from public.inventory_items where restaurant_id=rid and id=l->>'stockId') then raise exception 'Invalid count line';end if;
 seen:=array_append(seen,l->>'stockId');
 select coalesce(sum(sm.qty),0) into balance from public.stock_movements sm where restaurant_id=rid and stock_id=l->>'stockId';
 qty:=(l->>'counted')::bigint-balance;
 insert into public.stock_movements values(rid,opid::text||'-'||(l->>'stockId'),l->>'stockId',qty,'count','Hitung '||trim(p->>'area')||coalesce(': '||nullif(trim(l->>'reason'),''),''),actor,at,now(),p->>'id',opid,0);
 prepared:=prepared||jsonb_build_array(jsonb_build_object('stockId',l->>'stockId','expected',balance,'counted',(l->>'counted')::bigint,'reason',coalesce(l->>'reason','')));
 end loop;
 insert into public.counts(restaurant_id,id,area,actor,approver,lines,status,occurred_at,operation_id) values(rid,(p->>'id')::uuid,trim(p->>'area'),actor,approver,prepared,'approved',at,opid)
 on conflict(restaurant_id,id) do update set area=excluded.area,actor=excluded.actor,approver=excluded.approver,lines=excluded.lines,status='approved',occurred_at=excluded.occurred_at,received_at=now(),operation_id=excluded.operation_id;
 elsif k='count.submit' then
 -- CNT-1: a count submitted on a tablet waits here for a manager's approval, on any paired device.
 if coalesce(length(trim(p->>'area')),0)=0 or length(p->>'area')>50 or jsonb_typeof(p->'lines')<>'array' or jsonb_array_length(p->'lines') not between 1 and 1000 then raise exception 'Invalid count';end if;
 if exists(select 1 from public.counts where restaurant_id=rid and id=(p->>'id')::uuid and status='approved') then raise exception 'Count already approved';end if;
 insert into public.counts(restaurant_id,id,area,actor,approver,lines,status,occurred_at,operation_id) values(rid,(p->>'id')::uuid,trim(p->>'area'),actor,null,p->'lines','submitted',at,opid)
 on conflict(restaurant_id,id) do update set area=excluded.area,lines=excluded.lines,occurred_at=excluded.occurred_at,received_at=now(),operation_id=excluded.operation_id;
 elsif k='shift.cash' then
 if (p->>'shiftId')::uuid<>s.id or length(trim(p->>'reason'))=0 or (p->>'amount')::bigint=0 then raise exception 'Invalid cash movement';end if;
 if (p->>'amount')::bigint<0 and role not in ('owner','manager') then perform public.use_approval(rid,actor,'cashout',null,-(p->>'amount')::bigint,opid,at,(p->>'approval')::uuid);end if;
 insert into public.cash_movements values(rid,opid,s.id,(p->>'amount')::bigint,p->>'reason',actor,at,null);
 elsif k='shift.close' then
 if (p->>'id')::uuid<>s.id or exists(select 1 from public.orders where restaurant_id=rid and shift_id=s.id and status='open') then raise exception 'Open orders prevent closing';end if;
 -- Cash expected: the float, what the cash orders came to after any line voided since (that cash went back to the
 -- guest), the way the EDC part below counts, and the drawer cash moved.
 select s.opening+coalesce((select sum((ord.snapshot->'totals'->>'total')::bigint) from public.payments pay join public.orders ord on ord.restaurant_id=pay.restaurant_id and ord.id=pay.order_id where ord.restaurant_id=rid and ord.shift_id=s.id and pay.method='cash' and ord.status<>'refunded'),0)+coalesce((select sum(cm.amount) from public.cash_movements cm where cm.restaurant_id=rid and cm.shift_id=s.id),0) into expected_value;
 settled:=null;
 if p ? 'settlements' then
 -- Cashless close: each EDC's settlement slip against what Takar recorded on it; machines with sales but no slip count as 0.
 if jsonb_typeof(p->'settlements')<>'array' or jsonb_array_length(p->'settlements')>20 or (select count(distinct x.value->>'edc') from jsonb_array_elements(p->'settlements') x)<>jsonb_array_length(p->'settlements')
 or exists(select 1 from jsonb_array_elements(p->'settlements') x where coalesce(length(trim(x.value->>'edc')),0) not between 1 and 30 or (x.value->>'slip')::numeric<>trunc((x.value->>'slip')::numeric) or (x.value->>'slip')::bigint not between 0 and 1000000000) then raise exception 'Invalid settlement';end if;
 select coalesce(jsonb_agg(jsonb_build_object('edc',e.edc,'expected',e.expected,'slip',e.slip) order by e.edc),'[]') into settled from (
  select coalesce(a.edc,b.edc) as edc,coalesce(b.expected,0)::bigint as expected,coalesce(a.slip,0) as slip from
  (select x.value->>'edc' as edc,(x.value->>'slip')::bigint as slip from jsonb_array_elements(p->'settlements') x) a
  full join (select ord.snapshot->'payment'->>'edc' as edc,sum((ord.snapshot->'totals'->>'total')::bigint) as expected from public.orders ord where ord.restaurant_id=rid and ord.shift_id=s.id and ord.status='paid' and ord.snapshot->'payment' ? 'edc' group by 1) b on a.edc=b.edc) e;
 -- counted = the drawer's cash plus every slip; a store that takes cash and EDC closes both at once.
 select (p->>'counted')::bigint-coalesce(sum((x.value->>'slip')::bigint),0),coalesce(sum((x.value->>'expected')::bigint),0),coalesce(sum(abs((x.value->>'slip')::bigint-(x.value->>'expected')::bigint)),0) into balance,cost,qty from jsonb_array_elements(settled) x;
 if balance<0 then raise exception 'Settlement total mismatch';end if;
 qty:=qty+abs(balance-expected_value);expected_value:=expected_value+cost;
 else qty:=abs((p->>'counted')::bigint-expected_value);end if;
 amount:=(p->>'counted')::bigint-expected_value;
 -- POS-8: a cashier's gap over the limit needs a manager's PIN for exactly that amount (cashless: the sum of each EDC's gap); managers answer for their own.
 approver:=case when role in ('owner','manager') then null when qty>coalesce((restaurant.settings->>'varianceLimit')::bigint,10000) then public.use_approval(rid,actor,'variance',null,qty,opid,at,(p->>'approval')::uuid) end;
 update public.shifts set closed_at=at,counted=(p->>'counted')::bigint,expected=expected_value,variance=amount,variance_approved_by=approver,settlements=settled,received_at=now() where restaurant_id=rid and id=s.id;
 else raise exception 'Unknown operation';end if;
 end if;
 result:=jsonb_build_object('id',opid,'receivedAt',now());insert into public.sync_operations(id,restaurant_id,actor,device_id,kind,payload,occurred_at,result) values(opid,rid,actor,device,k,canonical,at,result);return result;
end $$;
