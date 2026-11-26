-- QA fixes, 2026-11-25, cluster pull: what a device receives at sign-in (bootstrap) and from pull.
-- Checks: scripts/db-checks/qa-pull.mjs. apply_operation's side of these (settings.update, the new order's pricing
-- copy) is in 202611250001_qa_fixes.sql.

-- HARNESS-F2: tax, service and packaging replaced by a settings save are kept here 13 hours, as retired_discounts keeps
-- saved discounts, so a till that priced an order by its own copy before its next pull still lands it (order.save).
alter table public.restaurants add column retired_pricing jsonb not null default '[]';

-- CAT-1, STK-04, SYNC-12: purchase orders, suppliers and catering orders ride in pull, so they need "changed since":
-- received_at as orders have, stamped by the server on every insert and update whoever writes the row.
alter table public.purchase_orders add column received_at timestamptz not null default now();
alter table public.suppliers add column received_at timestamptz not null default now();
alter table public.sales_orders add column received_at timestamptz not null default now();
create function public.touch_received() returns trigger language plpgsql set search_path='' as $$
begin new.received_at:=now();return new;end $$;
create trigger touch_received before update on public.purchase_orders for each row execute function public.touch_received();
create trigger touch_received before update on public.suppliers for each row execute function public.touch_received();
create trigger touch_received before update on public.sales_orders for each row execute function public.touch_received();
create index purchase_orders_received on public.purchase_orders(restaurant_id,received_at);
create index suppliers_received on public.suppliers(restaurant_id,received_at);
create index sales_orders_received on public.sales_orders(restaurant_id,received_at);

-- pull, from 202611160012_menu_remove.sql. New: purchase orders and suppliers for the office, catering orders for the
-- roles that work them (owner, manager, admin: the sales_orders policy, SEC-1), counts to every role that can count
-- (STK-02, STK-03), and who the signed-in person is now (member). refresh=true sends the catalog and settings whatever
-- the cursor: the device asks for it after a catalog or settings operation it skipped the pulled copy for is gone (F1).
-- A new parameter is a new signature, so the old one goes (an overload would be ambiguous to PostgREST); old clients
-- send only since and device_id, which still fits.
drop function public.pull(timestamptz,uuid);
create function public.pull(since timestamptz,device_id uuid default null,refresh boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare member public.memberships%rowtype;r public.restaurants%rowtype;rid uuid;office boolean;managers boolean;documents boolean;open_shift uuid;result jsonb;begin
 select * into member from public.memberships where user_id=auth.uid() and active;
 if member.user_id is null then raise exception 'No active staff membership' using errcode='42501';end if;
 rid:=member.restaurant_id;select * into r from public.restaurants where id=rid;
 office:=member.role in ('owner','manager','admin','chef');managers:=member.role in ('owner','manager');documents:=member.role in ('owner','manager','admin');
 select id into open_shift from public.shifts where restaurant_id=rid and closed_at is null;
 result:=jsonb_build_object('now',public.iso(now()),'device',public.device_json(rid,device_id),'member',jsonb_build_object('role',member.role,'active',member.active),
 'orders',(select coalesce(jsonb_agg(o.snapshot order by o.created_at),'[]') from public.orders o where o.restaurant_id=rid and o.received_at>since and (office or o.status='open' or o.shift_id=open_shift)),
 'shifts',(select coalesce(jsonb_agg(public.shift_json(s,managers) order by s.opened_at),'[]') from public.shifts s where s.restaurant_id=rid and s.received_at>since),
 'cash',(select coalesce(jsonb_agg(public.cash_json(cm) order by cm.occurred_at),'[]') from public.cash_movements cm where cm.restaurant_id=rid and cm.received_at>since and (office or cm.shift_id=open_shift)),
 'movements',(select coalesce(jsonb_agg(public.movement_json(m) order by m.received_at),'[]') from public.stock_movements m where m.restaurant_id=rid and m.received_at>since),
 'counts',(select coalesce(jsonb_agg(public.count_json(c) order by c.occurred_at),'[]') from public.counts c where c.restaurant_id=rid and c.received_at>since and member.role<>'accountant'),
 'purchaseOrders',(select coalesce(jsonb_agg(po.snapshot order by po.received_at),'[]') from public.purchase_orders po where po.restaurant_id=rid and po.received_at>since and office),
 'suppliers',(select coalesce(jsonb_agg(su.snapshot order by su.received_at),'[]') from public.suppliers su where su.restaurant_id=rid and su.received_at>since and office),
 'salesOrders',(select coalesce(jsonb_agg(so.snapshot order by so.received_at),'[]') from public.sales_orders so where so.restaurant_id=rid and so.received_at>since and documents));
 if refresh or r.catalog_at>since or exists(select 1 from public.catalog_versions where restaurant_id=rid and created_at>since) or exists(select 1 from public.inventory_items where restaurant_id=rid and updated_at>since) then result:=result||jsonb_build_object('catalog',public.catalog_json(rid));end if;
 if refresh or r.settings_at>since then result:=result||jsonb_build_object('settings',r.settings);end if;
 return result;
end $$;
revoke all on function public.pull(timestamptz,uuid,boolean) from public,anon;
grant execute on function public.pull(timestamptz,uuid,boolean) to authenticated;

-- bootstrap, from 202611060009_takar.sql. New: catering orders only for owner, manager and admin (SEC-1), counts to
-- every role that can count (STK-02, STK-03), and the stock history the device's alerts read (STK-06): the movements
-- of the last 8 days one by one, as pull sends them, and one baseline row per item for everything older. Rows received
-- recent rows carry their id, so the first pull (its cursor starts 10 s back) upserts them, never twice; the baseline leaves
-- out what came in the last 10 seconds, which the same pull brings.
create or replace function public.bootstrap(device_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid;member public.memberships%rowtype;r public.restaurants%rowtype;office boolean;managers boolean;documents boolean;cut timestamptz:=now()-interval '8 days';begin
 select * into member from public.memberships where user_id=auth.uid() and active;
 if member.user_id is null then raise exception 'No active staff membership' using errcode='42501';end if;
 rid:=member.restaurant_id;select * into r from public.restaurants where id=rid;
 office:=member.role in ('owner','manager','admin','chef');managers:=member.role in ('owner','manager');documents:=member.role in ('owner','manager','admin');
 return public.catalog_json(rid)||jsonb_build_object('restaurantId',rid,'name',member.name,'role',member.role,'primary',coalesce(r.primary_device_id=device_id,false),'settings',r.settings,'now',public.iso(now()),
 'device',public.device_json(rid,device_id),'team',public.team_json(rid),
 'purchaseOrders',(select coalesce(jsonb_agg(x.snapshot),'[]') from (select snapshot from public.purchase_orders where restaurant_id=rid and office order by created_at desc limit 200) x),
 'suppliers',(select coalesce(jsonb_agg(snapshot order by snapshot->>'name'),'[]') from public.suppliers where restaurant_id=rid and office),
 'salesOrders',(select coalesce(jsonb_agg(x.snapshot),'[]') from (select snapshot from public.sales_orders where restaurant_id=rid and documents order by deliver_at desc limit 300) x),
 'outletData',case when documents then public.outlet_transfers() end,
 'costs',(select coalesce(jsonb_object_agg(c.stock_id,c.unit),'{}') from (select distinct on (m.stock_id) m.stock_id,m.cost::numeric/m.qty as unit from public.stock_movements m where m.restaurant_id=rid and m.kind in ('purchase','production','transfer') and m.qty>0 and m.cost>0 order by m.stock_id,m.occurred_at desc,m.received_at desc) c),
 'counts',(select coalesce(jsonb_agg(public.count_json(c) order by c.occurred_at),'[]') from (select * from public.counts where restaurant_id=rid and member.role<>'accountant' order by occurred_at desc limit 50) c),
 'orders',(select coalesce(jsonb_agg(x.snapshot),'[]') from (select snapshot from public.orders where restaurant_id=rid and (office or status='open' or shift_id in (select id from public.shifts where restaurant_id=rid and closed_at is null)) order by created_at desc limit 500) x),
 'shifts',(select coalesce(jsonb_agg(public.shift_json(s,managers)),'[]') from (select * from public.shifts where restaurant_id=rid order by opened_at desc limit 30) s),
 'cash',(select coalesce(jsonb_agg(public.cash_json(cm)),'[]') from public.cash_movements cm join public.shifts s on s.restaurant_id=cm.restaurant_id and s.id=cm.shift_id where cm.restaurant_id=rid and (s.closed_at is null or office and s.opened_at>now()-interval '31 days')),
 'movements',(select coalesce(jsonb_agg(jsonb_build_object('id','baseline-'||b.stock_id,'stockId',b.stock_id,'qty',b.qty,'kind','opening','reason','Saldo agregat server saat sinkronisasi awal','actor',auth.uid(),'at',public.iso(cut),'recordId','server-baseline','cost',0)),'[]') from (select stock_id,sum(qty) as qty from public.stock_movements where restaurant_id=rid and occurred_at<=cut and received_at<=now()-interval '10 seconds' group by stock_id) b)
  ||(select coalesce(jsonb_agg(public.movement_json(m) order by m.occurred_at),'[]') from public.stock_movements m where m.restaurant_id=rid and m.occurred_at>cut));
end $$;
