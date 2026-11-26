-- QA fixes, 2026-11-25. public.apply_operation, re-created from 202611230001_maintenance.sql. Every change from that
-- definition answers a verified finding of the production-readiness campaign and has a check in scripts/db-checks/.
-- The server stays compatible with the web app and the Takar Stok app as deployed before this file: it refuses only
-- what no honest client sends. Tightenings that would refuse an older client wait in supabase/pending/.
create or replace function public.apply_operation(operation jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 rid uuid:=(operation->>'restaurantId')::uuid;opid uuid:=(operation->>'id')::uuid;actor uuid:=auth.uid();device uuid:=(operation->>'deviceId')::uuid;k text:=operation->>'kind';p jsonb:=operation->'payload';at timestamptz:=(operation->>'occurredAt')::timestamptz;
 role text;canonical jsonb;previous public.sync_operations%rowtype;restaurant public.restaurants%rowtype;s public.shifts%rowtype;o public.orders%rowtype;
 doc jsonb;l jsonb;m jsonb;v jsonb;oldline jsonb;old jsonb;recipe jsonb;total jsonb;oid uuid;qty bigint;cost bigint;balance bigint;amount bigint;expected_value bigint;prepared jsonb;seen text[];result jsonb;settled jsonb;approver text;u record;st text;selling boolean;allowed boolean;saved jsonb;
 -- Each fix adds its own declarations on a line of its own, below this comment and above "begin".
 unrecipied boolean:=false; -- catalog.publish: a new version of an active item without a recipe (MENU-7)
 waiting public.counts%rowtype;wl jsonb;lt timestamptz; -- counts: the count row a count.record/count.submit meets, its matching line, the time a line was counted (CT-01, STK-02, SEC-1)
 rule jsonb;approved bigint; -- order.save: a manual discount's rule, and the amount the manager's approval covers (discounts: TILL-02, DSC-2)
 lv bigint;vold bigint;vown bigint;vnew boolean; -- order.voidline: the line's value, the discount it had, the discount's own rule on the lines left, whether the approval is the new form (voids: CT-02, SEC-1)
begin
 if actor is null or operation->>'actor' is distinct from actor::text then raise exception 'Authenticated actor mismatch' using errcode='42501';end if;
 -- SQL-16: one overall size limit (64 MiB, P0001 like every refusal). The largest honest operation is a catalog.publish: at most 500 menu rows
 -- and 1,000 stock rows (the client's own limits), photos 70,000 characters each, in practice only the rows that changed. 500 photos at the
 -- maximum are 35 MB; an order of 200 lines is about 0.2 MB. Per-field caps (reasons, notes) belong to the blocks that read those fields.
 if length(operation::text)>67108864 then raise exception 'Operation too large';end if;
 role:=public.member_role(rid);if role is null then raise exception 'Membership denied' using errcode='42501';end if;
 select * into restaurant from public.restaurants where id=rid for update;
 canonical:=jsonb_build_object('kind',k,'payload',p,'actor',actor,'device',device,'occurredAt',at,'restaurant',rid);
 select * into previous from public.sync_operations where id=opid;
 if found then if previous.restaurant_id<>rid or previous.payload<>canonical then raise exception 'Operation ID reused with different payload';end if;return previous.result;end if;
 -- Who may send what. The message is the one older clients already show for a refused role.
 selling:=k in ('shift.open','shift.close','shift.cash','order.save','order.prepare','order.void','order.voidline','payment.record','refund.record');
 allowed:=(selling and role in ('owner','manager','cashier')) or (k='order.ready' and role<>'accountant')
  or (k='catalog.publish' and role in ('owner','manager','admin','chef')) or (k='catalog.remove' and role in ('owner','manager')) or (k='settings.update' and role in ('owner','manager'))
  or (k='stock.record' and (role in ('owner','manager') or (role='admin' and coalesce(p->>'kind','') in ('purchase','waste')) or (role in ('chef','cashier','barista','kitchen') and coalesce(p->>'kind','')='waste')))
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
 -- SQL-15: ->> on a missing or null key is NULL, and a NULL test never raises: the keys the till prices and prints by are required.
 if jsonb_typeof(doc)<>'object' or doc->>'id' is distinct from 'settings' or jsonb_typeof(doc->'packaging') is distinct from 'array' or exists(select 1 from unnest(array['name','appName','timezone','goLive','cutoff','taxBps','serviceBps','receiptWidth','printableWidth']) key where jsonb_typeof(doc->key) is distinct from (case when key in ('cutoff','taxBps','serviceBps','receiptWidth','printableWidth') then 'number' else 'string' end)) then raise exception 'Invalid restaurant settings';end if;
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
 -- HARNESS-F2: tax, service and packaging replaced here are kept the same 13 hours (retired_pricing), so a till that priced
 -- an order by its own copy before its next pull still lands it.
 update public.restaurants set settings=doc,settings_at=now(),retired_discounts=(select coalesce(jsonb_agg(x.e),'[]'::jsonb) from (select r.value as e from jsonb_array_elements(restaurant.retired_discounts) r
  union all select jsonb_build_object('d',d.value,'until',now()) from jsonb_array_elements(coalesce(restaurant.settings->'discounts','[]'::jsonb)) d where not exists(select 1 from jsonb_array_elements(coalesce(doc->'discounts','[]'::jsonb)) n where n.value=d.value)) x
  where (x.e->>'until')::timestamptz>now()-interval '13 hours'),
  retired_pricing=(select coalesce(jsonb_agg(x.e order by x.e->>'until'),'[]'::jsonb) from (select r.value as e from jsonb_array_elements(restaurant.retired_pricing) r
  union all select jsonb_build_object('taxBps',restaurant.settings->'taxBps','serviceBps',restaurant.settings->'serviceBps','packaging',coalesce(restaurant.settings->'packaging','[]'::jsonb),'until',now())
  where (doc->'taxBps',doc->'serviceBps',coalesce(doc->'packaging','[]'::jsonb)) is distinct from (restaurant.settings->'taxBps',restaurant.settings->'serviceBps',coalesce(restaurant.settings->'packaging','[]'::jsonb))) x
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
 -- sql/SQL-05: the checks of this block are null-safe. A comparison with null is never true, so a missing key or a
 -- JSON null used to slip past them (an entry without a recipe needed no PIN and broke the till's menu). Each required
 -- key is tested for its type first, in a statement of its own, so the value tests after it never see a null.
 if jsonb_typeof(p->'menu') is distinct from 'array' or jsonb_typeof(p->'stock') is distinct from 'array' then raise exception 'Invalid catalog';end if;
 if jsonb_array_length(p->'menu')>500 or jsonb_array_length(p->'stock')>1000 then raise exception 'Catalog too large';end if;
 for v in select value from jsonb_array_elements(p->'stock') loop
 if jsonb_typeof(v->'id') is distinct from 'string' or v->>'id'='' or jsonb_typeof(v->'name') is distinct from 'string' or coalesce(v->>'unit','') not in ('g','ml','pcs') or jsonb_typeof(v->'threshold') is distinct from 'number' then raise exception 'Invalid stock item';end if;
 if length(v->>'name') not between 1 and 100 or (v->>'threshold')::numeric<>trunc((v->>'threshold')::numeric) or (v->>'threshold')::numeric not between 0 and 1000000000000 or coalesce(length(v->>'area'),0)>50
 or jsonb_typeof(coalesce(v->'aliases','[]'))<>'array' or jsonb_array_length(coalesce(v->'aliases','[]'))>20 or jsonb_typeof(coalesce(v->'packs','[]'))<>'array' or jsonb_array_length(coalesce(v->'packs','[]'))>20
 or (v->>'station' is not null and v->>'station' not in ('kitchen','bar')) or (v->>'shelfLife')::int not between 1 and 100000 then raise exception 'Invalid stock item';end if;
 if exists(select 1 from jsonb_array_elements(coalesce(v->'packs','[]')) x where coalesce(length(x.value->>'name'),0) not between 1 and 30 or jsonb_typeof(x.value->'qty') is distinct from 'number') then raise exception 'Invalid pack';end if;
 if exists(select 1 from jsonb_array_elements(coalesce(v->'packs','[]')) x where (x.value->>'qty')::numeric<>trunc((x.value->>'qty')::numeric) or (x.value->>'qty')::numeric not between 1 and 1000000000000) then raise exception 'Invalid pack';end if;
 if exists(select 1 from public.inventory_items where restaurant_id=rid and id=v->>'id' and unit<>v->>'unit') then raise exception 'Base unit is immutable';end if;
 insert into public.inventory_items(restaurant_id,id,name,unit,threshold,production,aliases,area,packs,shelf_life,station,updated_at) values(rid,v->>'id',v->>'name',v->>'unit',(v->>'threshold')::bigint,nullif(v->'production','null'::jsonb),coalesce(v->'aliases','[]'),coalesce(v->>'area',''),coalesce(v->'packs','[]'),(v->>'shelfLife')::int,v->>'station',now())
 on conflict(restaurant_id,id) do update set name=excluded.name,threshold=excluded.threshold,production=excluded.production,aliases=excluded.aliases,area=excluded.area,packs=excluded.packs,shelf_life=excluded.shelf_life,station=excluded.station,updated_at=now();
 end loop;
 -- Batch recipes are checked once every stock item exists: an input may be listed after its output.
 for v in select value from jsonb_array_elements(p->'stock') loop
 if nullif(v->'production','null'::jsonb) is not null then
 if jsonb_typeof(v->'production'->'inputs') is distinct from 'array' or jsonb_typeof(v->'production'->'output') is distinct from 'number' then raise exception 'Invalid production recipe';end if;
 perform public.validate_recipe(rid,v->'production'->'inputs');
 if jsonb_array_length(v->'production'->'inputs')=0 or exists(select 1 from jsonb_array_elements(v->'production'->'inputs') i where i.value->>'stockId'=v->>'id')
 or (v->'production'->>'output')::numeric<>trunc((v->'production'->>'output')::numeric) or (v->'production'->>'output')::numeric not between 1 and 1000000000000 then raise exception 'Invalid production recipe';end if;
 end if;
 end loop;
 for v in select value from jsonb_array_elements(p->'menu') loop
 if jsonb_typeof(v->'id') is distinct from 'string' or v->>'id'='' or jsonb_typeof(v->'version') is distinct from 'number' then raise exception 'Invalid menu';end if;
 if (v->>'version')::numeric<>trunc((v->>'version')::numeric) or (v->>'version')::numeric not between 1 and 2147483647 then raise exception 'Invalid menu';end if;
 -- menu/F1, F8: the app deployed before this file sends its whole catalog with every save, so a device that has not
 -- pulled yet sends old copies of items it never touched. A version this server already holds unchanged is not news
 -- and is skipped, whether a newer one is live (it used to be refused as stale, which halted that device's outbox)
 -- or the item was removed (it used to come back). Nothing sent for a removed item brings it back: its versions are
 -- kept for old orders, its catalog_items row is gone. The same version with other content stays a refusal below.
 continue when exists(select 1 from public.catalog_versions where restaurant_id=rid and item_id=v->>'id' and version=(v->>'version')::int and snapshot=v)
  or (exists(select 1 from public.catalog_versions where restaurant_id=rid and item_id=v->>'id') and not exists(select 1 from public.catalog_items where restaurant_id=rid and id=v->>'id'));
 if jsonb_typeof(v->'name') is distinct from 'string' or jsonb_typeof(v->'category') is distinct from 'string' or jsonb_typeof(v->'price') is distinct from 'number' or jsonb_typeof(v->'active') is distinct from 'boolean'
 or jsonb_typeof(v->'recipe') is distinct from 'array' or jsonb_typeof(v->'modifiers') is distinct from 'array' then raise exception 'Invalid menu';end if;
 if length(v->>'name') not between 1 and 100 or length(v->>'category') not between 1 and 50 or (v->>'price')::numeric<>trunc((v->>'price')::numeric) or (v->>'price')::numeric not between 0 and 1000000000
 or (v->>'type' is not null and v->>'type' not in ('food','beverage','snack')) or (v->>'station' is not null and v->>'station' not in ('kitchen','bar')) or (v->>'lowAt')::int not between 0 and 999
 or jsonb_typeof(coalesce(v->'tags','[]'))<>'array' or jsonb_array_length(coalesce(v->'tags','[]'))>20 or jsonb_typeof(coalesce(v->'aliases','[]'))<>'array' or jsonb_array_length(coalesce(v->'aliases','[]'))>20
 or exists(select 1 from jsonb_array_elements_text(coalesce(v->'tags','[]')||coalesce(v->'aliases','[]')) t where coalesce(length(t),0) not between 1 and 50)
 or jsonb_typeof(coalesce(v->'groups','[]'))<>'array' or jsonb_array_length(coalesce(v->'groups','[]'))>10
 or exists(select 1 from jsonb_array_elements(coalesce(v->'groups','[]')) g where coalesce(length(g.value->>'id'),0)=0 or coalesce(length(g.value->>'name'),0) not between 1 and 50 or coalesce(g.value->>'kind','') not in ('add','swap','level','size')) then raise exception 'Invalid menu';end if;
 -- menu/F7: Safari and every iPhone or iPad browser cannot encode WebP from a canvas; the app saves a JPEG there.
 if v ? 'photo' and (jsonb_typeof(v->'photo')<>'string' or length(v->>'photo')>70000 or (v->>'photo' !~ '^data:image/(webp|jpeg);base64,[A-Za-z0-9+/=]+$' and v->>'photo' !~ '^https://images\.unsplash\.com/[A-Za-z0-9_./?=&%-]+$')) then raise exception 'Invalid menu photo';end if;
 perform public.validate_recipe(rid,v->'recipe');seen:='{}';
 for m in select value from jsonb_array_elements(v->'modifiers') loop
 if jsonb_typeof(m->'id') is distinct from 'string' or m->>'id'='' or jsonb_typeof(m->'name') is distinct from 'string' or jsonb_typeof(m->'price') is distinct from 'number' or jsonb_typeof(m->'recipe') is distinct from 'array' then raise exception 'Invalid modifier';end if;
 if m->>'id'=any(seen) or length(m->>'name') not between 1 and 100 or (m->>'price')::numeric<>trunc((m->>'price')::numeric) or (m->>'price')::numeric not between 0 and 1000000000
 or (m->>'group' is not null and not exists(select 1 from jsonb_array_elements(coalesce(v->'groups','[]')) g where g.value->>'id'=m->>'group')) then raise exception 'Invalid modifier';end if;
 seen:=array_append(seen,m->>'id');perform public.validate_recipe(rid,m->'recipe',true);end loop;
 if exists(select 1 from public.catalog_versions where restaurant_id=rid and item_id=v->>'id' and version=(v->>'version')::int and snapshot<>v) then raise exception 'Catalog version immutable';end if;
 if exists(select 1 from public.catalog_items where restaurant_id=rid and id=v->>'id' and version>(v->>'version')::int) then raise exception 'Stale catalog version';end if;
 if role in ('admin','chef') and (v->>'active')::boolean and jsonb_array_length(v->'recipe')=0 then unrecipied:=true;end if;
 insert into public.catalog_versions(restaurant_id,item_id,version,snapshot) values(rid,v->>'id',(v->>'version')::int,v) on conflict do nothing;
 insert into public.catalog_items values(rid,v->>'id',(v->>'version')::int) on conflict(restaurant_id,id) do update set version=excluded.version;
 end loop;
 -- MENU-7: a chef or admin publishing a NEW version of an active item with no recipe needs a manager's PIN; re-sending an accepted version does not.
 if unrecipied then perform public.use_approval(rid,actor,'publish',null,null,opid,at,(p->>'approval')::uuid);end if;
 else
 select * into s from public.shifts where restaurant_id=rid and closed_at is null for update;
 if selling then
 if s.id is null or at<s.opened_at or s.device_id<>device then raise exception 'No authorized shift for operation';end if;
 if s.actor<>actor and not (role in ('owner','manager') and k in ('shift.close','order.void','order.voidline')) then raise exception 'No authorized shift for operation';end if;
 if at>s.expires_at and k not in ('shift.close','order.void','order.voidline') and not (k='payment.record' and p->>'method'='cash') and not (k='order.prepare' and not coalesce((restaurant.settings->>'stationTablets')::boolean,false)) then raise exception 'No authorized shift for operation';end if;
 -- TILL-08 (decision 15): a cash payment is accepted after the 12 hours, and in the pilot (no station tablets) the till sends the lines with the payment, so that prepare is too.
 end if;
 if k='order.save' then
 doc:=p->'order';if not (doc ?& array['id','shiftId','restaurantId','actor','cashier','revision','status','mode','label','discount','discountReason','settings','receiptId','prep','createdAt','lines','totals']) then raise exception 'Missing order fields';end if;oid:=(doc->>'id')::uuid;
 select * into o from public.orders where restaurant_id=rid and id=oid for update;
 if coalesce(o.revision,0)<>(p->>'expectedRevision')::int or o.status is not null and o.status<>'open' then raise exception 'Order revision/state conflict';end if;
 if (doc->>'shiftId')::uuid<>s.id or doc->>'restaurantId'<>rid::text or doc->>'actor'<>actor::text or doc->>'cashier'<>s.cashier or (doc->>'revision')::int<>coalesce(o.revision,0)+1 or doc->>'status'<>'open' or coalesce(doc->>'mode','') not in ('dinein','takeaway','compliment') or length(doc->>'label')>106 or length(doc::text)>4000000 or (doc ? 'name' and coalesce(length(trim(doc->>'name')),0) not between 1 and 60) then raise exception 'Invalid order';end if;
 -- Compliment: a staff meal or the owner's family, named; priced by rule below, so it needs no manager's PIN.
 if (doc->>'mode'='compliment')<>(doc ? 'compliment') or (doc ? 'compliment' and (coalesce(doc->'compliment'->>'kind','') not in ('staff','family') or jsonb_typeof(doc->'compliment'->'who') is distinct from 'string' or coalesce(length(trim(doc->'compliment'->>'who')),0) not between 1 and 60)) or (doc->>'mode'='compliment' and (doc ? 'discountId' or doc ? 'discountRule')) then raise exception 'Invalid compliment';end if;
 if o.id is null then
 -- The order keeps the till's copy of the settings, and the server reads only tax, service and packaging from it, so only
 -- those must match: the current values, or (HARNESS-F2) any set in force since this shift opened, kept in retired_pricing
 -- by settings.update, so a settings save on another device mid-shift never turns the till's next order down.
 if not exists(select 1 from (select restaurant.settings->'taxBps' as tax,restaurant.settings->'serviceBps' as service,coalesce(restaurant.settings->'packaging','[]'::jsonb) as packaging
  union all select e.value->'taxBps',e.value->'serviceBps',coalesce(e.value->'packaging','[]'::jsonb) from jsonb_array_elements(restaurant.retired_pricing) e where (e.value->>'until')::timestamptz>=s.opened_at) x
  where x.tax=doc->'settings'->'taxBps' and x.service=doc->'settings'->'serviceBps' and x.packaging=coalesce(doc->'settings'->'packaging','[]'::jsonb)) or doc->>'receiptId'<>'MJ-'||upper(opid::text) or doc->>'prep'<>'new' or (doc->>'createdAt')::timestamptz<>at then raise exception 'Invalid initial snapshot';end if;
 else
 if (doc->'settings')-'discounts'<>(o.snapshot->'settings')-'discounts' or doc->>'receiptId'<>o.snapshot->>'receiptId' or doc->>'createdAt'<>o.snapshot->>'createdAt' then raise exception 'Historical snapshot changed';end if;
 -- A station may have marked a sent line ready meanwhile: that flag is the server's, not the till's.
 for oldline in select value from jsonb_array_elements(o.snapshot->'lines') where (value->>'prepared')::boolean loop
 if not exists(select 1 from jsonb_array_elements(doc->'lines') where value-'readyAt'=oldline-'readyAt') then raise exception 'Prepared line immutable';end if;end loop;
 end if;
 doc:=doc-'discountApprovedBy'-'discountApproved';
 -- The till's word on a discount must have the right shape before anything compares it: a JSON null or a wrong type
 -- would make the comparisons below unknown and skip the PIN (SQL-01). The reason is capped far above the 60 the till allows.
 if jsonb_typeof(doc->'discount') is distinct from 'number' or jsonb_typeof(doc->'discountReason') is distinct from 'string' or length(doc->>'discountReason')>300 or (doc ? 'discountId' and (jsonb_typeof(doc->'discountId') is distinct from 'string' or doc ? 'discountRule')) then raise exception 'Invalid discount';end if;
 -- A manual discount keeps its rule (TILL-02): the till re-prices it as the lines change, and the amount must be the rule
 -- applied to the lines (checked after the line loop, like a saved discount). The web app deployed before this sends none.
 rule:=doc->'discountRule';
 if rule is not null and (jsonb_typeof(rule)<>'object' or coalesce(rule->>'kind','') not in ('percent','amount') or jsonb_typeof(rule->'value') is distinct from 'number' or (rule->>'value')::numeric<>floor((rule->>'value')::numeric) or (rule->>'value')::numeric not between 1 and case when rule->>'kind'='percent' then 100 else 1000000000 end
  or coalesce(rule->>'scope','') not in ('order','food','beverage','snack','items') or (rule->>'scope'='items')<>(rule ? 'items') or (rule ? 'items' and (jsonb_typeof(rule->'items') is distinct from 'array' or jsonb_array_length(rule->'items') not between 1 and 500 or exists(select 1 from jsonb_array_elements(rule->'items') i where jsonb_typeof(i.value)<>'string')))
  or rule-'kind'-'value'-'scope'-'items'<>'{}'::jsonb or length(trim(doc->>'discountReason'))=0) then raise exception 'Invalid discount rule';end if;
 -- An approval covers a discount up to the amount approved (DSC-2, TILL-05): the amount is kept on the order as
 -- discountApproved, so a re-priced amount under it needs nothing more and a higher one asks again. The approval the till
 -- brought is used for its own amount when that is enough; the legacy manual path below still binds it to the exact amount.
 approved:=case when role in ('owner','manager') then (doc->>'discount')::bigint else coalesce((select a.amount from public.approvals a where a.id=(p->>'approval')::uuid and a.restaurant_id=rid and a.requested_by=actor and a.action='discount' and a.operation_id is null and a.amount>=(doc->>'discount')::bigint),(doc->>'discount')::bigint) end;
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
 -- Grown past what was approved: the new till brings a new approval, which is used; the web app deployed before this
 -- brings none and is still accepted (public.discounts_strict() turns that down once every till runs the new one).
 if coalesce((saved->>'approval')::boolean,false) and (doc->>'discountId' is distinct from o.snapshot->>'discountId' or ((p ? 'approval' or public.discounts_strict()) and (doc->>'discount')::bigint>coalesce((o.snapshot->>'discountApproved')::bigint,(doc->>'discount')::bigint))) then
 doc:=doc||jsonb_build_object('discountApprovedBy',case when role in ('owner','manager') then (select name from public.memberships where restaurant_id=rid and user_id=actor) else public.use_approval(rid,actor,'discount',null,approved,opid,at,(p->>'approval')::uuid) end,'discountApproved',approved);
 elsif o.snapshot ? 'discountApprovedBy' and doc->>'discountId' is not distinct from o.snapshot->>'discountId' then doc:=doc||jsonb_strip_nulls(jsonb_build_object('discountApprovedBy',o.snapshot->'discountApprovedBy','discountApproved',o.snapshot->'discountApproved'));
 end if;
 elsif rule is not null then
 -- The same rule within the amount last approved carries its approval; a rupiah rule only while the order did not shrink
 -- (fewer lines would make the approved amount a bigger share). Another rule, or more, is another discount.
 if rule=o.snapshot->'discountRule' and (doc->>'discount')::bigint<=coalesce((o.snapshot->>'discountApproved')::bigint,0) and (rule->>'kind'='percent' or (doc->'totals'->>'subtotal')::bigint>=(o.snapshot->'totals'->>'subtotal')::bigint) then
 doc:=doc||jsonb_strip_nulls(jsonb_build_object('discountApprovedBy',o.snapshot->'discountApprovedBy','discountApproved',o.snapshot->'discountApproved'));
 elsif (doc->>'discount')::bigint>0 then
 doc:=doc||jsonb_build_object('discountApprovedBy',case when role in ('owner','manager') then (select name from public.memberships where restaurant_id=rid and user_id=actor) else public.use_approval(rid,actor,'discount',null,approved,opid,at,(p->>'approval')::uuid) end,'discountApproved',approved);
 end if;
 elsif doc->>'mode'<>'compliment' and ((doc->>'discount')::bigint<>(case when o.snapshot->>'mode'='compliment' then 0 else coalesce((o.snapshot->>'discount')::bigint,0) end) or (public.discounts_strict() and (doc->>'discount')::bigint>0 and (doc->'totals'->>'subtotal')::bigint<(o.snapshot->'totals'->>'subtotal')::bigint)) then
 if length(trim(doc->>'discountReason'))=0 then raise exception 'Discount requires manager and reason';end if;
 doc:=doc||jsonb_build_object('discountApprovedBy',case when role in ('owner','manager') then (select name from public.memberships where restaurant_id=rid and user_id=actor) else public.use_approval(rid,actor,'discount',null,(doc->>'discount')::bigint,opid,at,(p->>'approval')::uuid) end,'discountApproved',(doc->>'discount')::bigint);
 elsif doc->>'mode'<>'compliment' and o.snapshot ? 'discountApprovedBy' and o.snapshot->>'mode'<>'compliment' then doc:=doc||jsonb_strip_nulls(jsonb_build_object('discountApprovedBy',o.snapshot->'discountApprovedBy','discountApproved',o.snapshot->'discountApproved'));
 end if;
 if jsonb_typeof(doc->'lines') is distinct from 'array' or jsonb_array_length(doc->'lines') not between 1 and 200 then raise exception 'Invalid line count';end if;seen:='{}';prepared:='[]';
 for l in select value from jsonb_array_elements(doc->'lines') loop
 if not (l ?& array['id','itemId','name','price','qty','modifiers','note','recipe','catalogVersion','prepared','cancelled']) then raise exception 'Missing line fields';end if;
 -- SQL-04, SQL-15: the line's fields have their types. A NULL test never raises, so a 'prepared' that is not a boolean used to pass every check below it.
 if jsonb_typeof(l->'prepared') is distinct from 'boolean' or jsonb_typeof(l->'cancelled') is distinct from 'boolean' or jsonb_typeof(l->'qty') is distinct from 'number' or jsonb_typeof(l->'price') is distinct from 'number'
 or (l->>'qty')::numeric<>trunc((l->>'qty')::numeric) or (l->>'qty')::numeric not between 1 and 999 then raise exception 'Invalid line fields';end if;
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
 if rule is not null and (doc->>'discount')::bigint<>public.saved_discount(rid,doc->'lines',rule) then raise exception 'Invalid manual discount';end if;
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
 -- STN-03: the bump marks only what the ticket showed. The current client names the lines (p->'lines', ids); the one before it sent
 -- none, and then only lines prepared at or before the bump's own time count (a second round sent after it is still to be made).
 if p ? 'lines' and (jsonb_typeof(p->'lines')<>'array' or jsonb_array_length(p->'lines')>500 or exists(select 1 from jsonb_array_elements(p->'lines') x where jsonb_typeof(x.value)<>'string')) then raise exception 'Invalid ready lines';end if;
 -- Paid orders still have tickets to serve (pay at the counter, then make). A void or refunded one is simply done.
 if o.status in ('open','paid') then
 doc:=o.snapshot;
 if st is null and exists(select 1 from jsonb_array_elements(doc->'lines') where not (value->>'prepared')::boolean) then raise exception 'Prepare all lines first';end if;
 prepared:='[]';
 for l in select value from jsonb_array_elements(doc->'lines') loop
 if (l->>'prepared')::boolean and not (l->>'cancelled')::boolean and not (l ? 'readyAt') and (st is null or coalesce(l->>'station','kitchen')=st) and (case when p ? 'lines' then p->'lines' ? (l->>'id') else coalesce((l->>'preparedAt')::timestamptz,at)<=at end) then l:=l||jsonb_build_object('readyAt',operation->>'occurredAt');end if;
 prepared:=prepared||jsonb_build_array(l);end loop;
 doc:=doc||jsonb_build_object('lines',prepared,'prep',public.prep_state(prepared));
 update public.orders set snapshot=doc,received_at=now() where restaurant_id=rid and id=oid;
 end if;
 elsif k='order.voidline' then
 -- One made line off an open or paid order: manager's PIN, reason on the line, totals recomputed. On a paid order the
 -- cashier voids the difference on the EDC too; the settlement then expects the new total.
 oid:=(p->>'id')::uuid;select * into o from public.orders where restaurant_id=rid and id=oid for update;
 if o.id is null or o.shift_id<>s.id or o.revision is distinct from (p->>'expectedRevision')::int then raise exception 'Order revision conflict';end if;
 if o.status not in ('open','paid') or coalesce(length(public.trim_reason(p->>'reason')),0) not between 1 and 300
 or not exists(select 1 from jsonb_array_elements(o.snapshot->'lines') x where x.value->>'id'=p->>'lineId' and (x.value->>'prepared')::boolean and not (x.value->>'cancelled')::boolean)
 or (select count(*) from jsonb_array_elements(o.snapshot->'lines') x where not (x.value->>'cancelled')::boolean)<2 then raise exception 'Invalid line void';end if;
 select public.line_value(x.value) into lv from jsonb_array_elements(o.snapshot->'lines') x where x.value->>'id'=p->>'lineId';
 -- The approval is bound to this order, this line and its value ('voidline'). The web app deployed before this asked as 'void'
 -- with no amount, which binds the order only (SEC-1): still accepted until public.voids_strict() is flipped.
 if role in ('owner','manager') then approver:=(select name from public.memberships where restaurant_id=rid and user_id=actor);
 else vnew:=public.voids_strict() or coalesce((select a.action from public.approvals a where a.id=(p->>'approval')::uuid)='voidline',false);
 approver:=public.use_approval(rid,actor,case when vnew then 'voidline' else 'void' end,oid,case when vnew then lv end,opid,at,(p->>'approval')::uuid,case when vnew then (p->>'lineId')::uuid end);end if;
 prepared:='[]';
 for l in select value from jsonb_array_elements(o.snapshot->'lines') loop
 if l->>'id'=p->>'lineId' then l:=l||jsonb_build_object('cancelled',true,'voidReason',public.trim_reason(p->>'reason'),'voidApprovedBy',approver);update public.order_lines set snapshot=l where restaurant_id=rid and order_id=oid and id=(l->>'id')::uuid;end if;
 prepared:=prepared||jsonb_build_array(l);end loop;
 doc:=o.snapshot||jsonb_build_object('lines',prepared);
 -- The discount follows the lines left by its own rule: a compliment's, a saved discount's as the ORDER was priced with it (the
 -- definition in the order's own copy of the settings, not today's), a manual discount's rule, else the amount it had. A void
 -- never raises what the guest owes: at least what the old discount had less the voided line, at most the old discount and the
 -- subtotal left (CT-02, SQL-08, DSC-4, TILL-13). The till does the same sum (afterVoid in src/domain/calculate.ts).
 vold:=coalesce((o.snapshot->>'discount')::bigint,0);
 vown:=case when doc->>'mode'='compliment' then public.compliment_discount(rid,prepared,doc->'compliment'->>'kind')
  when doc ? 'discountId' then coalesce((select public.saved_discount(rid,prepared,d.value) from jsonb_array_elements(case when jsonb_typeof(o.snapshot->'settings'->'discounts')='array' then o.snapshot->'settings'->'discounts' else '[]'::jsonb end) d where d.value->>'id'=doc->>'discountId' limit 1),vold)
  when jsonb_typeof(doc->'discountRule')='object' then public.saved_discount(rid,prepared,doc->'discountRule')
  else vold end;
 doc:=doc||jsonb_build_object('discount',greatest(0,least((public.order_total(doc||'{"discount":0}')->>'subtotal')::bigint,vold,greatest(vown,vold-lv))));
 doc:=doc||jsonb_build_object('totals',public.order_total(doc),'revision',o.revision+1,'updatedAt',operation->>'occurredAt');
 update public.orders set revision=o.revision+1,updated_at=at,received_at=now(),snapshot=doc where restaurant_id=rid and id=oid;
 elsif k in ('order.prepare','order.void','payment.record','refund.record') then
 oid:=(p->>'id')::uuid;select * into o from public.orders where restaurant_id=rid and id=oid for update;
 if o.id is null or o.shift_id<>s.id or o.revision is distinct from (p->>'expectedRevision')::int then raise exception 'Order revision conflict';end if;
 if k='refund.record' then
 if o.status<>'paid' or length(trim(p->>'reason'))=0 then raise exception 'Invalid refund';end if;
 approver:=case when role in ('owner','manager') then (select name from public.memberships where restaurant_id=rid and user_id=actor) else public.use_approval(rid,actor,'refund',oid,null,opid,at,(p->>'approval')::uuid) end;
 insert into public.refunds values(rid,oid,opid,(o.snapshot->'totals'->>'total')::bigint,p->>'reason',actor,at,now());
 doc:=o.snapshot||jsonb_build_object('status','refunded','refund',jsonb_build_object('reason',p->>'reason','at',operation->>'occurredAt','actor',actor,'approvedBy',approver));
 else
 if o.status<>'open' then raise exception 'Order is not open';end if;
 doc:=o.snapshot;
 if k='order.prepare' then
 if jsonb_typeof(p->'lineIds') is distinct from 'array' or jsonb_array_length(p->'lineIds')=0 then raise exception 'No new preparation lines';end if;prepared:='[]';
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
 if (select count(*) from public.preparations where restaurant_id=rid and order_id=oid and operation_id=opid)<>jsonb_array_length(p->'lineIds') then raise exception 'Unknown preparation line';end if;
 doc:=doc||jsonb_build_object('lines',prepared,'prep',public.prep_state(prepared));
 elsif k='order.void' then
 if length(trim(p->>'reason'))=0 then raise exception 'Void reason required';end if;
 -- The approval is bound to the order's total (SEC-1); the older web app's has no amount and is still accepted until voids_strict().
 approver:=case when role in ('owner','manager') then (select name from public.memberships where restaurant_id=rid and user_id=actor) else public.use_approval(rid,actor,'void',oid,
  case when public.voids_strict() or (select a.amount from public.approvals a where a.id=(p->>'approval')::uuid) is not null then (o.snapshot->'totals'->>'total')::bigint end,opid,at,(p->>'approval')::uuid) end;
 doc:=doc||jsonb_build_object('status','void','voidReason',p->>'reason','voidApprovedBy',approver);
 elsif k='payment.record' then
 if exists(select 1 from jsonb_array_elements(doc->'lines') where not coalesce((value->>'prepared')::boolean,false)) then raise exception 'Prepare before payment';end if;
 total:=public.order_total(doc);amount:=(total->>'total')::bigint;
 if coalesce(p->>'method','') not in ('cash','qris','card','none') or (p->>'method' in ('qris','card') and not coalesce((p->>'verified')::boolean,false)) then raise exception 'Online merchant verification required';end if;
 -- Cashless: card or QRIS on a named EDC, approval code from the slip optional; a free compliment pays 'none'.
 if (p->>'method'='none' and amount<>0) or (p->>'method'<>'none' and amount=0 and doc->>'mode'='compliment') then raise exception 'Invalid payment method';end if;
 if p->>'method'='cash' and coalesce((restaurant.settings->>'cashless')::boolean,false) then raise exception 'Cashless outlet';end if;
 if (p ? 'edc' and p->>'method' not in ('qris','card')) or coalesce(length(p->>'edc'),0)>30 or coalesce(length(p->>'approvalCode'),0)>30
 or (p->>'method' in ('qris','card') and (coalesce((restaurant.settings->>'cashless')::boolean,false) or jsonb_array_length(coalesce(restaurant.settings->'edcs','[]'))>0) and coalesce(length(trim(p->>'edc')),0)=0) then raise exception 'EDC required';end if;
 -- SQL-15: a named machine is one the store knows: in the settings now (a cashless store with none listed has the till's three defaults, see tills() in calculate.ts), or one that already took a payment in this shift (a machine removed mid-shift is still honest).
 if coalesce(length(trim(p->>'edc')),0)>0 and not exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(restaurant.settings->'edcs')='array' and jsonb_array_length(restaurant.settings->'edcs')>0 then restaurant.settings->'edcs' when coalesce((restaurant.settings->>'cashless')::boolean,false) then '["BCA","BRI","Mandiri"]'::jsonb else '[]'::jsonb end) e where trim(e)=trim(p->>'edc'))
 and not exists(select 1 from public.payments pay join public.orders ord on ord.restaurant_id=pay.restaurant_id and ord.id=pay.order_id where ord.restaurant_id=rid and ord.shift_id=s.id and pay.edc=trim(p->>'edc')) then raise exception 'Unknown EDC';end if;
 cost:=case when p->>'method'='cash' then coalesce((p->>'tendered')::bigint,-1) else amount end;
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
 -- SQL-15, SQL-16: only the kinds the Stok page and Takar Stok send (preparation keeps its own message); null, string or
 -- absent amounts are refused; a reason is capped far above the 200 the screens allow.
 if p->>'kind'='preparation' then raise exception 'Preparation must use order operation';end if;
 if p->>'kind' is null or p->>'kind' not in ('opening','purchase','waste','count','adjustment') then raise exception 'Invalid stock kind';end if;
 if coalesce(length(trim(p->>'reason')),0)=0 then raise exception 'Reason required';end if;
 if length(p->>'reason')>2000 then raise exception 'Reason too long';end if;
 if jsonb_typeof(p->'qty') is distinct from 'number' or jsonb_typeof(p->'cost') is distinct from 'number' then raise exception 'Invalid stock amount';end if;
 qty:=(p->>'qty')::bigint;cost:=(p->>'cost')::bigint;if cost not between 0 and 1000000000 or abs(qty)>1000000000000 then raise exception 'Invalid stock amount';end if;
 if p->>'kind' in ('opening','purchase') and qty<=0 or p->>'kind'='count' and qty<0 then raise exception 'Invalid stock quantity';end if;
 if p->>'photo' is not null and (length(p->>'photo')>70000 or p->>'photo' !~ '^data:image/(webp|jpeg);base64,[A-Za-z0-9+/=]+$') then raise exception 'Invalid photo';end if;
 if p->>'kind'='purchase' then insert into public.purchases(restaurant_id,id,stock_id,qty,cost,reason,actor,occurred_at,photo) values(rid,opid,p->>'stockId',qty,cost,p->>'reason',actor,at,p->>'photo');end if;
 -- CT-01: a count measures the shelf when it was taken, so the gap is against the movements up to then.
 if p->>'kind'='count' then select coalesce(sum(sm.qty),0) into balance from public.stock_movements sm where restaurant_id=rid and stock_id=p->>'stockId' and occurred_at<=at;qty:=qty-balance;end if;
 if p->>'kind'='waste' then qty:=-abs(qty);end if;
 insert into public.stock_movements values(rid,opid::text,p->>'stockId',qty,p->>'kind',p->>'reason',actor,at,now(),opid::text,opid,cost);
 if (p->>'fromDrawer')::boolean then
 if s.id is null or s.actor<>actor or p->>'kind'<>'purchase' or (p->>'shiftId')::uuid<>s.id then raise exception 'Cash purchase requires active shift';end if;
 insert into public.cash_movements values(rid,opid,s.id,-cost,'Pembelian: '||(p->>'reason'),actor,at,opid);end if;
 elsif k='count.record' then
 -- CNT-3: one approved count = one movement per line that differs, plus the record for the variance report.
 if coalesce(length(trim(p->>'area')),0)=0 or length(p->>'area')>50 or jsonb_typeof(p->'lines')<>'array' or jsonb_array_length(p->'lines') not between 1 and 1000 then raise exception 'Invalid count';end if;
 select * into waiting from public.counts where restaurant_id=rid and id=(p->>'id')::uuid;
 -- STK-02: a count approved already (this device had not heard) is answered and left alone: nothing is booked twice, no outbox halts.
 if waiting.status='approved' then return jsonb_build_object('id',opid,'receivedAt',now());end if;
 -- SEC-1: with a manager's PIN the lines are the ones the manager was shown (count.submit's; the reasons may differ). Anything
 -- else is answered too, and the count keeps waiting: no honest client sends it, and a refusal would halt that device.
 if role not in ('owner','manager') and waiting.status='submitted' and (select coalesce(jsonb_agg(jsonb_build_object('s',x->>'stockId','c',x->'counted') order by x->>'stockId'),'[]') from jsonb_array_elements(p->'lines') x) is distinct from (select coalesce(jsonb_agg(jsonb_build_object('s',x->>'stockId','c',x->'counted') order by x->>'stockId'),'[]') from jsonb_array_elements(waiting.lines) x) then return jsonb_build_object('id',opid,'receivedAt',now());end if;
 approver:=case when role in ('owner','manager') then (select name from public.memberships where restaurant_id=rid and user_id=actor) else public.use_approval(rid,actor,'count',(p->>'id')::uuid,null,opid,at,(p->>'approval')::uuid) end;
 prepared:='[]';seen:='{}';
 for l in select value from jsonb_array_elements(p->'lines') loop
 if jsonb_typeof(l)<>'object' or jsonb_typeof(l->'counted') is distinct from 'number' then raise exception 'Invalid count line';end if;
 if l->>'stockId'=any(seen) or (l->>'counted')::numeric<>trunc((l->>'counted')::numeric) or (l->>'counted')::bigint not between 0 and 1000000000000 or coalesce(length(l->>'reason'),0)>200 or not exists(select 1 from public.inventory_items where restaurant_id=rid and id=l->>'stockId') then raise exception 'Invalid count line';end if;
 seen:=array_append(seen,l->>'stockId');
 -- CT-01, SQL-03, STK-01, STN-01: a count measures the shelf when it was taken: the line's own time, else the submit's, else
 -- this record's. The gap is against the movements up to then and the movement is stamped then, so what moved since stays.
 select value into wl from jsonb_array_elements(coalesce(waiting.lines,'[]')) where value->>'stockId'=l->>'stockId';
 lt:=coalesce((wl->>'at')::timestamptz,case when waiting.status='submitted' then waiting.occurred_at end,at);
 select coalesce(sum(sm.qty),0) into balance from public.stock_movements sm where restaurant_id=rid and stock_id=l->>'stockId' and occurred_at<=lt;
 qty:=(l->>'counted')::bigint-balance;
 insert into public.stock_movements values(rid,opid::text||'-'||(l->>'stockId'),l->>'stockId',qty,'count','Hitung '||trim(p->>'area')||coalesce(': '||nullif(trim(l->>'reason'),''),''),actor,lt,now(),p->>'id',opid,0);
 -- Two counts of one bahan waiting at once and the later one approved first: its movement was the gap against a shelf that did
 -- not yet hold this gap, so it shrinks by it and the later count still comes out at what it counted. Only the next count
 -- movement: the ones after it were measured against that one. Re-stamped so pull sends the corrected row to every device.
 amount:=qty;if amount<>0 then update public.stock_movements m set qty=m.qty-amount,received_at=now() where m.restaurant_id=rid and m.id=(select id from public.stock_movements where restaurant_id=rid and stock_id=l->>'stockId' and kind='count' and occurred_at>lt order by occurred_at limit 1);end if;
 prepared:=prepared||jsonb_build_array(jsonb_build_object('stockId',l->>'stockId','expected',balance,'counted',(l->>'counted')::bigint,'reason',coalesce(l->>'reason',''),'at',public.iso(lt)));
 end loop;
 insert into public.counts(restaurant_id,id,area,actor,approver,lines,status,occurred_at,operation_id) values(rid,(p->>'id')::uuid,trim(p->>'area'),actor,approver,prepared,'approved',at,opid)
 on conflict(restaurant_id,id) do update set area=excluded.area,actor=excluded.actor,approver=excluded.approver,lines=excluded.lines,status='approved',occurred_at=excluded.occurred_at,received_at=now(),operation_id=excluded.operation_id;
 elsif k='count.submit' then
 -- CNT-1: a count submitted on a tablet waits here for a manager's approval, on any paired device.
 if coalesce(length(trim(p->>'area')),0)=0 or length(p->>'area')>50 or jsonb_typeof(p->'lines')<>'array' or jsonb_array_length(p->'lines') not between 1 and 1000 then raise exception 'Invalid count';end if;
 -- STK-03: sent again after a manager approved it elsewhere (a recount on a till that had not heard), it is answered and ignored.
 select * into waiting from public.counts where restaurant_id=rid and id=(p->>'id')::uuid;
 if waiting.status='approved' then return jsonb_build_object('id',opid,'receivedAt',now());end if;
 -- SQL-15: the lines are checked as count.record checks them. Each is stored with the balance at the time it was counted
 -- (CT-01: the review on any device shows that, and the approval books the gap against it); a line sent again unchanged (a
 -- recount of the other lines) keeps its earlier time.
 prepared:='[]';seen:='{}';
 for l in select value from jsonb_array_elements(p->'lines') loop
 if jsonb_typeof(l)<>'object' or jsonb_typeof(l->'counted') is distinct from 'number' then raise exception 'Invalid count line';end if;
 if l->>'stockId'=any(seen) or (l->>'counted')::numeric<>trunc((l->>'counted')::numeric) or (l->>'counted')::bigint not between 0 and 1000000000000 or coalesce(length(l->>'reason'),0)>200 or not exists(select 1 from public.inventory_items where restaurant_id=rid and id=l->>'stockId') then raise exception 'Invalid count line';end if;
 seen:=array_append(seen,l->>'stockId');
 select value into wl from jsonb_array_elements(coalesce(waiting.lines,'[]')) where value->>'stockId'=l->>'stockId' and value->'counted'=l->'counted' and value->>'at' is not null;
 lt:=coalesce((wl->>'at')::timestamptz,at);
 select coalesce(sum(sm.qty),0) into balance from public.stock_movements sm where restaurant_id=rid and stock_id=l->>'stockId' and occurred_at<=lt;
 prepared:=prepared||jsonb_build_array(jsonb_build_object('stockId',l->>'stockId','counted',(l->>'counted')::bigint,'reason',coalesce(l->>'reason',''),'expected',balance,'at',coalesce(wl->>'at',operation->>'occurredAt')));
 end loop;
 insert into public.counts(restaurant_id,id,area,actor,approver,lines,status,occurred_at,operation_id) values(rid,(p->>'id')::uuid,trim(p->>'area'),actor,null,prepared,'submitted',at,opid)
 on conflict(restaurant_id,id) do update set area=excluded.area,lines=excluded.lines,occurred_at=excluded.occurred_at,received_at=now(),operation_id=excluded.operation_id;
 elsif k='shift.cash' then
 if (p->>'shiftId')::uuid is distinct from s.id or coalesce(length(trim(p->>'reason')),0) not between 1 and 1000 or coalesce((p->>'amount')::bigint,0)=0 or abs((p->>'amount')::bigint)>1000000000 then raise exception 'Invalid cash movement';end if;
 -- SQL-16: the reason is capped far above what the screen allows (300 in Commands.cashMove), so no honest till is turned down.
 if (p->>'amount')::bigint<0 and role not in ('owner','manager') then perform public.use_approval(rid,actor,'cashout',null,-(p->>'amount')::bigint,opid,at,(p->>'approval')::uuid);end if;
 insert into public.cash_movements values(rid,opid,s.id,(p->>'amount')::bigint,p->>'reason',actor,at,null);
 elsif k='shift.close' then
 if (p->>'id')::uuid is distinct from s.id then raise exception 'Not the open shift';end if;
 if exists(select 1 from public.orders where restaurant_id=rid and shift_id=s.id and status='open') then raise exception 'Open orders prevent closing';end if;
 -- SQL-02: the drawer is always counted (a cashless store sends 0): no number, no close, so the gap check below can never be skipped by leaving it out.
 if jsonb_typeof(p->'counted') is distinct from 'number' or (p->>'counted')::numeric<>trunc((p->>'counted')::numeric) or (p->>'counted')::numeric not between 0 and 1000000000 then raise exception 'Invalid count';end if;
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
