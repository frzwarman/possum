create function public.enroll_device(device_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare rid uuid;role text;primary_id uuid;begin
 select restaurant_id,m.role into rid,role from public.memberships m where user_id=auth.uid() and active;
 if role not in ('owner','manager') or role is null then raise exception 'Manager required' using errcode='42501';end if;
 select primary_device_id into primary_id from public.restaurants where id=rid for update;
 if primary_id is not null and primary_id<>device_id then raise exception 'Primary already assigned: explicit reconciled handover required';end if;
 insert into public.devices(restaurant_id,id,enrolled_by) values(rid,device_id,auth.uid()) on conflict do nothing;
 update public.restaurants set primary_device_id=device_id where id=rid;
end $$;
-- Manager attests old-device reconciliation; server additionally requires every shift closed.
create function public.handover_device(new_device_id uuid,old_device_id uuid,reconciliation_note text) returns void language plpgsql security definer set search_path='' as $$
declare rid uuid;role text;old_id uuid;begin
 select restaurant_id,m.role into rid,role from public.memberships m where user_id=auth.uid() and active;
 if role<>'owner' or role is null or length(trim(reconciliation_note))<15 then raise exception 'Owner and reconciliation note required';end if;
 select primary_device_id into old_id from public.restaurants where id=rid for update;
 if old_id<>old_device_id or exists(select 1 from public.shifts where restaurant_id=rid and closed_at is null) then raise exception 'Reconcile and close old shift first';end if;
 update public.devices set revoked_at=now() where restaurant_id=rid and id=old_id;
 insert into public.devices(restaurant_id,id,enrolled_by) values(rid,new_device_id,auth.uid()) on conflict(restaurant_id,id) do update set revoked_at=null;
 update public.restaurants set primary_device_id=new_device_id where id=rid;
 insert into public.device_handovers(restaurant_id,old_device,new_device,actor,note) values(rid,old_id,new_device_id,auth.uid(),reconciliation_note);
end $$;
create table public.device_handovers(id uuid primary key default gen_random_uuid(),restaurant_id uuid not null references public.restaurants(id),old_device uuid not null,new_device uuid not null,actor uuid not null,note text not null,at timestamptz not null default now(),foreign key(restaurant_id,actor) references public.memberships(restaurant_id,user_id));
alter table public.device_handovers enable row level security;
create policy manager_read on public.device_handovers for select to authenticated using(public.member_role(restaurant_id) in ('owner','manager'));
grant select on public.device_handovers to authenticated;
create function public.bootstrap(device_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid;member public.memberships%rowtype;r public.restaurants%rowtype;begin
 select * into member from public.memberships where user_id=auth.uid() and active;
 if member.user_id is null then raise exception 'No active staff membership' using errcode='42501';end if;
 rid:=member.restaurant_id;select * into r from public.restaurants where id=rid;
 return jsonb_build_object('restaurantId',rid,'name',member.name,'role',member.role,'primary',coalesce(r.primary_device_id=device_id,false),'settings',r.settings,
 'menu',(select coalesce(jsonb_agg(v.snapshot),'[]') from public.catalog_items c join public.catalog_versions v on v.restaurant_id=c.restaurant_id and v.item_id=c.id and v.version=c.version where c.restaurant_id=rid),
 'stock',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'unit',unit,'threshold',threshold)),'[]') from public.inventory_items where restaurant_id=rid),
 'orders',(select coalesce(jsonb_agg(x.snapshot),'[]') from (select snapshot from public.orders where restaurant_id=rid order by created_at desc limit 500) x),
 'shifts',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'actor',actor,'cashier',cashier,'openedAt',opened_at,'expiresAt',expires_at,'opening',opening,'status',case when closed_at is null then 'open' else 'closed' end,'closedAt',closed_at,'counted',counted,'expected',expected,'variance',variance)),'[]') from (select * from public.shifts where restaurant_id=rid order by opened_at desc limit 30) s),
 'cash',(select coalesce(jsonb_agg(jsonb_build_object('id',cm.id,'shiftId',shift_id,'amount',amount,'reason',reason,'actor',cm.actor,'at',occurred_at,'recordId',purchase_id)),'[]') from public.cash_movements cm join public.shifts s on s.restaurant_id=cm.restaurant_id and s.id=cm.shift_id where cm.restaurant_id=rid and s.closed_at is null),
 'movements',(select coalesce(jsonb_agg(jsonb_build_object('id','baseline-'||stock_id,'stockId',stock_id,'qty',qty,'kind','opening','reason','Saldo agregat server saat sinkronisasi awal','actor',auth.uid(),'at',now(),'recordId','server-baseline','cost',0)),'[]') from public.stock_balances where restaurant_id=rid));
end $$;
create function public.sales_report(from_day date,to_day date) returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid;config jsonb;tz text;cut integer;start_at timestamptz;end_at timestamptz;begin
 select restaurant_id into rid from public.memberships where user_id=auth.uid() and active and role in ('owner','manager');
 if rid is null then raise exception 'Manager required' using errcode='42501';end if;
 if to_day<from_day or to_day-from_day>366 then raise exception 'Report range limited to 367 days';end if;
 select settings into config from public.restaurants where id=rid;tz:=config->>'timezone';cut:=(config->>'cutoff')::int;
 start_at:=(from_day::timestamp+make_interval(hours=>cut)) at time zone tz;end_at:=((to_day+1)::timestamp+make_interval(hours=>cut)) at time zone tz;
 return jsonb_build_object('from',from_day,'to',to_day,'asOf',now(),
 'sales',(select coalesce(sum(total),0) from public.payments where restaurant_id=rid and occurred_at>=start_at and occurred_at<end_at),
 'transactions',(select count(*) from public.payments where restaurant_id=rid and occurred_at>=start_at and occurred_at<end_at),
 'refunds',(select coalesce(sum(amount),0) from public.refunds where restaurant_id=rid and occurred_at>=start_at and occurred_at<end_at),
 'discounts',(select coalesce(sum((o.snapshot->>'discount')::bigint),0) from public.orders o join public.payments p on p.restaurant_id=o.restaurant_id and p.order_id=o.id where p.restaurant_id=rid and p.occurred_at>=start_at and p.occurred_at<end_at),
 'outstanding',(select coalesce(sum((snapshot->'totals'->>'total')::bigint),0) from public.orders where restaurant_id=rid and status='open' and created_at>=start_at and created_at<end_at),
 'methods',(select coalesce(jsonb_object_agg(method,total),'{}') from (select method,sum(total) as total from public.payments where restaurant_id=rid and occurred_at>=start_at and occurred_at<end_at group by method) x),
 'bestSellers',(select coalesce(jsonb_agg(x),'[]') from (select l.snapshot->>'name' as name,sum((l.snapshot->>'qty')::bigint) as quantity from public.order_lines l join public.payments p on p.restaurant_id=l.restaurant_id and p.order_id=l.order_id where p.restaurant_id=rid and p.occurred_at>=start_at and p.occurred_at<end_at group by l.snapshot->>'name' order by quantity desc limit 10) x));
end $$;
revoke all on function public.enroll_device(uuid),public.handover_device(uuid,uuid,text),public.bootstrap(uuid),public.sales_report(date,date) from public,anon;
grant execute on function public.enroll_device(uuid),public.handover_device(uuid,uuid,text),public.bootstrap(uuid),public.sales_report(date,date) to authenticated;
