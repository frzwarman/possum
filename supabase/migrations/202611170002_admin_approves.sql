-- Reviewer, 17 Nov: "Bikin admin lagi, yang bisa approval juga selain manager". An admin sets an approval PIN and types
-- it at the till to approve a cashier's void, discount or gap, like an owner or manager. Nothing else changes: an admin's
-- own actions still need someone's approval (apply_operation), and Telegram approvals stay with owners and managers.
create or replace function public.set_approval_pin(pin text) returns void language plpgsql security definer set search_path='' as $$
declare rid uuid;begin
 select restaurant_id into rid from public.memberships where user_id=auth.uid() and active and role in ('owner','manager','admin');
 if rid is null then raise exception 'Manager or admin required' using errcode='42501';end if;
 if pin is null or pin !~ '^[0-9]{6}$' or pin ~ '^(.)\1{5}$' or pin in ('123456','654321','012345','123123') then raise exception 'PIN must be 6 digits and not trivial';end if;
 insert into public.approval_pins(restaurant_id,user_id,pin_hash) values(rid,auth.uid(),extensions.crypt(pin,extensions.gen_salt('bf',8)))
 on conflict(restaurant_id,user_id) do update set pin_hash=excluded.pin_hash,updated_at=now();
end $$;
create or replace function public.approve(approver uuid,pin text,action text,order_id uuid default null,amount bigint default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid;who text;hash text;granted uuid;begin
 select m.restaurant_id into rid from public.memberships m where m.user_id=auth.uid() and m.active;
 if rid is null then raise exception 'No active staff membership' using errcode='42501';end if;
 if approve.action not in ('discount','void','refund','cashout','count','variance','publish') then raise exception 'Unknown approval action';end if;
 if (select count(*) from public.approval_failures f where f.restaurant_id=rid and f.at>now()-interval '5 minutes')>=3 then return '{"error":"locked"}';end if;
 select m.name,p.pin_hash into who,hash from public.memberships m left join public.approval_pins p on p.restaurant_id=m.restaurant_id and p.user_id=m.user_id
 where m.restaurant_id=rid and m.user_id=approve.approver and m.active and m.role in ('owner','manager','admin');
 if who is null then raise exception 'Approver must be an active owner, manager or admin' using errcode='42501';end if;
 if hash is null then return '{"error":"no-pin"}';end if;
 if approve.pin is null or extensions.crypt(approve.pin,hash)<>hash then
  insert into public.approval_failures(restaurant_id,requested_by) values(rid,auth.uid());return '{"error":"wrong-pin"}';end if;
 insert into public.approvals(restaurant_id,approver,requested_by,action,order_id,amount)
 values(rid,approve.approver,auth.uid(),approve.action,approve.order_id,approve.amount) returning id into granted;
 return jsonb_build_object('id',granted,'by',who);
end $$;
