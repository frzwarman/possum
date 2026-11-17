-- Takar Stok, the phone app: staff count stock and record deliveries by scanning the item's barcode. A phone is
-- paired like any other device, a barcode is remembered per store, and one small call hands the phone what it
-- keeps to work offline. Counts and deliveries themselves still go through apply_operation (count.submit,
-- stock.record): this file only adds things, nothing that exists is redefined.
alter table public.devices drop constraint devices_mode_check,add constraint devices_mode_check check(mode in ('pos','station','office','phone'));
-- One row per code per store. pack names which of the bahan's packs the code is printed on ('' = a single unit),
-- so a scanned carton opens the carton box. Only the functions below read or write it.
create table public.barcodes(
 restaurant_id uuid not null references public.restaurants(id),code text not null check(code ~ '^[\x21-\x7e]{4,64}$'),stock_id text not null,pack text not null default '' check(length(pack)<=60),
 linked_by uuid not null,linked_at timestamptz not null default now(),
 primary key(restaurant_id,code),foreign key(restaurant_id,stock_id) references public.inventory_items(restaurant_id,id),foreign key(restaurant_id,linked_by) references public.memberships(restaurant_id,user_id)
);
alter table public.barcodes enable row level security;
revoke all on public.barcodes from anon,authenticated;
-- Owners and managers pair a phone, as they pair a station tablet or a laptop. The till stays the till.
create function public.enroll_phone(device_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare rid uuid;who text;begin
 select m.restaurant_id,m.role into rid,who from public.memberships m where m.user_id=auth.uid() and m.active;
 if who is null or who not in ('owner','manager') then raise exception 'Manager required' using errcode='42501';end if;
 if exists(select 1 from public.restaurants r where r.id=rid and r.primary_device_id=enroll_phone.device_id) then raise exception 'The till cannot be a phone';end if;
 insert into public.devices(restaurant_id,id,enrolled_by,mode) values(rid,enroll_phone.device_id,auth.uid(),'phone') on conflict(restaurant_id,id) do update set revoked_at=null,mode='phone';
end $$;
-- Who is asking, from a paired device: the same two questions apply_operation asks before any write.
create function public.stok_member(device_id uuid) returns uuid language plpgsql stable security definer set search_path='' as $$
declare rid uuid;begin
 select m.restaurant_id into rid from public.memberships m where m.user_id=auth.uid() and m.active;
 if rid is null then raise exception 'No active staff membership' using errcode='42501';end if;
 if not exists(select 1 from public.devices d where d.restaurant_id=rid and d.id=stok_member.device_id and d.revoked_at is null) then raise exception 'Device not enrolled';end if;
 return rid;
end $$;
-- Anyone on the team meets an unknown code while counting, so anyone may teach it. Linking a code again moves it.
create function public.link_barcode(device_id uuid,barcode text,item text,pack_name text default '') returns void language plpgsql security definer set search_path='' as $$
declare rid uuid:=public.stok_member(device_id);begin
 if barcode is null or barcode !~ '^[\x21-\x7e]{4,64}$' then raise exception 'Invalid barcode';end if;
 if not exists(select 1 from public.inventory_items i where i.restaurant_id=rid and i.id=item) then raise exception 'Unknown stock item';end if;
 if coalesce(pack_name,'')<>'' and not exists(select 1 from public.inventory_items i,jsonb_array_elements(i.packs) p where i.restaurant_id=rid and i.id=item and p.value->>'name'=pack_name) then raise exception 'Unknown pack';end if;
 insert into public.barcodes(restaurant_id,code,stock_id,pack,linked_by) values(rid,barcode,item,coalesce(pack_name,''),auth.uid())
 on conflict(restaurant_id,code) do update set stock_id=excluded.stock_id,pack=excluded.pack,linked_by=excluded.linked_by,linked_at=now();
end $$;
-- Removing a code that is not there is fine: the phone may send the same removal twice.
create function public.unlink_barcode(device_id uuid,barcode text) returns void language plpgsql security definer set search_path='' as $$
declare rid uuid:=public.stok_member(device_id);begin
 delete from public.barcodes b where b.restaurant_id=rid and b.code=barcode;
end $$;
-- Everything the phone keeps, in one call: who is asking, whether this phone is paired, the team for the sign-in
-- screen, every bahan and every barcode. The last unit cost and the usual delivery go only to the roles that record
-- deliveries. No menu, no orders and no balances: a count stays blind, and the call stays small.
create function public.stock_app(device_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare member public.memberships%rowtype;r public.restaurants%rowtype;rid uuid;receiver boolean;begin
 select * into member from public.memberships where user_id=auth.uid() and active;
 if member.user_id is null then raise exception 'No active staff membership' using errcode='42501';end if;
 rid:=member.restaurant_id;select * into r from public.restaurants where id=rid;receiver:=member.role in ('owner','manager','admin');
 return jsonb_build_object('restaurantId',rid,'name',member.name,'role',member.role,'store',r.settings->>'name','timezone',r.settings->>'timezone','now',public.iso(now()),
 'device',public.device_json(rid,stock_app.device_id),'team',public.team_json(rid),
 'stock',(select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',i.id,'name',i.name,'unit',i.unit,'area',nullif(i.area,''),'packs',i.packs,'aliases',i.aliases,
  -- The same number bootstrap returns in costs: rupiah per thousandth of the base unit, from the latest priced stock-in.
  'cost',case when receiver then (select m.cost::numeric/m.qty from public.stock_movements m where m.restaurant_id=rid and m.stock_id=i.id and m.kind in ('purchase','production','transfer') and m.qty>0 and m.cost>0 order by m.occurred_at desc,m.received_at desc limit 1) end,
  -- PUR-4: the last five deliveries, oldest first, for the "is this amount usual" check.
  'usual',case when receiver then (select jsonb_agg(x.qty order by x.occurred_at) from (select m.qty,m.occurred_at from public.stock_movements m where m.restaurant_id=rid and m.stock_id=i.id and m.kind='purchase' and m.qty>0 order by m.occurred_at desc limit 5) x) end)) order by i.name),'[]') from public.inventory_items i where i.restaurant_id=rid),
 'barcodes',(select coalesce(jsonb_agg(jsonb_build_object('code',b.code,'stockId',b.stock_id,'pack',b.pack) order by b.code),'[]') from public.barcodes b where b.restaurant_id=rid));
end $$;
revoke all on function public.stok_member(uuid) from public,anon,authenticated;
revoke all on function public.enroll_phone(uuid),public.link_barcode(uuid,text,text,text),public.unlink_barcode(uuid,text),public.stock_app(uuid) from public,anon;
grant execute on function public.enroll_phone(uuid),public.link_barcode(uuid,text,text,text),public.unlink_barcode(uuid,text),public.stock_app(uuid) to authenticated;
