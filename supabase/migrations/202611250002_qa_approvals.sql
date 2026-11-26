-- QA fixes 2026-11-25, cluster voids: what a manager's approval covers (SEC-1) and the helpers the void branches of
-- apply_operation (202611250001_qa_fixes.sql) share. Each function is re-created from its latest definition
-- (use_approval, approve: 202611230001_maintenance; request_approval, approval_request, decide_approval: 202611170001_telegram;
-- telegram_request: 202611230001_maintenance).
--  - 'voidline': the approval of one made line, bound to the order AND the line (approvals.line_id) and to the line's value
--    as amount. 'void' of a whole order is bound to the order's total. The server compares both with its own figures when the
--    operation is applied, so what the manager saw is all an approval buys.
--  - 'discard': a manager's PIN at the till releases a refused operation from a cashier's queue. No operation consumes
--    it, the approval row is the audit trail; it carries no order, line or amount.
--  - The web app deployed before this asks for both voids as 'void' with no amount. apply_operation still accepts that old
--    form until supabase/pending/voids_strict.sql flips voids_strict().
alter table public.approvals add column line_id uuid;
alter table public.approval_requests add column line_id uuid;
alter table public.approvals drop constraint approvals_action_check;
alter table public.approvals add constraint approvals_action_check check(action in ('discount','void','voidline','refund','cashout','count','variance','publish','discard'));
alter table public.approval_requests drop constraint approval_requests_action_check;
alter table public.approval_requests add constraint approval_requests_action_check check(action in ('discount','void','voidline','refund','cashout','count','variance','publish','discard'));

-- A line's value before any discount: price plus options, times quantity. The same figure the till shows.
create function public.line_value(l jsonb) returns bigint language sql immutable set search_path='' as $$
 select (((l->>'price')::bigint+coalesce((select sum((m.value->>'price')::bigint) from jsonb_array_elements(l->'modifiers') m),0))*(l->>'qty')::bigint)::bigint $$;
-- One trim rule for what a till stores and the server stores as a reason: JavaScript's String.trim (CT-04).
create function public.trim_reason(t text) returns text language sql immutable set search_path='' as $$
 select regexp_replace(t,'^[\t\n\v\f\r    -     　﻿]+|[\t\n\v\f\r    -     　﻿]+$','','g') $$;
-- Whether the old form of a void approval ('void', no amount, for a line) is still accepted. Flipped by pending/voids_strict.sql.
create function public.voids_strict() returns boolean language sql immutable set search_path='' as $$ select false $$;
revoke all on function public.line_value(jsonb),public.trim_reason(text),public.voids_strict() from public,anon,authenticated;

-- Only apply_operation calls this. Marks the approval used and returns the approver's name. occurredAt is the till's word,
-- so the approval must also be spent within 12 hours (the offline limit) of when it was given, by the server's clock.
-- There is no lower bound on occurredAt: a till whose clock runs behind would have every approval refused.
-- line: the line a 'voidline' approval was given for; every other approval carries none.
drop function public.use_approval(uuid,uuid,text,uuid,bigint,uuid,timestamptz,uuid);
create function public.use_approval(rid uuid,actor uuid,act text,target uuid,amount bigint,opid uuid,occurred timestamptz,approval uuid,line uuid default null) returns text language plpgsql set search_path='' as $$
declare who text;begin
 update public.approvals a set operation_id=opid
 where a.id=approval and a.restaurant_id=rid and a.requested_by=actor and a.action=act and a.order_id is not distinct from target
 and a.amount is not distinct from use_approval.amount and a.line_id is not distinct from use_approval.line and a.operation_id is null and occurred<=a.created_at+interval '1 hour' and now()<=a.created_at+interval '12 hours'
 returning (select m.name from public.memberships m where m.restaurant_id=rid and m.user_id=a.approver) into who;
 if who is null then raise exception 'Manager approval required' using errcode='42501';end if;
 return who;
end $$;
revoke all on function public.use_approval(uuid,uuid,text,uuid,bigint,uuid,timestamptz,uuid,uuid) from public,anon,authenticated;

drop function public.approve(uuid,text,text,uuid,bigint);
create function public.approve(approver uuid,pin text,action text,order_id uuid default null,amount bigint default null,line_id uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid;who text;hash text;granted uuid;begin
 select m.restaurant_id into rid from public.memberships m where m.user_id=auth.uid() and m.active;
 if rid is null then raise exception 'No active staff membership' using errcode='42501';end if;
 if approve.action not in ('discount','void','voidline','refund','cashout','count','variance','publish','discard') then raise exception 'Unknown approval action';end if;
 if approve.action='voidline' and (approve.order_id is null or approve.line_id is null or approve.amount is null) then raise exception 'A line void approval needs the order, the line and its value';end if;
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
 insert into public.approvals(restaurant_id,approver,requested_by,action,order_id,amount,line_id)
 values(rid,approve.approver,auth.uid(),approve.action,case when approve.action='discard' then null else approve.order_id end,case when approve.action='discard' then null else approve.amount end,case when approve.action='voidline' then approve.line_id end) returning id into granted;
 return jsonb_build_object('id',granted,'by',who);
end $$;
revoke all on function public.approve(uuid,text,text,uuid,bigint,uuid) from public,anon;
grant execute on function public.approve(uuid,text,text,uuid,bigint,uuid) to authenticated;

-- The till asks. At most three open requests per person, so a stuck button cannot flood the managers.
drop function public.request_approval(text,uuid,bigint,text);
create function public.request_approval(action text,order_id uuid default null,amount bigint default null,what text default '',line_id uuid default null) returns uuid language plpgsql security definer set search_path='' as $$
declare rid uuid;made uuid;begin
 select m.restaurant_id into rid from public.memberships m where m.user_id=auth.uid() and m.active;
 if rid is null then raise exception 'No active staff membership' using errcode='42501';end if;
 if request_approval.action not in ('discount','void','voidline','refund','cashout','count','variance','publish','discard') then raise exception 'Unknown approval action';end if;
 if request_approval.action='voidline' and (request_approval.order_id is null or request_approval.line_id is null or request_approval.amount is null) then raise exception 'A line void approval needs the order, the line and its value';end if;
 if length(trim(coalesce(request_approval.what,''))) not between 1 and 300 then raise exception 'Describe the request in 1-300 characters';end if;
 if (select count(*) from public.approval_requests r where r.restaurant_id=rid and r.requested_by=auth.uid() and r.status='pending' and r.created_at>now()-interval '5 minutes')>=3 then raise exception 'Too many open approval requests';end if;
 insert into public.approval_requests(restaurant_id,requested_by,action,order_id,amount,what,line_id)
 values(rid,auth.uid(),request_approval.action,case when request_approval.action='discard' then null else request_approval.order_id end,case when request_approval.action='discard' then null else request_approval.amount end,trim(request_approval.what),case when request_approval.action='voidline' then request_approval.line_id end) returning approval_requests.id into made;
 return made;
end $$;
revoke all on function public.request_approval(text,uuid,bigint,text,uuid) from public,anon;
grant execute on function public.request_approval(text,uuid,bigint,text,uuid) to authenticated;

-- A manager taps Setujui or Tolak: only a linked, active owner or manager of the same restaurant, only
-- while the request is open, and the first answer wins. Approving creates the same one-use approval a
-- PIN at the till would, so apply_operation checks it exactly the same way (action, order, line, amount, 1 hour).
create or replace function public.decide_approval(request uuid,telegram_id bigint,accept boolean) returns jsonb language plpgsql security definer set search_path='' as $$
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
  insert into public.approvals(restaurant_id,approver,requested_by,action,order_id,amount,line_id) values(r.restaurant_id,who,r.requested_by,r.action,r.order_id,r.amount,r.line_id) returning id into granted;
 end if;
 update public.approval_requests a set status=case when accept then 'approved' else 'rejected' end,approval_id=granted,decided_by=who,decided_at=now() where a.id=r.id;
 return jsonb_build_object('status',case when accept then 'approved' else 'rejected' end,'by',whoname);
end $$;

-- Who hears about a request: every linked, active owner and manager of that restaurant, while it is open. What the
-- approval is bound to comes from the server, the order (receipt, label, status, total, the items not voided), the line
-- of a line void (name, quantity, value) or the count (area, number of lines); what is only the requester's own note.
create or replace function public.telegram_request(request uuid) returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('action',r.action,'amount',r.amount,'what',r.what,'by',m.name,
  'order',(select jsonb_build_object('receipt',o.snapshot->>'receiptId','label',o.snapshot->>'label','status',o.status,'total',(o.snapshot->'totals'->>'total')::bigint,
    'items',(select string_agg((x.value->>'qty')||'× '||(x.value->>'name'),', ') from jsonb_array_elements(o.snapshot->'lines') x where not coalesce((x.value->>'cancelled')::boolean,false)))
   from public.orders o where o.restaurant_id=r.restaurant_id and o.id=r.order_id),
  'line',(select jsonb_build_object('name',x.value->>'name','qty',(x.value->>'qty')::bigint,'total',public.line_value(x.value))
   from public.orders o,jsonb_array_elements(o.snapshot->'lines') x where o.restaurant_id=r.restaurant_id and o.id=r.order_id and r.line_id is not null and x.value->>'id'=r.line_id::text),
  'count',(select jsonb_build_object('area',c.area,'lines',jsonb_array_length(c.lines)) from public.counts c where c.restaurant_id=r.restaurant_id and c.id=r.order_id),
  'chats',(select coalesce(jsonb_agg(l.chat_id),'[]') from public.telegram_links l join public.memberships a on a.restaurant_id=l.restaurant_id and a.user_id=l.user_id
   where l.restaurant_id=r.restaurant_id and a.active and a.role in ('owner','manager')))
 from public.approval_requests r join public.memberships m on m.restaurant_id=r.restaurant_id and m.user_id=r.requested_by
 where r.id=request and r.status='pending' and r.created_at>now()-interval '5 minutes' $$;
