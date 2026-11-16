-- Telegram for owners and managers: approve a cashier's request from the phone, a report every morning
-- and an alert when a shift closes with a cash gap over the limit. The edge function `telegram` (service
-- role) is the only caller of the service-role functions below; the till only asks and waits.
create table public.telegram_links(
 restaurant_id uuid not null,user_id uuid not null,telegram_id bigint not null unique,chat_id bigint not null,linked_at timestamptz not null default now(),
 primary key(restaurant_id,user_id),foreign key(restaurant_id,user_id) references public.memberships(restaurant_id,user_id)
);
create table public.telegram_codes(
 code text primary key,restaurant_id uuid not null,user_id uuid not null,expires_at timestamptz not null,
 foreign key(restaurant_id,user_id) references public.memberships(restaurant_id,user_id)
);
create table public.approval_requests(
 id uuid primary key default gen_random_uuid(),restaurant_id uuid not null,requested_by uuid not null,
 action text not null check(action in ('discount','void','refund','cashout','count','variance','publish')),
 order_id uuid,amount bigint check(amount between 0 and 1000000000),what text not null check(length(what) between 1 and 300),
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 approval_id uuid references public.approvals(id),decided_by uuid,created_at timestamptz not null default now(),decided_at timestamptz,
 foreign key(restaurant_id,requested_by) references public.memberships(restaurant_id,user_id),
 foreign key(restaurant_id,decided_by) references public.memberships(restaurant_id,user_id)
);
create index approval_requests_open on public.approval_requests(restaurant_id,requested_by,created_at) where status='pending';
-- Shifts received after checked_until are looked at on the next alert run.
create table public.telegram_alert_cursor(restaurant_id uuid primary key references public.restaurants(id),checked_until timestamptz not null);
alter table public.telegram_links enable row level security;
alter table public.telegram_codes enable row level security;
alter table public.approval_requests enable row level security;
alter table public.telegram_alert_cursor enable row level security;
revoke all on public.telegram_links,public.telegram_codes,public.approval_requests,public.telegram_alert_cursor from anon,authenticated;

-- The till asks. At most three open requests per person, so a stuck button cannot flood the managers.
create function public.request_approval(action text,order_id uuid default null,amount bigint default null,what text default '') returns uuid language plpgsql security definer set search_path='' as $$
declare rid uuid;made uuid;begin
 select m.restaurant_id into rid from public.memberships m where m.user_id=auth.uid() and m.active;
 if rid is null then raise exception 'No active staff membership' using errcode='42501';end if;
 if request_approval.action not in ('discount','void','refund','cashout','count','variance','publish') then raise exception 'Unknown approval action';end if;
 if length(trim(coalesce(request_approval.what,''))) not between 1 and 300 then raise exception 'Describe the request in 1-300 characters';end if;
 if (select count(*) from public.approval_requests r where r.restaurant_id=rid and r.requested_by=auth.uid() and r.status='pending' and r.created_at>now()-interval '5 minutes')>=3 then raise exception 'Too many open approval requests';end if;
 insert into public.approval_requests(restaurant_id,requested_by,action,order_id,amount,what)
 values(rid,auth.uid(),request_approval.action,request_approval.order_id,request_approval.amount,trim(request_approval.what)) returning approval_requests.id into made;
 return made;
end $$;
-- The till waits on its own request: pending, approved (with the one-use approval), rejected or expired.
create function public.approval_request(request uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.approval_requests%rowtype;who text;begin
 select * into r from public.approval_requests a where a.id=request and a.requested_by=auth.uid();
 if r.id is null then raise exception 'Approval request not found' using errcode='42501';end if;
 select m.name into who from public.memberships m where m.restaurant_id=r.restaurant_id and m.user_id=r.decided_by;
 return jsonb_build_object('status',case when r.status='pending' and r.created_at<=now()-interval '5 minutes' then 'expired' else r.status end,'id',r.approval_id,'by',who);
end $$;
-- An owner or manager links their Telegram: the bot opens with /start <code>, valid for 15 minutes.
create function public.telegram_code() returns text language plpgsql security definer set search_path='' as $$
declare rid uuid;made text;begin
 select restaurant_id into rid from public.memberships where user_id=auth.uid() and active and role in ('owner','manager');
 if rid is null then raise exception 'Manager required' using errcode='42501';end if;
 delete from public.telegram_codes c where c.user_id=auth.uid() or c.expires_at<now();
 made:=encode(extensions.gen_random_bytes(12),'hex');
 insert into public.telegram_codes values(made,rid,auth.uid(),now()+interval '15 minutes');
 return made;
end $$;
create function public.telegram_status() returns boolean language sql security definer set search_path='' as $$
 select exists(select 1 from public.telegram_links where user_id=auth.uid()) $$;
create function public.telegram_unlink() returns void language sql security definer set search_path='' as $$
 delete from public.telegram_links where user_id=auth.uid() $$;
revoke all on function public.request_approval(text,uuid,bigint,text),public.approval_request(uuid),public.telegram_code(),public.telegram_status(),public.telegram_unlink() from public,anon;
grant execute on function public.request_approval(text,uuid,bigint,text),public.approval_request(uuid),public.telegram_code(),public.telegram_status(),public.telegram_unlink() to authenticated;

-- Service role only, called by the edge function. /start <code> links one Telegram account to one
-- active owner or manager; linking again moves it.
create function public.telegram_link(code text,telegram_id bigint,chat_id bigint) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.telegram_codes%rowtype;who text;place text;begin
 delete from public.telegram_codes t where t.code=telegram_link.code and t.expires_at>now() returning * into c;
 if c.code is null then return '{"error":"code"}';end if;
 select m.name into who from public.memberships m where m.restaurant_id=c.restaurant_id and m.user_id=c.user_id and m.active and m.role in ('owner','manager');
 if who is null then return '{"error":"role"}';end if;
 delete from public.telegram_links l where l.telegram_id=telegram_link.telegram_id or (l.restaurant_id=c.restaurant_id and l.user_id=c.user_id);
 insert into public.telegram_links(restaurant_id,user_id,telegram_id,chat_id) values(c.restaurant_id,c.user_id,telegram_link.telegram_id,telegram_link.chat_id);
 insert into public.telegram_alert_cursor values(c.restaurant_id,now()) on conflict do nothing;
 select r.settings->>'name' into place from public.restaurants r where r.id=c.restaurant_id;
 return jsonb_build_object('name',who,'restaurant',place);
end $$;
-- Who hears about a request: every linked, active owner and manager of that restaurant, while it is open.
create function public.telegram_request(request uuid) returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('action',r.action,'amount',r.amount,'what',r.what,'by',m.name,
  'chats',(select coalesce(jsonb_agg(l.chat_id),'[]') from public.telegram_links l join public.memberships a on a.restaurant_id=l.restaurant_id and a.user_id=l.user_id
   where l.restaurant_id=r.restaurant_id and a.active and a.role in ('owner','manager')))
 from public.approval_requests r join public.memberships m on m.restaurant_id=r.restaurant_id and m.user_id=r.requested_by
 where r.id=request and r.status='pending' and r.created_at>now()-interval '5 minutes' $$;
-- A manager taps Setujui or Tolak: only a linked, active owner or manager of the same restaurant, only
-- while the request is open, and the first answer wins. Approving creates the same one-use approval a
-- PIN at the till would, so apply_operation checks it exactly the same way (action, order, amount, 1 hour).
create function public.decide_approval(request uuid,telegram_id bigint,accept boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.approval_requests%rowtype;who uuid;whoname text;granted uuid;begin
 select * into r from public.approval_requests a where a.id=request for update;
 if r.id is null then return '{"error":"missing"}';end if;
 select l.user_id,m.name into who,whoname from public.telegram_links l join public.memberships m on m.restaurant_id=l.restaurant_id and m.user_id=l.user_id
 where l.telegram_id=decide_approval.telegram_id and l.restaurant_id=r.restaurant_id and m.active and m.role in ('owner','manager');
 if who is null then return '{"error":"role"}';end if;
 if r.status<>'pending' then
  return jsonb_build_object('status',r.status,'by',(select m.name from public.memberships m where m.restaurant_id=r.restaurant_id and m.user_id=r.decided_by),'already',true);
 end if;
 if r.created_at<=now()-interval '5 minutes' then return '{"status":"expired"}';end if;
 if accept then
  insert into public.approvals(restaurant_id,approver,requested_by,action,order_id,amount) values(r.restaurant_id,who,r.requested_by,r.action,r.order_id,r.amount) returning id into granted;
 end if;
 update public.approval_requests a set status=case when accept then 'approved' else 'rejected' end,approval_id=granted,decided_by=who,decided_at=now() where a.id=r.id;
 return jsonb_build_object('status',case when accept then 'approved' else 'rejected' end,'by',whoname);
end $$;

-- The sales report body, shared by sales_report (a signed-in manager) and the Telegram morning report.
create function public.sales_summary(rid uuid,from_day date,to_day date) returns jsonb language plpgsql set search_path='' as $$
declare config jsonb;tz text;cut integer;start_at timestamptz;end_at timestamptz;begin
 select settings into config from public.restaurants where id=rid;tz:=config->>'timezone';cut:=(config->>'cutoff')::int;
 start_at:=(from_day::timestamp+make_interval(hours=>cut)) at time zone tz;end_at:=((to_day+1)::timestamp+make_interval(hours=>cut)) at time zone tz;
 return (with paid as (select p.method,p.edc,o.id,o.snapshot,(o.snapshot->'totals'->>'total')::bigint as total,o.snapshot->>'mode'='compliment' as comp from public.payments p join public.orders o on o.restaurant_id=p.restaurant_id and o.id=p.order_id where p.restaurant_id=rid and p.occurred_at>=start_at and p.occurred_at<end_at)
 select jsonb_build_object('from',from_day,'to',to_day,'asOf',now(),
 'sales',(select coalesce(sum(total),0) from paid where not comp),
 'transactions',(select count(*) from paid where not comp),
 'refunds',(select coalesce(sum(amount),0) from public.refunds where restaurant_id=rid and occurred_at>=start_at and occurred_at<end_at),
 'discounts',(select coalesce(sum((snapshot->>'discount')::bigint),0) from paid where not comp),
 'compliments',(select coalesce(sum((snapshot->>'discount')::bigint),0) from paid where comp),
 'outstanding',(select coalesce(sum((snapshot->'totals'->>'total')::bigint),0) from public.orders where restaurant_id=rid and status='open' and created_at>=start_at and created_at<end_at),
 'methods',(select coalesce(jsonb_object_agg(method,total),'{}') from (select method,sum(total) as total from paid group by method) x),
 'edcs',(select coalesce(jsonb_object_agg(edc,total),'{}') from (select edc,sum(total) as total from paid where edc is not null group by edc) x),
 'bestSellers',(select coalesce(jsonb_agg(x),'[]') from (select l.snapshot->>'name' as name,sum((l.snapshot->>'qty')::bigint) as quantity from public.order_lines l join paid on paid.id=l.order_id where l.restaurant_id=rid and not coalesce((l.snapshot->>'cancelled')::boolean,false) group by l.snapshot->>'name' order by quantity desc limit 10) x)));
end $$;
revoke all on function public.sales_summary(uuid,date,date) from public,anon,authenticated;
create or replace function public.sales_report(from_day date,to_day date) returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid;begin
 select restaurant_id into rid from public.memberships where user_id=auth.uid() and active and role in ('owner','manager');
 if rid is null then raise exception 'Manager required' using errcode='42501';end if;
 if to_day<from_day or to_day-from_day>366 then raise exception 'Report range limited to 367 days';end if;
 return public.sales_summary(rid,from_day,to_day);
end $$;
-- Run at 07:00 Jakarta: yesterday's business day (it ended at the cutoff) for each restaurant with a
-- linked owner or manager.
create function public.telegram_report() returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('restaurant',x.settings->>'name','chats',x.chats,'day',x.day,'report',public.sales_summary(x.id,x.day,x.day))),'[]')
 from (select r.id,r.settings,((now() at time zone (r.settings->>'timezone'))-make_interval(hours=>(r.settings->>'cutoff')::int))::date-1 as day,
  (select jsonb_agg(l.chat_id) from public.telegram_links l join public.memberships m on m.restaurant_id=l.restaurant_id and m.user_id=l.user_id
   where l.restaurant_id=r.id and m.active and m.role in ('owner','manager')) as chats
  from public.restaurants r) x where x.chats is not null $$;
-- Run every few minutes: shifts closed since the last run with a cash gap over the restaurant's limit.
-- ponytail: the cursor moves to the newest shift seen, so a close committed out of order in the same
-- instant can be skipped. Move to a per-shift "alerted" flag if that ever matters.
create function public.telegram_alerts() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;begin
 select coalesce(jsonb_agg(jsonb_build_object('restaurant',x.restaurant,'chats',x.chats,'alerts',x.alerts)),'[]') into result from (
  select r.settings->>'name' as restaurant,
   (select jsonb_agg(l.chat_id) from public.telegram_links l join public.memberships m on m.restaurant_id=l.restaurant_id and m.user_id=l.user_id
    where l.restaurant_id=r.id and m.active and m.role in ('owner','manager')) as chats,
   (select jsonb_agg(jsonb_build_object('kind','variance','cashier',s.cashier,'variance',s.variance,'limit',coalesce((r.settings->>'varianceLimit')::bigint,10000),'approvedBy',s.variance_approved_by) order by s.closed_at)
    from public.shifts s where s.restaurant_id=r.id and s.closed_at is not null and s.received_at>c.checked_until
    and abs(s.variance)>coalesce((r.settings->>'varianceLimit')::bigint,10000)) as alerts
  from public.telegram_alert_cursor c join public.restaurants r on r.id=c.restaurant_id) x
 where x.chats is not null and x.alerts is not null;
 update public.telegram_alert_cursor c set checked_until=coalesce((select max(s.received_at) from public.shifts s where s.restaurant_id=c.restaurant_id and s.closed_at is not null and s.received_at>c.checked_until),c.checked_until);
 return result;
end $$;
revoke all on function public.telegram_link(text,bigint,bigint),public.telegram_request(uuid),public.decide_approval(uuid,bigint,boolean),public.telegram_report(),public.telegram_alerts() from public,anon,authenticated;
grant execute on function public.telegram_link(text,bigint,bigint),public.telegram_request(uuid),public.decide_approval(uuid,bigint,boolean),public.telegram_report(),public.telegram_alerts() to service_role;
