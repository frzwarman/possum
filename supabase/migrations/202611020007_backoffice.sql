-- Back office: purchase orders from suppliers and production of in-house items (sambal, ayam
-- ungkep, kaldu) from a per-batch recipe. Both are manager work and, like every write, go through
-- apply_operation on the primary till so stock stays in one order.
create table public.purchase_orders(
 restaurant_id uuid not null references public.restaurants(id),id uuid not null,revision integer not null check(revision>0),
 status text not null check(status in ('ordered','received','cancelled')),snapshot jsonb not null,
 created_at timestamptz not null,updated_at timestamptz not null,primary key(restaurant_id,id)
);
alter table public.purchase_orders enable row level security;
revoke all on public.purchase_orders from anon,authenticated;
grant select on public.purchase_orders to authenticated;
create policy manager_read on public.purchase_orders for select to authenticated using(public.member_role(restaurant_id) in ('owner','manager'));
-- A stock item made in-house carries its batch recipe: {inputs:[{stockId,qty}],output}.
alter table public.inventory_items add column production jsonb;
alter table public.stock_movements drop constraint stock_movements_kind_check;
alter table public.stock_movements add constraint stock_movements_kind_check check(kind in ('opening','purchase','waste','count','adjustment','preparation','production'));
-- Validates purchase lines ({stockId,qty,cost}: thousandths of the base unit, line total in rupiah) and returns their total.
create function public.purchase_total(rid uuid,lines jsonb) returns bigint language plpgsql set search_path='' as $$
declare l jsonb;seen text[]:='{}';total bigint:=0;begin
 if jsonb_typeof(lines)<>'array' or jsonb_array_length(lines) not between 1 and 100 then raise exception 'Invalid purchase lines';end if;
 for l in select value from jsonb_array_elements(lines) loop
  if l->>'stockId'=any(seen) or (l->>'qty')::numeric<>trunc((l->>'qty')::numeric) or (l->>'qty')::bigint not between 1 and 1000000000000
   or (l->>'cost')::numeric<>trunc((l->>'cost')::numeric) or (l->>'cost')::bigint not between 0 and 1000000000
   or not exists(select 1 from public.inventory_items where restaurant_id=rid and id=l->>'stockId') then raise exception 'Invalid purchase line';end if;
  seen:=array_append(seen,l->>'stockId');total:=total+(l->>'cost')::bigint;
 end loop;
 if total>1000000000 then raise exception 'Purchase total too large';end if;
 return total;
end $$;
revoke all on function public.purchase_total(uuid,jsonb) from public,anon,authenticated;

create or replace function public.apply_operation(operation jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 rid uuid:=(operation->>'restaurantId')::uuid;opid uuid:=(operation->>'id')::uuid;actor uuid:=auth.uid();device uuid:=(operation->>'deviceId')::uuid;k text:=operation->>'kind';p jsonb:=operation->'payload';at timestamptz:=(operation->>'occurredAt')::timestamptz;
 role text;canonical jsonb;previous public.sync_operations%rowtype;restaurant public.restaurants%rowtype;s public.shifts%rowtype;o public.orders%rowtype;
 doc jsonb;l jsonb;m jsonb;r jsonb;v jsonb;oldline jsonb;recipe jsonb;total jsonb;sid uuid;oid uuid;qty bigint;cost bigint;balance bigint;amount bigint;expected_value bigint;prepared jsonb;seen text[];result jsonb;approver text;po public.purchase_orders%rowtype;label text;
begin
 if actor is null or operation->>'actor' is distinct from actor::text then raise exception 'Authenticated actor mismatch' using errcode='42501';end if;
 role:=public.member_role(rid);if role is null then raise exception 'Membership denied' using errcode='42501';end if;
 select * into restaurant from public.restaurants where id=rid for update;
 canonical:=jsonb_build_object('kind',k,'payload',p,'actor',actor,'device',device,'occurredAt',at,'restaurant',rid);
 select * into previous from public.sync_operations where id=opid;
 if found then if previous.restaurant_id<>rid or previous.payload<>canonical then raise exception 'Operation ID reused with different payload';end if;return previous.result;end if;
 if not exists(select 1 from public.devices where restaurant_id=rid and id=device and revoked_at is null) then raise exception 'Device not enrolled';end if;
 if restaurant.primary_device_id is distinct from device then raise exception 'Primary cashier device required';end if;
 if at>now()+interval '2 minutes' or at<now()-interval '7 days' then raise exception 'Operation timestamp outside recovery window';end if;
 if k in ('catalog.publish','settings.update','refund.record','shift.open') and abs(extract(epoch from now()-at))>120 then raise exception 'Fresh online authorization required';end if;
 if k in ('catalog.publish','settings.update','stock.record','purchase.save','purchase.receive','purchase.cancel','purchase.pay','production.record') and role not in ('owner','manager') then raise exception 'Manager permission required' using errcode='42501';end if;
 if k='shift.open' then
 if exists(select 1 from public.shifts where restaurant_id=rid and closed_at is null) then raise exception 'Shift already open';end if;
 insert into public.shifts(restaurant_id,id,actor,device_id,opened_at,expires_at,opening,cashier,catalog) values(rid,(p->>'id')::uuid,actor,device,at,at+interval '12 hours',(p->>'opening')::bigint,(select name from public.memberships where restaurant_id=rid and user_id=actor),(select coalesce(jsonb_object_agg(id,version),'{}') from public.catalog_items where restaurant_id=rid));
 elsif k in ('catalog.publish','settings.update') then
 if k='settings.update' then
 doc:=p->'settings';
 if length(doc->>'name') not between 1 and 100 or length(doc->>'appName') not between 1 and 30 or (doc->>'cutoff')::int not between 0 and 23 or (doc->>'taxBps')::int not between 0 and 10000 or (doc->>'serviceBps')::int not between 0 and 10000 or (doc->>'receiptWidth')::int not in (58,80) or (doc->>'printableWidth')::int not between 32 and (doc->>'receiptWidth')::int-4 or not exists(select 1 from pg_timezone_names where name=doc->>'timezone') then raise exception 'Invalid restaurant settings';end if;
 perform (doc->>'goLive')::date;perform public.validate_recipe(rid,doc->'packaging');update public.restaurants set settings=doc where id=rid;
 else
 if jsonb_array_length(p->'menu')>500 or jsonb_array_length(p->'stock')>1000 then raise exception 'Catalog too large';end if;
 for v in select value from jsonb_array_elements(p->'stock') loop
 if length(v->>'name') not between 1 and 100 or (v->>'threshold')::numeric<>trunc((v->>'threshold')::numeric) then raise exception 'Invalid stock item';end if;
 if exists(select 1 from public.inventory_items where restaurant_id=rid and id=v->>'id' and unit<>v->>'unit') then raise exception 'Base unit is immutable';end if;
 insert into public.inventory_items(restaurant_id,id,name,unit,threshold,production) values(rid,v->>'id',v->>'name',v->>'unit',(v->>'threshold')::bigint,nullif(v->'production','null'::jsonb)) on conflict(restaurant_id,id) do update set name=excluded.name,threshold=excluded.threshold,production=excluded.production;
 end loop;
 -- Batch recipes are checked once every stock item exists: an input may be listed after its output.
 for v in select value from jsonb_array_elements(p->'stock') loop
 if nullif(v->'production','null'::jsonb) is not null then
 perform public.validate_recipe(rid,v->'production'->'inputs');
 if jsonb_array_length(v->'production'->'inputs')=0 or exists(select 1 from jsonb_array_elements(v->'production'->'inputs') i where i.value->>'stockId'=v->>'id')
 or (v->'production'->>'output')::numeric<>trunc((v->'production'->>'output')::numeric) or (v->'production'->>'output')::bigint not between 1 and 1000000000000 then raise exception 'Invalid production recipe';end if;
 end if;
 end loop;
 for v in select value from jsonb_array_elements(p->'menu') loop
 if length(v->>'name') not between 1 and 100 or length(v->>'category') not between 1 and 50 or (v->>'price')::numeric<>trunc((v->>'price')::numeric) then raise exception 'Invalid menu';end if;
 if v ? 'photo' and (length(v->>'photo')>70000 or v->>'photo' !~ '^data:image/webp;base64,[A-Za-z0-9+/=]+$') then raise exception 'Invalid menu photo';end if;
 perform public.validate_recipe(rid,v->'recipe');seen:='{}';
 for m in select value from jsonb_array_elements(v->'modifiers') loop
 if m->>'id'=any(seen) or length(m->>'name') not between 1 and 100 or (m->>'price')::numeric<>trunc((m->>'price')::numeric) or (m->>'price')::bigint not between 0 and 1000000000 then raise exception 'Invalid modifier';end if;seen:=array_append(seen,m->>'id');perform public.validate_recipe(rid,m->'recipe');end loop;
 if exists(select 1 from public.catalog_versions where restaurant_id=rid and item_id=v->>'id' and version=(v->>'version')::int and snapshot<>v) then raise exception 'Catalog version immutable';end if;
 if exists(select 1 from public.catalog_items where restaurant_id=rid and id=v->>'id' and version>(v->>'version')::int) then raise exception 'Stale catalog version';end if;
 insert into public.catalog_versions(restaurant_id,item_id,version,snapshot) values(rid,v->>'id',(v->>'version')::int,v) on conflict do nothing;
 insert into public.catalog_items values(rid,v->>'id',(v->>'version')::int) on conflict(restaurant_id,id) do update set version=excluded.version;
 end loop;
 end if;
 else
 select * into s from public.shifts where restaurant_id=rid and closed_at is null for update;
 if k not in ('stock.record','purchase.save','purchase.receive','purchase.cancel','purchase.pay','production.record') and (s.id is null or s.actor<>actor or s.device_id<>device or at<s.opened_at or (at>s.expires_at and k<>'shift.close')) then raise exception 'No authorized shift for operation';end if;
 if k='order.save' then
 doc:=p->'order';if not (doc ?& array['id','shiftId','restaurantId','actor','cashier','revision','status','mode','label','discount','discountReason','settings','receiptId','prep','createdAt','lines','totals']) then raise exception 'Missing order fields';end if;oid:=(doc->>'id')::uuid;
 select * into o from public.orders where restaurant_id=rid and id=oid for update;
 if coalesce(o.revision,0)<>(p->>'expectedRevision')::int or o.status is not null and o.status<>'open' then raise exception 'Order revision/state conflict';end if;
 if (doc->>'shiftId')::uuid<>s.id or doc->>'restaurantId'<>rid::text or doc->>'actor'<>actor::text or doc->>'cashier'<>s.cashier or (doc->>'revision')::int<>coalesce(o.revision,0)+1 or doc->>'status'<>'open' or doc->>'mode' not in ('dinein','takeaway') or length(doc->>'label')>100 then raise exception 'Invalid order';end if;
 if o.id is null then
 if doc->'settings'<>restaurant.settings or doc->>'receiptId'<>'MJ-'||upper(opid::text) or doc->>'prep'<>'new' or (doc->>'createdAt')::timestamptz<>at then raise exception 'Invalid initial snapshot';end if;
 else
 if doc->'settings'<>o.snapshot->'settings' or doc->>'receiptId'<>o.snapshot->>'receiptId' or doc->>'createdAt'<>o.snapshot->>'createdAt' or doc->>'prep'<>o.snapshot->>'prep' then raise exception 'Historical snapshot changed';end if;
 for oldline in select value from jsonb_array_elements(o.snapshot->'lines') where (value->>'prepared')::boolean loop
 if not exists(select 1 from jsonb_array_elements(doc->'lines') where value=oldline) then raise exception 'Prepared line immutable';end if;end loop;
 end if;
 doc:=doc-'discountApprovedBy';
 if (doc->>'discount')::bigint<>coalesce((o.snapshot->>'discount')::bigint,0) then
 if length(trim(doc->>'discountReason'))=0 then raise exception 'Discount requires manager and reason';end if;
 doc:=doc||jsonb_build_object('discountApprovedBy',case when role in ('owner','manager') then (select name from public.memberships where restaurant_id=rid and user_id=actor) else public.use_approval(rid,actor,'discount',null,(doc->>'discount')::bigint,opid,at,(p->>'approval')::uuid) end);
 elsif o.snapshot ? 'discountApprovedBy' then doc:=doc||jsonb_build_object('discountApprovedBy',o.snapshot->'discountApprovedBy');
 end if;
 if jsonb_array_length(doc->'lines') not between 1 and 200 then raise exception 'Invalid line count';end if;seen:='{}';
 for l in select value from jsonb_array_elements(doc->'lines') loop
 if not (l ?& array['id','itemId','name','price','qty','modifiers','note','recipe','catalogVersion','prepared','cancelled']) then raise exception 'Missing line fields';end if;
 if l->>'id'=any(seen) or (l->>'cancelled')::boolean or length(l->>'note')>300 then raise exception 'Invalid/duplicate line';end if;seen:=array_append(seen,l->>'id');
 select snapshot into v from public.catalog_versions where restaurant_id=rid and item_id=l->>'itemId' and version=(l->>'catalogVersion')::int;
 if v is null or not (v->>'active')::boolean or (v->>'soldOut')::boolean or l->>'name'<>v->>'name' or l->'price'<>v->'price' or l->'recipe'<>v->'recipe' then raise exception 'Catalog snapshot mismatch';end if;
 if (s.catalog->>(l->>'itemId'))::int is distinct from (l->>'catalogVersion')::int and not exists(select 1 from public.catalog_items where restaurant_id=rid and id=l->>'itemId' and version=(l->>'catalogVersion')::int) then raise exception 'Version not authorized for shift';end if;
 if (select count(*) from jsonb_array_elements(l->'modifiers'))<>(select count(distinct value->>'id') from jsonb_array_elements(l->'modifiers')) then raise exception 'Duplicate modifier';end if;
 for m in select value from jsonb_array_elements(l->'modifiers') loop if not exists(select 1 from jsonb_array_elements(v->'modifiers') where value=m) then raise exception 'Modifier snapshot mismatch';end if;end loop;
 if (l->>'prepared')::boolean and not exists(select 1 from public.preparations where restaurant_id=rid and order_id=oid and line_id=(l->>'id')::uuid) then raise exception 'Preparation not recorded';end if;
 end loop;
 total:=public.calculate_total(doc->'lines',(doc->>'discount')::bigint,doc->'settings');if total<>doc->'totals' then raise exception 'Client total mismatch';end if;
 if doc ? 'payment' or doc ? 'refund' then raise exception 'Financial fields require separate operation';end if;
 insert into public.orders(restaurant_id,id,shift_id,actor,revision,status,created_at,updated_at,snapshot) values(rid,oid,s.id,actor,(doc->>'revision')::int,'open',(doc->>'createdAt')::timestamptz,at,doc) on conflict(restaurant_id,id) do update set revision=excluded.revision,updated_at=excluded.updated_at,snapshot=excluded.snapshot;
 delete from public.order_lines where restaurant_id=rid and order_id=oid and not ((snapshot->>'prepared')::boolean);
 for l in select value from jsonb_array_elements(doc->'lines') loop insert into public.order_lines values(rid,oid,(l->>'id')::uuid,l->>'itemId',(l->>'catalogVersion')::int,l) on conflict do nothing;end loop;
 elsif k in ('order.prepare','order.ready','order.void','payment.record','refund.record') then
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
 recipe:=l->'recipe';for m in select value from jsonb_array_elements(l->'modifiers') loop recipe:=recipe||(m->'recipe');end loop;
 if doc->>'mode'='takeaway' then recipe:=recipe||(doc->'settings'->'packaging');end if;
 for r in select value from jsonb_array_elements(recipe) loop
 qty:=-((r->>'qty')::bigint*(l->>'qty')::bigint);
 insert into public.stock_movements values(rid,opid::text||'-'||(r->>'stockId'),r->>'stockId',qty,'preparation','Persiapan '||coalesce(nullif(doc->>'label',''),doc->>'receiptId'),actor,at,now(),oid::text,opid,0)
 on conflict(restaurant_id,id) do update set qty=public.stock_movements.qty+excluded.qty;
 end loop;
 l:=l||'{"prepared":true}'::jsonb;update public.order_lines set snapshot=l where restaurant_id=rid and order_id=oid and id=(l->>'id')::uuid;
 end if;prepared:=prepared||jsonb_build_array(l);end loop;
 if (select count(*) from public.preparations where restaurant_id=rid and operation_id=opid)<>jsonb_array_length(p->'lineIds') then raise exception 'Unknown preparation line';end if;
 doc:=doc||jsonb_build_object('lines',prepared,'prep','preparing');
 elsif k='order.ready' then
 if exists(select 1 from jsonb_array_elements(doc->'lines') where not (value->>'prepared')::boolean) then raise exception 'Prepare all lines first';end if;doc:=doc||'{"prep":"ready"}';
 elsif k='order.void' then
 if length(trim(p->>'reason'))=0 then raise exception 'Void reason required';end if;
 approver:=case when role in ('owner','manager') then (select name from public.memberships where restaurant_id=rid and user_id=actor) else public.use_approval(rid,actor,'void',oid,null,opid,at,(p->>'approval')::uuid) end;
 doc:=doc||jsonb_build_object('status','void','voidReason',p->>'reason','voidApprovedBy',approver);
 elsif k='payment.record' then
 if exists(select 1 from jsonb_array_elements(doc->'lines') where not (value->>'prepared')::boolean) then raise exception 'Prepare before payment';end if;
 total:=public.calculate_total(doc->'lines',(doc->>'discount')::bigint,doc->'settings');amount:=(total->>'total')::bigint;
 if p->>'method'<>'cash' and (not (p->>'verified')::boolean or abs(extract(epoch from now()-at))>120) then raise exception 'Online merchant verification required';end if;
 cost:=case when p->>'method'='cash' then (p->>'tendered')::bigint else amount end;
 if cost<amount then raise exception 'Insufficient tender';end if;
 insert into public.payments values(rid,oid,opid,p->>'method',amount,cost,cost-amount,true,at,now(),actor);
 doc:=doc||jsonb_build_object('status','paid','payment',jsonb_build_object('method',p->>'method','tendered',cost,'change',cost-amount,'verified',true,'at',operation->>'occurredAt'));
 end if;end if;
 doc:=doc||jsonb_build_object('revision',o.revision+1,'updatedAt',operation->>'occurredAt');update public.orders set revision=o.revision+1,status=doc->>'status',updated_at=at,snapshot=doc where restaurant_id=rid and id=oid;
 elsif k='purchase.save' then
 doc:=p->'order';oid:=(doc->>'id')::uuid;
 if not (doc ?& array['id','number','supplier','note','lines','total','status','paid','revision','createdAt','updatedAt']) then raise exception 'Missing purchase order fields';end if;
 select * into po from public.purchase_orders where restaurant_id=rid and id=oid for update;
 if coalesce(po.revision,0)<>(p->>'expectedRevision')::int or po.status is not null and po.status<>'ordered' then raise exception 'Purchase order revision/state conflict';end if;
 if length(doc->>'supplier') not between 1 and 100 or length(doc->>'note')>300 or doc->>'status'<>'ordered' or (doc->>'paid')::boolean or (doc->>'revision')::int<>coalesce(po.revision,0)+1 or (doc->>'total')::bigint<>public.purchase_total(rid,doc->'lines') then raise exception 'Invalid purchase order';end if;
 if po.id is null and (doc->>'number'<>'PO-'||upper(left(opid::text,8)) or (doc->>'createdAt')::timestamptz<>at) or po.id is not null and (doc->>'number'<>po.snapshot->>'number' or doc->>'createdAt'<>po.snapshot->>'createdAt') then raise exception 'Purchase order identity changed';end if;
 insert into public.purchase_orders values(rid,oid,(doc->>'revision')::int,'ordered',doc,at,at) on conflict(restaurant_id,id) do update set revision=excluded.revision,snapshot=excluded.snapshot,updated_at=excluded.updated_at;
 elsif k in ('purchase.receive','purchase.cancel','purchase.pay') then
 oid:=(p->>'id')::uuid;select * into po from public.purchase_orders where restaurant_id=rid and id=oid for update;
 if po.id is null or po.revision<>(p->>'expectedRevision')::int then raise exception 'Purchase order revision conflict';end if;
 doc:=po.snapshot;label:=(doc->>'number')||' · '||(doc->>'supplier');
 if k='purchase.receive' then
 if po.status<>'ordered' or p->>'payment' is null or p->>'payment' not in ('drawer','outside','unpaid') then raise exception 'Invalid purchase receipt';end if;
 amount:=public.purchase_total(rid,p->'lines');
 for l in select value from jsonb_array_elements(p->'lines') loop
 insert into public.purchases values(rid,md5(opid::text||(l->>'stockId'))::uuid,l->>'stockId',(l->>'qty')::bigint,(l->>'cost')::bigint,label,actor,at);
 insert into public.stock_movements values(rid,opid::text||'-'||(l->>'stockId'),l->>'stockId',(l->>'qty')::bigint,'purchase',label,actor,at,now(),oid::text,opid,(l->>'cost')::bigint);
 end loop;
 doc:=doc||jsonb_build_object('status','received','lines',p->'lines','total',amount,'paid',p->>'payment'<>'unpaid','receivedAt',operation->>'occurredAt')||case when p->>'payment'<>'unpaid' then jsonb_build_object('paidFrom',p->>'payment','paidAt',operation->>'occurredAt') else '{}' end;
 elsif k='purchase.cancel' then
 if po.status<>'ordered' or coalesce(length(trim(p->>'reason')),0)=0 then raise exception 'Invalid purchase cancellation';end if;
 doc:=doc||jsonb_build_object('status','cancelled','cancelReason',p->>'reason');
 else
 if po.status<>'received' or (doc->>'paid')::boolean or p->>'payment' is null or p->>'payment' not in ('drawer','outside') then raise exception 'Purchase order not payable';end if;
 doc:=doc||jsonb_build_object('paid',true,'paidFrom',p->>'payment','paidAt',operation->>'occurredAt');
 end if;
 if k<>'purchase.cancel' and p->>'payment'='drawer' then
 if s.id is null or s.actor<>actor or s.device_id<>device or at>s.expires_at or (p->>'shiftId')::uuid is distinct from s.id then raise exception 'Drawer payment requires your active shift';end if;
 insert into public.cash_movements values(rid,opid,s.id,-(doc->>'total')::bigint,'Pembelian '||label,actor,at,null);
 end if;
 doc:=doc||jsonb_build_object('revision',po.revision+1,'updatedAt',operation->>'occurredAt');
 update public.purchase_orders set revision=po.revision+1,status=doc->>'status',snapshot=doc,updated_at=at where restaurant_id=rid and id=oid;
 elsif k='production.record' then
 select name into label from public.inventory_items where restaurant_id=rid and id=p->>'stockId';
 if label is null or jsonb_typeof(p->'inputs')<>'array' or jsonb_array_length(p->'inputs') not between 1 and 100 or (p->>'qty')::numeric<>trunc((p->>'qty')::numeric) or (p->>'qty')::bigint not between 1 and 1000000000000 or length(p->>'note')>200
 or exists(select 1 from jsonb_array_elements(p->'inputs') i where i.value->>'stockId'=p->>'stockId') then raise exception 'Invalid production';end if;
 perform public.validate_recipe(rid,p->'inputs');
 label:='Produksi '||label||coalesce(nullif(' · '||trim(p->>'note'),' · '),'');
 insert into public.stock_movements values(rid,opid::text||'-'||(p->>'stockId'),p->>'stockId',(p->>'qty')::bigint,'production',label,actor,at,now(),opid::text,opid,0);
 for r in select value from jsonb_array_elements(p->'inputs') loop
 insert into public.stock_movements values(rid,opid::text||'-'||(r->>'stockId'),r->>'stockId',-(r->>'qty')::bigint,'production',label,actor,at,now(),opid::text,opid,0);
 end loop;
 elsif k='stock.record' then
 if length(trim(p->>'reason'))=0 then raise exception 'Reason required';end if;
 qty:=(p->>'qty')::bigint;cost:=(p->>'cost')::bigint;if cost not between 0 and 1000000000 or abs(qty)>1000000000000 then raise exception 'Invalid stock amount';end if;
 if p->>'kind' in ('opening','purchase') and qty<=0 or p->>'kind'='count' and qty<0 then raise exception 'Invalid stock quantity';end if;
 if p->>'kind'='preparation' then raise exception 'Preparation must use order operation';end if;
 if p->>'kind'='purchase' then insert into public.purchases values(rid,opid,p->>'stockId',qty,cost,p->>'reason',actor,at);end if;
 if p->>'kind'='count' then select coalesce(sum(sm.qty),0) into balance from public.stock_movements sm where restaurant_id=rid and stock_id=p->>'stockId';qty:=qty-balance;end if;
 if p->>'kind'='waste' then qty:=-abs(qty);end if;
 insert into public.stock_movements values(rid,opid::text,p->>'stockId',qty,p->>'kind',p->>'reason',actor,at,now(),opid::text,opid,cost);
 if (p->>'fromDrawer')::boolean then
 if s.id is null or s.actor<>actor or p->>'kind'<>'purchase' or (p->>'shiftId')::uuid<>s.id then raise exception 'Cash purchase requires active shift';end if;
 insert into public.cash_movements values(rid,opid,s.id,-cost,'Pembelian: '||(p->>'reason'),actor,at,opid);end if;
 elsif k='shift.cash' then
 if (p->>'shiftId')::uuid<>s.id or length(trim(p->>'reason'))=0 or (p->>'amount')::bigint=0 then raise exception 'Invalid cash movement';end if;
 if (p->>'amount')::bigint<0 and role not in ('owner','manager') then perform public.use_approval(rid,actor,'cashout',null,-(p->>'amount')::bigint,opid,at,(p->>'approval')::uuid);end if;
 insert into public.cash_movements values(rid,opid,s.id,(p->>'amount')::bigint,p->>'reason',actor,at,null);
 elsif k='shift.close' then
 if (p->>'id')::uuid<>s.id or exists(select 1 from public.orders where restaurant_id=rid and shift_id=s.id and status='open') then raise exception 'Open orders prevent closing';end if;
 select s.opening+coalesce((select sum(pay.total) from public.payments pay join public.orders ord on ord.restaurant_id=pay.restaurant_id and ord.id=pay.order_id where ord.restaurant_id=rid and ord.shift_id=s.id and pay.method='cash' and ord.status<>'refunded'),0)+coalesce((select sum(cm.amount) from public.cash_movements cm where cm.restaurant_id=rid and cm.shift_id=s.id),0) into expected_value;
 update public.shifts set closed_at=at,counted=(p->>'counted')::bigint,expected=expected_value,variance=(p->>'counted')::bigint-expected_value where restaurant_id=rid and id=s.id;
 else raise exception 'Unknown operation';end if;
 end if;
 result:=jsonb_build_object('id',opid,'receivedAt',now());insert into public.sync_operations(id,restaurant_id,actor,device_id,kind,payload,occurred_at,result) values(opid,rid,actor,device,k,canonical,at,result);return result;
end $$;
create or replace function public.bootstrap(device_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid;member public.memberships%rowtype;r public.restaurants%rowtype;begin
 select * into member from public.memberships where user_id=auth.uid() and active;
 if member.user_id is null then raise exception 'No active staff membership' using errcode='42501';end if;
 rid:=member.restaurant_id;select * into r from public.restaurants where id=rid;
 return jsonb_build_object('restaurantId',rid,'name',member.name,'role',member.role,'primary',coalesce(r.primary_device_id=device_id,false),'settings',r.settings,
 'menu',(select coalesce(jsonb_agg(v.snapshot),'[]') from public.catalog_items c join public.catalog_versions v on v.restaurant_id=c.restaurant_id and v.item_id=c.id and v.version=c.version where c.restaurant_id=rid),
 'stock',(select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',id,'name',name,'unit',unit,'threshold',threshold,'production',production))),'[]') from public.inventory_items where restaurant_id=rid),
 'purchaseOrders',(select coalesce(jsonb_agg(x.snapshot),'[]') from (select snapshot from public.purchase_orders where restaurant_id=rid and member.role<>'cashier' order by created_at desc limit 200) x),
 'orders',(select coalesce(jsonb_agg(x.snapshot),'[]') from (select snapshot from public.orders where restaurant_id=rid and (member.role<>'cashier' or status='open' or shift_id in (select id from public.shifts where restaurant_id=rid and closed_at is null)) order by created_at desc limit 500) x),
 'shifts',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'actor',actor,'cashier',cashier,'openedAt',opened_at,'expiresAt',expires_at,'opening',opening,'status',case when closed_at is null then 'open' else 'closed' end,'closedAt',closed_at,'counted',counted,'expected',case when member.role<>'cashier' then expected end,'variance',case when member.role<>'cashier' then variance end)),'[]') from (select * from public.shifts where restaurant_id=rid order by opened_at desc limit 30) s),
 'cash',(select coalesce(jsonb_agg(jsonb_build_object('id',cm.id,'shiftId',shift_id,'amount',amount,'reason',reason,'actor',cm.actor,'at',occurred_at,'recordId',purchase_id,'approvedBy',(select m.name from public.approvals a join public.memberships m on m.restaurant_id=a.restaurant_id and m.user_id=a.approver where a.restaurant_id=rid and a.operation_id=cm.id))),'[]') from public.cash_movements cm join public.shifts s on s.restaurant_id=cm.restaurant_id and s.id=cm.shift_id where cm.restaurant_id=rid and (s.closed_at is null or member.role<>'cashier' and s.opened_at>now()-interval '31 days')),
 'movements',(select coalesce(jsonb_agg(jsonb_build_object('id','baseline-'||stock_id,'stockId',stock_id,'qty',qty,'kind','opening','reason','Saldo agregat server saat sinkronisasi awal','actor',auth.uid(),'at',now(),'recordId','server-baseline','cost',0)),'[]') from public.stock_balances where restaurant_id=rid));
end $$;
