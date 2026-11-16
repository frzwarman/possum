-- The store's own logo, printed at the top of the receipt and shown in the sidebar. It lives on its own column, not
-- in settings: settings are copied into every order snapshot, and a logo there would be stored once per order.
-- Members already read their restaurant row (member_read); only an owner or manager changes the logo.
alter table public.restaurants
 add column logo text check (logo is null or (length(logo) <= 70000 and logo ~ '^data:image/webp;base64,[A-Za-z0-9+/=]+$')),
 add column logo_at timestamptz;
create function public.set_logo(image text) returns void language plpgsql security definer set search_path='' as $$
declare rid uuid;begin
 select restaurant_id into rid from public.memberships where user_id=auth.uid() and active and role in ('owner','manager');
 if rid is null then raise exception 'Manager required' using errcode='42501';end if;
 update public.restaurants set logo=nullif(image,''),logo_at=now() where id=rid;
end $$;
revoke all on function public.set_logo(text) from public,anon;
grant execute on function public.set_logo(text) to authenticated;
