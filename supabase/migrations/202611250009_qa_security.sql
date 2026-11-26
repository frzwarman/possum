-- QA 2026-11-25, cluster security. Each function is re-created from its latest definition and changed only where a
-- finding needs it; CREATE OR REPLACE keeps every grant and revoke as it was.
--
-- enroll_device (latest in 202611060009), AUTH-04 and SQL-13: only the owner un-pairs the till. A manager could re-pair
-- the till as a station or a laptop, which left the restaurant with no till, and then claim any other device as "the
-- first" one: the till moved without the owner and without a device_handovers row. A manager still pairs every other
-- device, and still claims the till while none is assigned (202609210005).
create or replace function public.enroll_device(device_id uuid,mode text default 'pos') returns void language plpgsql security definer set search_path='' as $$
declare rid uuid;role text;primary_id uuid;begin
 select restaurant_id,m.role into rid,role from public.memberships m where user_id=auth.uid() and active;
 if role not in ('owner','manager') or role is null then raise exception 'Manager required' using errcode='42501';end if;
 if mode not in ('pos','station','office') then raise exception 'Unknown device mode';end if;
 select primary_device_id into primary_id from public.restaurants where id=rid for update;
 insert into public.devices(restaurant_id,id,enrolled_by,mode) values(rid,device_id,auth.uid(),mode) on conflict(restaurant_id,id) do update set revoked_at=null,mode=excluded.mode;
 if mode<>'pos' then
  if primary_id=device_id then
   if role<>'owner' then raise exception 'Owner required to re-pair the till' using errcode='42501';end if;
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
-- SQL-18: device_handovers (202609210003) and the stock_balances view (202609210001) were created without the revoke
-- every other relation has, so on the hosted project they kept Supabase's default privileges: everything, for anon and
-- authenticated. Row level security stops their writes, but TRUNCATE ignores it. Members keep reading both.
revoke all on public.device_handovers,public.stock_balances from anon,authenticated;
grant select on public.device_handovers,public.stock_balances to authenticated;
-- member_role is called by the row level security policies, as the signed-in member, and by nobody else. 202609210001
-- revoked it from public, but the default privileges had granted it to anon by name (Supabase's security advisor flags
-- a SECURITY DEFINER function that anon may execute).
revoke execute on function public.member_role(uuid) from public,anon;
