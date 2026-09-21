-- All money is integer IDR. Ingredient quantities are thousandths of a base unit.
create table public.restaurants (
 id uuid primary key default gen_random_uuid(), settings jsonb not null,
 primary_device_id uuid, created_at timestamptz not null default now(),
 constraint settings_shape check (jsonb_typeof(settings)='object' and settings->>'name' <> '')
);
create table public.memberships (
 restaurant_id uuid not null references public.restaurants(id), user_id uuid not null references auth.users(id),
 role text not null check(role in ('owner','manager','cashier')), name text not null check(length(name) between 1 and 100), active boolean not null default true,
 primary key(restaurant_id,user_id), unique(user_id)
);
create table public.devices (
 restaurant_id uuid not null references public.restaurants(id), id uuid not null, enrolled_by uuid not null,
 enrolled_at timestamptz not null default now(), revoked_at timestamptz,
 primary key(restaurant_id,id), foreign key(restaurant_id,enrolled_by) references public.memberships(restaurant_id,user_id)
);
alter table public.restaurants add constraint restaurant_device_fk foreign key(id,primary_device_id) references public.devices(restaurant_id,id);
create table public.inventory_items (
 restaurant_id uuid not null references public.restaurants(id), id text not null, name text not null,
 unit text not null check(unit in ('g','ml','pcs')), threshold bigint not null check(threshold between 0 and 1000000000000),
 primary key(restaurant_id,id)
);
create table public.catalog_versions (
 restaurant_id uuid not null references public.restaurants(id), item_id text not null, version integer not null check(version>0),
 snapshot jsonb not null, created_at timestamptz not null default now(),
 primary key(restaurant_id,item_id,version), check((snapshot->>'price')::bigint between 0 and 1000000000)
);
create table public.catalog_items (
 restaurant_id uuid not null, id text not null, version integer not null,
 primary key(restaurant_id,id), foreign key(restaurant_id,id,version) references public.catalog_versions(restaurant_id,item_id,version)
);
-- Versioned recipes/add-on recipes are part of immutable catalog snapshots.
create table public.shifts (
 restaurant_id uuid not null references public.restaurants(id), id uuid not null, actor uuid not null, device_id uuid not null,
 opened_at timestamptz not null, expires_at timestamptz not null, closed_at timestamptz,
 opening bigint not null check(opening between 0 and 1000000000), counted bigint check(counted between 0 and 1000000000), expected bigint, variance bigint,
 cashier text not null, catalog jsonb not null,
 primary key(restaurant_id,id), foreign key(restaurant_id,actor) references public.memberships(restaurant_id,user_id),foreign key(restaurant_id,device_id) references public.devices(restaurant_id,id),
 check(expires_at>opened_at and expires_at<=opened_at+interval '12 hours')
);
create unique index one_open_shift on public.shifts(restaurant_id) where closed_at is null;
create table public.orders (
 restaurant_id uuid not null, id uuid not null, shift_id uuid not null, actor uuid not null,
 revision integer not null check(revision>0), status text not null check(status in ('open','paid','void','refunded')),
 created_at timestamptz not null, updated_at timestamptz not null, received_at timestamptz not null default now(),
 snapshot jsonb not null, primary key(restaurant_id,id),
 foreign key(restaurant_id,shift_id) references public.shifts(restaurant_id,id),foreign key(restaurant_id,actor) references public.memberships(restaurant_id,user_id)
);
create unique index order_receipt_unique on public.orders(restaurant_id,(snapshot->>'receiptId'));
create index orders_date on public.orders(restaurant_id,created_at desc);
create index orders_shift on public.orders(restaurant_id,shift_id,status);
create table public.order_lines (
 restaurant_id uuid not null, order_id uuid not null, id uuid not null, item_id text not null, catalog_version integer not null, snapshot jsonb not null,
 primary key(restaurant_id,order_id,id),foreign key(restaurant_id,order_id) references public.orders(restaurant_id,id),
 foreign key(restaurant_id,item_id,catalog_version) references public.catalog_versions(restaurant_id,item_id,version),
 check((snapshot->>'qty')::integer between 1 and 999)
);
create table public.sync_operations (
 id uuid primary key,restaurant_id uuid not null references public.restaurants(id),actor uuid not null,device_id uuid not null,
 kind text not null,payload jsonb not null,occurred_at timestamptz not null,received_at timestamptz not null default now(),result jsonb not null,
 foreign key(restaurant_id,actor) references public.memberships(restaurant_id,user_id),foreign key(restaurant_id,device_id) references public.devices(restaurant_id,id)
);
create index operations_restaurant on public.sync_operations(restaurant_id,received_at);
create table public.payments (
 restaurant_id uuid not null,order_id uuid not null,operation_id uuid not null unique,
 method text not null check(method in ('cash','qris','card')),total bigint not null check(total between 0 and 1000000000),
 tendered bigint not null check(tendered between 0 and 1000000000),change bigint not null check(change>=0),verified boolean not null check(verified),
 occurred_at timestamptz not null,received_at timestamptz not null default now(),actor uuid not null,
 primary key(restaurant_id,order_id),foreign key(restaurant_id,order_id) references public.orders(restaurant_id,id),foreign key(restaurant_id,actor) references public.memberships(restaurant_id,user_id),check(tendered=total+change)
);
create index payments_date on public.payments(restaurant_id,occurred_at);
create table public.preparations (
 restaurant_id uuid not null,order_id uuid not null,line_id uuid not null,operation_id uuid not null,occurred_at timestamptz not null,actor uuid not null,
 primary key(restaurant_id,order_id,line_id),foreign key(restaurant_id,order_id,line_id) references public.order_lines(restaurant_id,order_id,id),foreign key(restaurant_id,actor) references public.memberships(restaurant_id,user_id)
);
create table public.purchases (
 restaurant_id uuid not null,id uuid not null,stock_id text not null,qty bigint not null check(qty>0),cost bigint not null check(cost between 0 and 1000000000),reason text not null,actor uuid not null,occurred_at timestamptz not null,
 primary key(restaurant_id,id),foreign key(restaurant_id,stock_id) references public.inventory_items(restaurant_id,id),foreign key(restaurant_id,actor) references public.memberships(restaurant_id,user_id)
);
create table public.stock_movements (
 restaurant_id uuid not null,id text not null,stock_id text not null,qty bigint not null check(qty between -1000000000000 and 1000000000000),
 kind text not null check(kind in ('opening','purchase','waste','count','adjustment','preparation')),reason text not null check(length(reason)>0),actor uuid not null,occurred_at timestamptz not null,received_at timestamptz not null default now(),record_id text not null,operation_id uuid not null,cost bigint not null default 0 check(cost between 0 and 1000000000),
 primary key(restaurant_id,id),foreign key(restaurant_id,stock_id) references public.inventory_items(restaurant_id,id),foreign key(restaurant_id,actor) references public.memberships(restaurant_id,user_id),unique(restaurant_id,operation_id,stock_id)
);
create index stock_balance_lookup on public.stock_movements(restaurant_id,stock_id);
create table public.cash_movements (
 restaurant_id uuid not null,id uuid not null,shift_id uuid not null,amount bigint not null check(amount between -1000000000 and 1000000000),reason text not null check(length(reason)>0),actor uuid not null,occurred_at timestamptz not null,purchase_id uuid,
 primary key(restaurant_id,id),foreign key(restaurant_id,shift_id) references public.shifts(restaurant_id,id),foreign key(restaurant_id,actor) references public.memberships(restaurant_id,user_id),foreign key(restaurant_id,purchase_id) references public.purchases(restaurant_id,id),unique(restaurant_id,purchase_id)
);
create table public.refunds (
 restaurant_id uuid not null,order_id uuid not null,operation_id uuid not null unique,amount bigint not null check(amount between 0 and 1000000000),reason text not null check(length(reason)>0),actor uuid not null,occurred_at timestamptz not null,received_at timestamptz not null default now(),
 primary key(restaurant_id,order_id),foreign key(restaurant_id,order_id) references public.payments(restaurant_id,order_id),foreign key(restaurant_id,actor) references public.memberships(restaurant_id,user_id)
);
create index refunds_date on public.refunds(restaurant_id,occurred_at);
-- SECURITY DEFINER is needed solely to read membership for RLS without recursion.
create function public.member_role(rid uuid) returns text language sql stable security definer set search_path='' as $$
 select role from public.memberships where restaurant_id=rid and user_id=auth.uid() and active
$$;
revoke all on function public.member_role(uuid) from public;grant execute on function public.member_role(uuid) to authenticated;
do $$ declare t text; begin
 foreach t in array array['restaurants','memberships','devices','inventory_items','catalog_versions','catalog_items','shifts','orders','order_lines','sync_operations','payments','preparations','purchases','stock_movements','cash_movements','refunds'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from anon, authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 if t='restaurants' then execute 'create policy member_read on public.restaurants for select to authenticated using (public.member_role(id) is not null)';
 else execute format('create policy member_read on public.%I for select to authenticated using (public.member_role(restaurant_id) is not null)',t);end if;
 end loop;
end $$;
create view public.stock_balances with (security_invoker=true) as select restaurant_id,stock_id,sum(qty)::bigint as qty from public.stock_movements group by restaurant_id,stock_id;
grant select on public.stock_balances to authenticated;
-- Internal validation helpers: no direct API execution.
create function public.validate_recipe(rid uuid,recipe jsonb) returns void language plpgsql set search_path='' as $$
declare r jsonb;seen text[]:='{}';begin
 if jsonb_typeof(recipe)<>'array' or jsonb_array_length(recipe)>100 then raise exception 'Invalid recipe';end if;
 for r in select value from jsonb_array_elements(recipe) loop
 if r->>'stockId'=any(seen) or (r->>'qty')::numeric<>trunc((r->>'qty')::numeric) or (r->>'qty')::bigint not between 1 and 1000000000 or not exists(select 1 from public.inventory_items where restaurant_id=rid and id=r->>'stockId') then raise exception 'Invalid ingredient';end if;
 seen:=array_append(seen,r->>'stockId');end loop;
end $$;
create function public.calculate_total(lines jsonb,discount bigint,settings jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare l jsonb;m jsonb;sub bigint:=0;price bigint;service bigint;tax bigint;sb integer:=(settings->>'serviceBps')::integer;tb integer:=(settings->>'taxBps')::integer;begin
 if sb not between 0 and 10000 or tb not between 0 and 10000 then raise exception 'Invalid charge';end if;
 for l in select value from jsonb_array_elements(lines) loop
 if not coalesce((l->>'cancelled')::boolean,false) then
 if (l->>'qty')::numeric<>trunc((l->>'qty')::numeric) or (l->>'qty')::int not between 1 and 999 then raise exception 'Invalid quantity';end if;
 price:=(l->>'price')::bigint;
 for m in select value from jsonb_array_elements(l->'modifiers') loop price:=price+(m->>'price')::bigint;end loop;
 sub:=sub+price*(l->>'qty')::integer;
 end if;end loop;
 if sub not between 0 and 1000000000 or discount not between 0 and sub then raise exception 'Invalid total/discount';end if;
 service:=((sub-discount)*sb+5000)/10000;tax:=((sub-discount+service)*tb+5000)/10000;
 if sub-discount+service+tax>1000000000 then raise exception 'Total too large';end if;
 return jsonb_build_object('subtotal',sub,'discount',discount,'service',service,'tax',tax,'total',sub-discount+service+tax);
end $$;
revoke all on function public.validate_recipe(uuid,jsonb),public.calculate_total(jsonb,bigint,jsonb) from public;
