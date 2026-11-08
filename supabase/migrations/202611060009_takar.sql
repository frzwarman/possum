-- Takar phase 1. Six staff roles; devices paired as the till (pos), a station tablet or a back-office
-- laptop; a pull feed so every paired device sees new work; tickets per station that a station marks
-- ready without touching the till's revision; option deltas (a swap carries negative amounts and
-- consumption never goes below zero per line); stock counts approved into one operation; a PIN for a
-- cash gap over the limit; an audit log over sync_operations. The rules that halted the outbox are
-- relaxed: no 2-minute freshness window, owners and managers may void in and close anyone's shift,
-- and void, cash payment and close still work after the 12-hour authorization.
alter table public.memberships drop constraint memberships_role_check;
alter table public.memberships add constraint memberships_role_check check(role in ('owner','manager','admin','chef','cashier','barista','kitchen'));
alter table public.devices add column mode text not null default 'pos' check(mode in ('pos','station','office'));
-- CTL-4: staff pick their name on a shared device and type their PIN; the device needs the login behind the name.
alter table public.memberships add column login text;
alter table public.inventory_items add column aliases jsonb not null default '[]',add column area text not null default '',add column packs jsonb not null default '[]',add column shelf_life integer check(shelf_life between 1 and 100000),add column station text check(station in ('kitchen','bar')),add column updated_at timestamptz not null default now();
alter table public.restaurants add column settings_at timestamptz not null default now();
alter table public.shifts add column received_at timestamptz not null default now(),add column variance_approved_by text;
alter table public.cash_movements add column received_at timestamptz not null default now();
alter table public.purchases add column photo text;
create index orders_received on public.orders(restaurant_id,received_at);
create index movements_received on public.stock_movements(restaurant_id,received_at);
create index shifts_received on public.shifts(restaurant_id,received_at);
create index cash_received on public.cash_movements(restaurant_id,received_at);
create index catalog_versions_created on public.catalog_versions(restaurant_id,created_at);
create index inventory_items_updated on public.inventory_items(restaurant_id,updated_at);
alter table public.approvals drop constraint approvals_action_check;
alter table public.approvals add constraint approvals_action_check check(action in ('discount','void','refund','cashout','count','variance','publish'));
create table public.counts(
 restaurant_id uuid not null references public.restaurants(id),id uuid not null,area text not null,actor uuid not null,approver text,lines jsonb not null,status text not null default 'approved' check(status in ('submitted','approved')),
 occurred_at timestamptz not null,received_at timestamptz not null default now(),operation_id uuid not null,
 primary key(restaurant_id,id),foreign key(restaurant_id,actor) references public.memberships(restaurant_id,user_id)
);
alter table public.counts enable row level security;
revoke all on public.counts from anon,authenticated;
grant select on public.counts to authenticated;
create policy office_read on public.counts for select to authenticated using(public.member_role(restaurant_id) in ('owner','manager','admin','chef'));
-- Timestamps leave the server exactly as the device writes them (toISOString), so strings sort the same on both sides.
create function public.iso(t timestamptz) returns text language sql immutable set search_path='' as $$ select to_char(t at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;
-- Option recipes are deltas: a swap or a level may carry a negative amount (what it replaces or removes).
drop function public.validate_recipe(uuid,jsonb);
create function public.validate_recipe(rid uuid,recipe jsonb,deltas boolean default false) returns void language plpgsql set search_path='' as $$
declare r jsonb;seen text[]:='{}';q numeric;begin
 if jsonb_typeof(recipe)<>'array' or jsonb_array_length(recipe)>100 then raise exception 'Invalid recipe';end if;
 for r in select value from jsonb_array_elements(recipe) loop
 q:=(r->>'qty')::numeric;
 if r->>'stockId'=any(seen) or q is null or q<>trunc(q) or q=0 or abs(q)>1000000000 or (q<0 and not deltas) or not exists(select 1 from public.inventory_items where restaurant_id=rid and id=r->>'stockId') then raise exception 'Invalid ingredient';end if;
 seen:=array_append(seen,r->>'stockId');end loop;
end $$;
-- new = nothing sent yet; ready = every sent line marked ready by its station; otherwise preparing.
create function public.prep_state(lines jsonb) returns text language sql immutable set search_path='' as $$
 select case when not exists(select 1 from jsonb_array_elements(lines) l where (l.value->>'prepared')::boolean and not coalesce((l.value->>'cancelled')::boolean,false)) then 'new'
 when exists(select 1 from jsonb_array_elements(lines) l where not coalesce((l.value->>'cancelled')::boolean,false) and (not (l.value->>'prepared')::boolean or not (l.value ? 'readyAt'))) then 'preparing' else 'ready' end
$$;
-- One JSON shape per record for bootstrap and pull.
create function public.shift_json(s public.shifts,managers boolean) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',s.id,'actor',s.actor,'cashier',s.cashier,'openedAt',public.iso(s.opened_at),'expiresAt',public.iso(s.expires_at),'opening',s.opening,'status',case when s.closed_at is null then 'open' else 'closed' end,'closedAt',public.iso(s.closed_at),'counted',s.counted,'expected',case when managers then s.expected end,'variance',case when managers then s.variance end,'varianceApprovedBy',s.variance_approved_by)
$$;
create function public.cash_json(cm public.cash_movements) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',cm.id,'shiftId',cm.shift_id,'amount',cm.amount,'reason',cm.reason,'actor',cm.actor,'at',public.iso(cm.occurred_at),'recordId',cm.purchase_id,'approvedBy',(select m.name from public.approvals a join public.memberships m on m.restaurant_id=a.restaurant_id and m.user_id=a.approver where a.restaurant_id=cm.restaurant_id and a.operation_id=cm.id))
$$;
create function public.movement_json(m public.stock_movements) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',m.id,'stockId',m.stock_id,'qty',m.qty,'kind',m.kind,'reason',m.reason,'actor',m.actor,'at',public.iso(m.occurred_at),'recordId',m.record_id,'cost',m.cost)
$$;
create function public.count_json(c public.counts) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',c.id,'area',c.area,'status',c.status,'lines',c.lines,'startedBy',c.actor,'startedAt',public.iso(c.occurred_at),'submittedAt',public.iso(c.occurred_at),'approvedAt',case when c.status='approved' then public.iso(c.occurred_at) end,'approvedBy',c.approver)
$$;
create function public.catalog_json(rid uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object(
 'menu',(select coalesce(jsonb_agg(v.snapshot),'[]') from public.catalog_items c join public.catalog_versions v on v.restaurant_id=c.restaurant_id and v.item_id=c.id and v.version=c.version where c.restaurant_id=rid),
 'stock',(select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',id,'name',name,'unit',unit,'threshold',threshold,'production',production,'aliases',aliases,'area',nullif(area,''),'packs',packs,'shelfLife',shelf_life,'station',station))),'[]') from public.inventory_items where restaurant_id=rid))
$$;
create function public.device_json(rid uuid,device_id uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('mode',(select d.mode from public.devices d where d.restaurant_id=rid and d.id=device_id and d.revoked_at is null),'enrolled',exists(select 1 from public.devices d where d.restaurant_id=rid and d.id=device_id and d.revoked_at is null),'primary',coalesce((select r.primary_device_id=device_id from public.restaurants r where r.id=rid),false))
$$;
create function public.team_json(rid uuid) returns jsonb language sql stable set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',user_id,'name',name,'role',role,'login',login) order by name),'[]') from public.memberships where restaurant_id=rid and active
$$;
revoke all on function public.iso(timestamptz),public.validate_recipe(uuid,jsonb,boolean),public.prep_state(jsonb),public.shift_json(public.shifts,boolean),public.cash_json(public.cash_movements),public.movement_json(public.stock_movements),public.count_json(public.counts),public.catalog_json(uuid),public.device_json(uuid,uuid),public.team_json(uuid) from public,anon,authenticated;
-- A device is paired once, as the till (one per restaurant, the existing rules), a station tablet or a
-- back-office laptop. Owners and managers pair; the till can only be re-paired with no shift open.
drop function public.enroll_device(uuid);
create function public.enroll_device(device_id uuid,mode text default 'pos') returns void language plpgsql security definer set search_path='' as $$
declare rid uuid;role text;primary_id uuid;begin
 select restaurant_id,m.role into rid,role from public.memberships m where user_id=auth.uid() and active;
 if role not in ('owner','manager') or role is null then raise exception 'Manager required' using errcode='42501';end if;
 if mode not in ('pos','station','office') then raise exception 'Unknown device mode';end if;
 select primary_device_id into primary_id from public.restaurants where id=rid for update;
 insert into public.devices(restaurant_id,id,enrolled_by,mode) values(rid,device_id,auth.uid(),mode) on conflict(restaurant_id,id) do update set revoked_at=null,mode=excluded.mode;
 if mode<>'pos' then
  if primary_id=device_id then
   if exists(select 1 from public.shifts where restaurant_id=rid and closed_at is null) then raise exception 'Close the shift before re-pairing the till';end if;
   update public.restaurants set primary_device_id=null where id=rid;
  end if;
  return;
 end if;
 if primary_id is not null and primary_id<>device_id and role<>'owner' then raise exception 'Primary already assigned: explicit reconciled handover required';end if;
 if primary_id is not null and primary_id<>device_id then
  update public.devices set revoked_at=now() where restaurant_id=rid and id=primary_id;
  update public.shifts set device_id=enroll_device.device_id,received_at=now() where restaurant_id=rid and closed_at is null;
  insert into public.device_handovers(restaurant_id,old_device,new_device,actor,note) values(rid,primary_id,device_id,auth.uid(),'Pemilik memindahkan kasir utama langsung dari aplikasi');
 end if;
 update public.restaurants set primary_device_id=device_id where id=rid;
end $$;
revoke all on function public.enroll_device(uuid,text) from public,anon;grant execute on function public.enroll_device(uuid,text) to authenticated;
-- Three wrong PINs in five minutes pause approvals; counts, cash gaps and recipe-less menus are approvable.
create or replace function public.approve(approver uuid,pin text,action text,order_id uuid default null,amount bigint default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid;who text;hash text;granted uuid;begin
 select m.restaurant_id into rid from public.memberships m where m.user_id=auth.uid() and m.active;
 if rid is null then raise exception 'No active staff membership' using errcode='42501';end if;
 if approve.action not in ('discount','void','refund','cashout','count','variance','publish') then raise exception 'Unknown approval action';end if;
 if (select count(*) from public.approval_failures f where f.restaurant_id=rid and f.at>now()-interval '5 minutes')>=3 then return '{"error":"locked"}';end if;
 select m.name,p.pin_hash into who,hash from public.memberships m left join public.approval_pins p on p.restaurant_id=m.restaurant_id and p.user_id=m.user_id
 where m.restaurant_id=rid and m.user_id=approve.approver and m.active and m.role in ('owner','manager');
 if who is null then raise exception 'Approver must be an active manager' using errcode='42501';end if;
 if hash is null then return '{"error":"no-pin"}';end if;
 if approve.pin is null or extensions.crypt(approve.pin,hash)<>hash then
  insert into public.approval_failures(restaurant_id,requested_by) values(rid,auth.uid());return '{"error":"wrong-pin"}';end if;
 insert into public.approvals(restaurant_id,approver,requested_by,action,order_id,amount)
 values(rid,approve.approver,auth.uid(),approve.action,approve.order_id,approve.amount) returning id into granted;
 return jsonb_build_object('id',granted,'by',who);
end $$;
-- Owners and managers manage the team; only an owner touches an owner, and nobody their own row.
create or replace function public.manage_staff(target uuid,new_role text,new_active boolean) returns void language plpgsql security definer set search_path='' as $$
declare rid uuid;me text;was text;begin
 select restaurant_id,role into rid,me from public.memberships where user_id=auth.uid() and active and role in ('owner','manager');
 if rid is null then raise exception 'Owner required' using errcode='42501';end if;
 if target=auth.uid() then raise exception 'Owner cannot change their own access' using errcode='42501';end if;
 if new_role not in ('owner','manager','admin','chef','cashier','barista','kitchen') or new_active is null then raise exception 'Invalid staff role or access';end if;
 select role into was from public.memberships where restaurant_id=rid and user_id=target;
 if was is null then raise exception 'Staff not found in this restaurant';end if;
 if me<>'owner' and (was='owner' or new_role='owner') then raise exception 'Owner required' using errcode='42501';end if;
 update public.memberships set role=new_role,active=new_active where restaurant_id=rid and user_id=target;
end $$;
-- Everything a paired device missed since its last pull, filtered like bootstrap: station crew and
-- cashiers see open orders and the open shift, blind to expected cash; office roles see it all.
create function public.pull(since timestamptz,device_id uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare member public.memberships%rowtype;r public.restaurants%rowtype;rid uuid;office boolean;managers boolean;open_shift uuid;result jsonb;begin
 select * into member from public.memberships where user_id=auth.uid() and active;
 if member.user_id is null then raise exception 'No active staff membership' using errcode='42501';end if;
 rid:=member.restaurant_id;select * into r from public.restaurants where id=rid;
 office:=member.role in ('owner','manager','admin','chef');managers:=member.role in ('owner','manager');
 select id into open_shift from public.shifts where restaurant_id=rid and closed_at is null;
 result:=jsonb_build_object('now',public.iso(now()),'device',public.device_json(rid,device_id),
 'orders',(select coalesce(jsonb_agg(o.snapshot order by o.created_at),'[]') from public.orders o where o.restaurant_id=rid and o.received_at>since and (office or o.status='open' or o.shift_id=open_shift)),
 'shifts',(select coalesce(jsonb_agg(public.shift_json(s,managers) order by s.opened_at),'[]') from public.shifts s where s.restaurant_id=rid and s.received_at>since),
 'cash',(select coalesce(jsonb_agg(public.cash_json(cm) order by cm.occurred_at),'[]') from public.cash_movements cm where cm.restaurant_id=rid and cm.received_at>since and (office or cm.shift_id=open_shift)),
 'movements',(select coalesce(jsonb_agg(public.movement_json(m) order by m.received_at),'[]') from public.stock_movements m where m.restaurant_id=rid and m.received_at>since),
 'counts',(select coalesce(jsonb_agg(public.count_json(c) order by c.occurred_at),'[]') from public.counts c where c.restaurant_id=rid and c.received_at>since and office));
 if exists(select 1 from public.catalog_versions where restaurant_id=rid and created_at>since) or exists(select 1 from public.inventory_items where restaurant_id=rid and updated_at>since) then result:=result||jsonb_build_object('catalog',public.catalog_json(rid));end if;
 if r.settings_at>since then result:=result||jsonb_build_object('settings',r.settings);end if;
 return result;
end $$;
-- Every sensitive operation, who did it, from which device, and who approved it. Owners and managers only.
create function public.audit_log(from_day date,to_day date) returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid;config jsonb;tz text;cut integer;start_at timestamptz;end_at timestamptz;begin
 select restaurant_id into rid from public.memberships where user_id=auth.uid() and active and role in ('owner','manager');
 if rid is null then raise exception 'Manager required' using errcode='42501';end if;
 if to_day<from_day or to_day-from_day>93 then raise exception 'Audit range limited to 94 days';end if;
 select settings into config from public.restaurants where id=rid;tz:=config->>'timezone';cut:=(config->>'cutoff')::int;
 start_at:=(from_day::timestamp+make_interval(hours=>cut)) at time zone tz;end_at:=((to_day+1)::timestamp+make_interval(hours=>cut)) at time zone tz;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'kind',x.kind,'at',public.iso(x.occurred_at),'actor',x.actor,'actorName',x.name,'role',x.role,'device',x.device_id,'mode',x.mode,'approvedBy',x.approved_by,'payload',x.payload) order by x.occurred_at desc),'[]') from (
  select so.id,so.kind,so.occurred_at,so.actor,m.name,m.role,so.device_id,d.mode,(so.payload->'payload')-'photo' as payload,
  (select am.name from public.approvals a join public.memberships am on am.restaurant_id=a.restaurant_id and am.user_id=a.approver where a.restaurant_id=rid and a.operation_id=so.id) as approved_by
  from public.sync_operations so join public.memberships m on m.restaurant_id=so.restaurant_id and m.user_id=so.actor left join public.devices d on d.restaurant_id=so.restaurant_id and d.id=so.device_id
  where so.restaurant_id=rid and so.occurred_at>=start_at and so.occurred_at<end_at
  and (so.kind in ('order.void','refund.record','shift.cash','stock.record','count.record','catalog.publish','settings.update','shift.close') or (so.kind='order.save' and coalesce((so.payload->'payload'->'order'->>'discount')::bigint,0)>0))
  order by so.occurred_at desc limit 1000) x);
end $$;
revoke all on function public.pull(timestamptz,uuid),public.audit_log(date,date) from public,anon;
grant execute on function public.pull(timestamptz,uuid),public.audit_log(date,date) to authenticated;

create or replace function public.apply_operation(operation jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 rid uuid:=(operation->>'restaurantId')::uuid;opid uuid:=(operation->>'id')::uuid;actor uuid:=auth.uid();device uuid:=(operation->>'deviceId')::uuid;k text:=operation->>'kind';p jsonb:=operation->'payload';at timestamptz:=(operation->>'occurredAt')::timestamptz;
 role text;canonical jsonb;previous public.sync_operations%rowtype;restaurant public.restaurants%rowtype;s public.shifts%rowtype;o public.orders%rowtype;
 doc jsonb;l jsonb;m jsonb;v jsonb;oldline jsonb;old jsonb;recipe jsonb;total jsonb;oid uuid;qty bigint;cost bigint;balance bigint;amount bigint;expected_value bigint;prepared jsonb;seen text[];result jsonb;approver text;u record;st text;selling boolean;allowed boolean;begin
 if actor is null or operation->>'actor' is distinct from actor::text then raise exception 'Authenticated actor mismatch' using errcode='42501';end if;
 role:=public.member_role(rid);if role is null then raise exception 'Membership denied' using errcode='42501';end if;
 select * into restaurant from public.restaurants where id=rid for update;
 canonical:=jsonb_build_object('kind',k,'payload',p,'actor',actor,'device',device,'occurredAt',at,'restaurant',rid);
 select * into previous from public.sync_operations where id=opid;
 if found then if previous.restaurant_id<>rid or previous.payload<>canonical then raise exception 'Operation ID reused with different payload';end if;return previous.result;end if;
 -- Who may send what. The message is the one older clients already show for a refused role.
 selling:=k in ('shift.open','shift.close','shift.cash','order.save','order.prepare','order.void','payment.record','refund.record');
 allowed:=(selling and role in ('owner','manager','cashier')) or k='order.ready'
  or (k='catalog.publish' and role in ('owner','manager','admin','chef')) or (k='settings.update' and role in ('owner','manager'))
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
 or coalesce((doc->'stations'->>'kitchen')::int,15) not between 1 and 600 or coalesce((doc->'stations'->>'bar')::int,8) not between 1 and 600 or coalesce((doc->>'varianceLimit')::bigint,0) not between 0 and 1000000000 or coalesce((doc->>'lowAt')::int,5) not between 0 and 999 then raise exception 'Invalid restaurant settings';end if;
 perform (doc->>'goLive')::date;perform public.validate_recipe(rid,doc->'packaging');update public.restaurants set settings=doc,settings_at=now() where id=rid;
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
 if s.actor<>actor and not (role in ('owner','manager') and k in ('shift.close','order.void')) then raise exception 'No authorized shift for operation';end if;
 if at>s.expires_at and k not in ('shift.close','order.void') and not (k='payment.record' and p->>'method'='cash') then raise exception 'No authorized shift for operation';end if;
 end if;
 if k='order.save' then
 doc:=p->'order';if not (doc ?& array['id','shiftId','restaurantId','actor','cashier','revision','status','mode','label','discount','discountReason','settings','receiptId','prep','createdAt','lines','totals']) then raise exception 'Missing order fields';end if;oid:=(doc->>'id')::uuid;
 select * into o from public.orders where restaurant_id=rid and id=oid for update;
 if coalesce(o.revision,0)<>(p->>'expectedRevision')::int or o.status is not null and o.status<>'open' then raise exception 'Order revision/state conflict';end if;
 if (doc->>'shiftId')::uuid<>s.id or doc->>'restaurantId'<>rid::text or doc->>'actor'<>actor::text or doc->>'cashier'<>s.cashier or (doc->>'revision')::int<>coalesce(o.revision,0)+1 or doc->>'status'<>'open' or doc->>'mode' not in ('dinein','takeaway') or length(doc->>'label')>100 then raise exception 'Invalid order';end if;
 if o.id is null then
 if doc->'settings'<>restaurant.settings or doc->>'receiptId'<>'MJ-'||upper(opid::text) or doc->>'prep'<>'new' or (doc->>'createdAt')::timestamptz<>at then raise exception 'Invalid initial snapshot';end if;
 else
 if doc->'settings'<>o.snapshot->'settings' or doc->>'receiptId'<>o.snapshot->>'receiptId' or doc->>'createdAt'<>o.snapshot->>'createdAt' then raise exception 'Historical snapshot changed';end if;
 -- A station may have marked a sent line ready meanwhile: that flag is the server's, not the till's.
 for oldline in select value from jsonb_array_elements(o.snapshot->'lines') where (value->>'prepared')::boolean loop
 if not exists(select 1 from jsonb_array_elements(doc->'lines') where value-'readyAt'=oldline-'readyAt') then raise exception 'Prepared line immutable';end if;end loop;
 end if;
 doc:=doc-'discountApprovedBy';
 if (doc->>'discount')::bigint<>coalesce((o.snapshot->>'discount')::bigint,0) then
 if length(trim(doc->>'discountReason'))=0 then raise exception 'Discount requires manager and reason';end if;
 doc:=doc||jsonb_build_object('discountApprovedBy',case when role in ('owner','manager') then (select name from public.memberships where restaurant_id=rid and user_id=actor) else public.use_approval(rid,actor,'discount',null,(doc->>'discount')::bigint,opid,at,(p->>'approval')::uuid) end);
 elsif o.snapshot ? 'discountApprovedBy' then doc:=doc||jsonb_build_object('discountApprovedBy',o.snapshot->'discountApprovedBy');
 end if;
 if jsonb_array_length(doc->'lines') not between 1 and 200 then raise exception 'Invalid line count';end if;seen:='{}';prepared:='[]';
 for l in select value from jsonb_array_elements(doc->'lines') loop
 if not (l ?& array['id','itemId','name','price','qty','modifiers','note','recipe','catalogVersion','prepared','cancelled']) then raise exception 'Missing line fields';end if;
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
 total:=public.calculate_total(doc->'lines',(doc->>'discount')::bigint,doc->'settings');if total<>doc->'totals' then raise exception 'Client total mismatch';end if;
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
 total:=public.calculate_total(doc->'lines',(doc->>'discount')::bigint,doc->'settings');amount:=(total->>'total')::bigint;
 if p->>'method' not in ('cash','qris','card') or (p->>'method'<>'cash' and not (p->>'verified')::boolean) then raise exception 'Online merchant verification required';end if;
 cost:=case when p->>'method'='cash' then (p->>'tendered')::bigint else amount end;
 if cost<amount then raise exception 'Insufficient tender';end if;
 insert into public.payments values(rid,oid,opid,p->>'method',amount,cost,cost-amount,true,at,now(),actor);
 doc:=doc||jsonb_build_object('status','paid','payment',jsonb_build_object('method',p->>'method','tendered',cost,'change',cost-amount,'verified',true,'at',operation->>'occurredAt'));
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
 select s.opening+coalesce((select sum(pay.total) from public.payments pay join public.orders ord on ord.restaurant_id=pay.restaurant_id and ord.id=pay.order_id where ord.restaurant_id=rid and ord.shift_id=s.id and pay.method='cash' and ord.status<>'refunded'),0)+coalesce((select sum(cm.amount) from public.cash_movements cm where cm.restaurant_id=rid and cm.shift_id=s.id),0) into expected_value;
 amount:=(p->>'counted')::bigint-expected_value;
 -- POS-8: a cashier's gap over the limit needs a manager's PIN for exactly that amount; managers answer for their own.
 approver:=case when role in ('owner','manager') then null when abs(amount)>coalesce((restaurant.settings->>'varianceLimit')::bigint,10000) then public.use_approval(rid,actor,'variance',null,abs(amount),opid,at,(p->>'approval')::uuid) end;
 update public.shifts set closed_at=at,counted=(p->>'counted')::bigint,expected=expected_value,variance=amount,variance_approved_by=approver,received_at=now() where restaurant_id=rid and id=s.id;
 else raise exception 'Unknown operation';end if;
 end if;
 result:=jsonb_build_object('id',opid,'receivedAt',now());insert into public.sync_operations(id,restaurant_id,actor,device_id,kind,payload,occurred_at,result) values(opid,rid,actor,device,k,canonical,at,result);return result;
end $$;
create or replace function public.bootstrap(device_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid;member public.memberships%rowtype;r public.restaurants%rowtype;office boolean;managers boolean;begin
 select * into member from public.memberships where user_id=auth.uid() and active;
 if member.user_id is null then raise exception 'No active staff membership' using errcode='42501';end if;
 rid:=member.restaurant_id;select * into r from public.restaurants where id=rid;
 office:=member.role in ('owner','manager','admin','chef');managers:=member.role in ('owner','manager');
 return public.catalog_json(rid)||jsonb_build_object('restaurantId',rid,'name',member.name,'role',member.role,'primary',coalesce(r.primary_device_id=device_id,false),'settings',r.settings,'now',public.iso(now()),
 'device',public.device_json(rid,device_id),'team',public.team_json(rid),
 'purchaseOrders',(select coalesce(jsonb_agg(x.snapshot),'[]') from (select snapshot from public.purchase_orders where restaurant_id=rid and office order by created_at desc limit 200) x),
 'suppliers',(select coalesce(jsonb_agg(snapshot order by snapshot->>'name'),'[]') from public.suppliers where restaurant_id=rid and office),
 'salesOrders',(select coalesce(jsonb_agg(x.snapshot),'[]') from (select snapshot from public.sales_orders where restaurant_id=rid and office order by deliver_at desc limit 300) x),
 'outletData',case when managers then public.outlet_transfers() end,
 'costs',(select coalesce(jsonb_object_agg(c.stock_id,c.unit),'{}') from (select distinct on (m.stock_id) m.stock_id,m.cost::numeric/m.qty as unit from public.stock_movements m where m.restaurant_id=rid and m.kind in ('purchase','production','transfer') and m.qty>0 and m.cost>0 order by m.stock_id,m.occurred_at desc,m.received_at desc) c),
 'counts',(select coalesce(jsonb_agg(public.count_json(c) order by c.occurred_at),'[]') from (select * from public.counts where restaurant_id=rid and office order by occurred_at desc limit 50) c),
 'orders',(select coalesce(jsonb_agg(x.snapshot),'[]') from (select snapshot from public.orders where restaurant_id=rid and (office or status='open' or shift_id in (select id from public.shifts where restaurant_id=rid and closed_at is null)) order by created_at desc limit 500) x),
 'shifts',(select coalesce(jsonb_agg(public.shift_json(s,managers)),'[]') from (select * from public.shifts where restaurant_id=rid order by opened_at desc limit 30) s),
 'cash',(select coalesce(jsonb_agg(public.cash_json(cm)),'[]') from public.cash_movements cm join public.shifts s on s.restaurant_id=cm.restaurant_id and s.id=cm.shift_id where cm.restaurant_id=rid and (s.closed_at is null or office and s.opened_at>now()-interval '31 days')),
 'movements',(select coalesce(jsonb_agg(jsonb_build_object('id','baseline-'||b.stock_id,'stockId',b.stock_id,'qty',b.qty,'kind','opening','reason','Saldo agregat server saat sinkronisasi awal','actor',auth.uid(),'at',public.iso(now()),'recordId','server-baseline','cost',0)),'[]') from (select stock_id,sum(qty) as qty from public.stock_movements where restaurant_id=rid and received_at<=now()-interval '10 seconds' group by stock_id) b));
end $$;
