-- Pemilik boleh memindahkan kasir utama kapan saja, ke perangkat mana pun, tanpa ritual serah
-- terima: itu keputusan pemilik, bukan server. Manajer tetap hanya boleh mengklaim perangkat
-- pertama. handover_device tetap ada untuk serah terima yang direkonsiliasi oleh manajer.
-- Perpindahan tetap meninggalkan jejak: perangkat lama dicabut dan satu baris device_handovers.
-- Sif yang masih terbuka ikut pindah, kalau tidak sif itu tidak akan pernah bisa ditutup:
-- shift.close menuntut perangkat kasir utama, dan sif terbuka menghalangi sif berikutnya.
create or replace function public.enroll_device(device_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare rid uuid;role text;primary_id uuid;begin
 select restaurant_id,m.role into rid,role from public.memberships m where user_id=auth.uid() and active;
 if role not in ('owner','manager') or role is null then raise exception 'Manager required' using errcode='42501';end if;
 select primary_device_id into primary_id from public.restaurants where id=rid for update;
 if primary_id is not null and primary_id<>device_id and role<>'owner' then raise exception 'Primary already assigned: explicit reconciled handover required';end if;
 insert into public.devices(restaurant_id,id,enrolled_by) values(rid,device_id,auth.uid()) on conflict(restaurant_id,id) do update set revoked_at=null;
 if primary_id is not null and primary_id<>device_id then
  update public.devices set revoked_at=now() where restaurant_id=rid and id=primary_id;
  update public.shifts set device_id=enroll_device.device_id where restaurant_id=rid and closed_at is null;
  insert into public.device_handovers(restaurant_id,old_device,new_device,actor,note)
  values(rid,primary_id,device_id,auth.uid(),'Pemilik memindahkan kasir utama langsung dari aplikasi');
 end if;
 update public.restaurants set primary_device_id=device_id where id=rid;
end $$;
