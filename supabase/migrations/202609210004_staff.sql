-- Owner-only staff administration from the app. Creating an account still needs the service
-- role key (scripts/provision-staff.mjs); this changes only the role and access of members who
-- already exist. An owner cannot change their own row, so the restaurant keeps a way back in.
create function public.manage_staff(target uuid,new_role text,new_active boolean) returns void language plpgsql security definer set search_path='' as $$
declare rid uuid;begin
 select restaurant_id into rid from public.memberships where user_id=auth.uid() and active and role='owner';
 if rid is null then raise exception 'Owner required' using errcode='42501';end if;
 if target=auth.uid() then raise exception 'Owner cannot change their own access' using errcode='42501';end if;
 if new_role not in ('owner','manager','cashier') or new_active is null then raise exception 'Invalid staff role or access';end if;
 update public.memberships set role=new_role,active=new_active where restaurant_id=rid and user_id=target;
 if not found then raise exception 'Staff not found in this restaurant';end if;
end $$;
revoke all on function public.manage_staff(uuid,text,boolean) from public,anon;
grant execute on function public.manage_staff(uuid,text,boolean) to authenticated;
