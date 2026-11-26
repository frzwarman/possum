-- QA 2026-11-25, stock cluster. op_purchase and op_sales_order: a drawer payment belongs to the actor's own open shift on whichever
-- paired device sends it (CT-03, STK-05, CAT-6; stock.record already worked that way), and a payload far above any screen is refused
-- (SQL-16). op_transfer: a receipt never books more than was sent (SQL-10). outlet_transfers: admin too (STK-12).
create or replace function public.op_purchase(rid uuid,actor uuid,device uuid,opid uuid,at timestamptz,stamp text,k text,p jsonb,s public.shifts) returns void language plpgsql set search_path='' as $$
declare po public.purchase_orders%rowtype;doc jsonb;l jsonb;oid uuid;amount bigint:=0;label text;begin
 if length(p::text)>200000 then raise exception 'Purchase payload too large';end if;
 if k='purchase.save' then
 doc:=p->'order';oid:=(doc->>'id')::uuid;
 if not (doc ?& array['id','number','supplier','note','lines','total','receipts','payments','status','revision','createdAt','updatedAt']) then raise exception 'Missing purchase order fields';end if;
 select * into po from public.purchase_orders where restaurant_id=rid and id=oid for update;
 if coalesce(po.revision,0)<>(p->>'expectedRevision')::int or po.status is not null and po.status<>'ordered' then raise exception 'Purchase order revision/state conflict';end if;
 if length(doc->>'supplier') not between 1 and 100 or length(doc->>'note')>300 or doc->>'status'<>'ordered' or doc->'receipts'<>'[]'::jsonb or doc->'payments'<>'[]'::jsonb
 or (doc->>'revision')::int<>coalesce(po.revision,0)+1 or (doc->>'total')::bigint<>public.purchase_total(rid,doc->'lines')
 or doc ? 'supplierId' and not exists(select 1 from public.suppliers where restaurant_id=rid and id::text=doc->>'supplierId') then raise exception 'Invalid purchase order';end if;
 if po.id is null and (doc->>'number'<>'PO-'||upper(left(opid::text,8)) or (doc->>'createdAt')::timestamptz<>at) or po.id is not null and (doc->>'number'<>po.snapshot->>'number' or doc->>'createdAt'<>po.snapshot->>'createdAt') then raise exception 'Purchase order identity changed';end if;
 insert into public.purchase_orders values(rid,oid,(doc->>'revision')::int,'ordered',doc,at,at) on conflict(restaurant_id,id) do update set revision=excluded.revision,snapshot=excluded.snapshot,updated_at=excluded.updated_at;
 return;
 end if;
 oid:=(p->>'id')::uuid;select * into po from public.purchase_orders where restaurant_id=rid and id=oid for update;
 if po.id is null or po.revision<>(p->>'expectedRevision')::int then raise exception 'Purchase order revision conflict';end if;
 doc:=po.snapshot;label:=(doc->>'number')||' · '||(doc->>'supplier');
 if k='purchase.receive' then
 if po.status not in ('ordered','partial') or coalesce(p->>'payment','') not in ('drawer','outside','unpaid') then raise exception 'Invalid purchase receipt';end if;
 amount:=public.purchase_total(rid,p->'lines');
 if exists(select 1 from jsonb_array_elements(p->'lines') x where not exists(select 1 from jsonb_array_elements(doc->'lines') y where y.value->>'stockId'=x.value->>'stockId')) then raise exception 'Delivery has items not on the purchase order';end if;
 for l in select value from jsonb_array_elements(p->'lines') loop
 insert into public.purchases values(rid,md5(opid::text||(l->>'stockId'))::uuid,l->>'stockId',(l->>'qty')::bigint,(l->>'cost')::bigint,label,actor,at);
 insert into public.stock_movements values(rid,opid::text||'-'||(l->>'stockId'),l->>'stockId',(l->>'qty')::bigint,'purchase',label,actor,at,now(),oid::text,opid,(l->>'cost')::bigint);
 end loop;
 doc:=jsonb_set(doc,'{receipts}',doc->'receipts'||jsonb_build_array(jsonb_build_object('at',stamp,'lines',p->'lines')));
 if p->>'payment'<>'unpaid' and amount>0 then doc:=jsonb_set(doc,'{payments}',doc->'payments'||jsonb_build_array(jsonb_build_object('at',stamp,'amount',amount,'from',p->>'payment')));end if;
 -- Done when the manager says no more is coming, or once every ordered item has arrived in full.
 doc:=doc||jsonb_build_object('status',case when coalesce((p->>'complete')::boolean,false) or not exists(select 1 from jsonb_array_elements(doc->'lines') o where (o.value->>'qty')::bigint>public.received_qty(doc,o.value->>'stockId')) then 'received' else 'partial' end);
 elsif k='purchase.pay' then
 amount:=(p->>'amount')::bigint;
 if po.status not in ('partial','received') or coalesce(p->>'payment','') not in ('drawer','outside') or amount is null or amount<1 or amount>public.received_value(doc)-public.paid_value(doc) then raise exception 'Purchase order not payable';end if;
 doc:=jsonb_set(doc,'{payments}',doc->'payments'||jsonb_build_array(jsonb_build_object('at',stamp,'amount',amount,'from',p->>'payment')));
 elsif k='purchase.cancel' then
 if po.status not in ('ordered','partial') or coalesce(length(trim(p->>'reason')),0)=0 then raise exception 'Invalid purchase cancellation';end if;
 -- Nothing arrived: cancelled. Part arrived: closed short, and the rest is no longer expected.
 doc:=doc||case when po.status='ordered' then jsonb_build_object('status','cancelled','cancelReason',p->>'reason') else jsonb_build_object('status','received','closeReason',p->>'reason') end;
 else raise exception 'Unknown operation';end if;
 if k in ('purchase.receive','purchase.pay') and p->>'payment'='drawer' and amount>0 then
 if s.id is null or s.actor<>actor or at>s.expires_at or (p->>'shiftId')::uuid is distinct from s.id then raise exception 'Drawer payment requires your active shift';end if;
 insert into public.cash_movements values(rid,opid,s.id,-amount,'Pembelian '||label,actor,at,null);
 end if;
 doc:=doc||jsonb_build_object('revision',po.revision+1,'updatedAt',stamp);
 update public.purchase_orders set revision=po.revision+1,status=doc->>'status',snapshot=doc,updated_at=at where restaurant_id=rid and id=oid;
end $$;
create or replace function public.op_sales_order(rid uuid,actor uuid,device uuid,opid uuid,at timestamptz,stamp text,k text,p jsonb,s public.shifts,settings jsonb) returns void language plpgsql set search_path='' as $$
declare so public.sales_orders%rowtype;doc jsonb;l jsonb;r jsonb;v jsonb;oid uuid;amount bigint:=0;label text;seen text[]:='{}';begin
 if length(p::text)>200000 then raise exception 'Sales order payload too large';end if;
 if k='salesorder.save' then
 doc:=p->'order';oid:=(doc->>'id')::uuid;
 if not (doc ?& array['id','number','customer','deliverAt','lines','discount','note','totals','payments','status','revision','createdAt','updatedAt']) then raise exception 'Missing sales order fields';end if;
 select * into so from public.sales_orders where restaurant_id=rid and id=oid for update;
 if coalesce(so.revision,0)<>(p->>'expectedRevision')::int or so.status is not null and so.status<>'confirmed' then raise exception 'Sales order revision/state conflict';end if;
 if length(doc->'customer'->>'name') not between 1 and 100 or length(coalesce(doc->'customer'->>'phone',''))>30 or length(coalesce(doc->'customer'->>'address',''))>300 or length(doc->>'note')>500
 or doc->>'status'<>'confirmed' or (doc->>'revision')::int<>coalesce(so.revision,0)+1 or doc->'payments'<>coalesce(so.snapshot->'payments','[]'::jsonb)
 or jsonb_typeof(doc->'lines')<>'array' or jsonb_array_length(doc->'lines') not between 1 and 200 or (doc->>'deliverAt')::timestamptz is null then raise exception 'Invalid sales order';end if;
 for l in select value from jsonb_array_elements(doc->'lines') loop
 select snapshot into v from public.catalog_versions where restaurant_id=rid and item_id=l->>'itemId' and version=(l->>'catalogVersion')::int;
 if v is null or l->>'id'=any(seen) or l->>'name'<>v->>'name' or (l->>'qty')::numeric<>trunc((l->>'qty')::numeric) or (l->>'qty')::int not between 1 and 999
 or (l->>'price')::numeric<>trunc((l->>'price')::numeric) or (l->>'price')::bigint not between 0 and 1000000000 then raise exception 'Invalid sales order line';end if;
 seen:=array_append(seen,l->>'id');end loop;
 if public.calculate_total((select jsonb_agg(x.value||'{"modifiers":[],"cancelled":false}'::jsonb) from jsonb_array_elements(doc->'lines') x),(doc->>'discount')::bigint,settings)<>doc->'totals'
 or (doc->'totals'->>'total')::bigint<public.paid_value(doc) then raise exception 'Sales order total mismatch';end if;
 if so.id is null and (doc->>'number'<>'SO-'||upper(left(opid::text,8)) or (doc->>'createdAt')::timestamptz<>at) or so.id is not null and (doc->>'number'<>so.snapshot->>'number' or doc->>'createdAt'<>so.snapshot->>'createdAt') then raise exception 'Sales order identity changed';end if;
 insert into public.sales_orders values(rid,oid,(doc->>'revision')::int,'confirmed',(doc->>'deliverAt')::timestamptz,doc,at,at)
 on conflict(restaurant_id,id) do update set revision=excluded.revision,deliver_at=excluded.deliver_at,snapshot=excluded.snapshot,updated_at=excluded.updated_at;
 return;
 end if;
 oid:=(p->>'id')::uuid;select * into so from public.sales_orders where restaurant_id=rid and id=oid for update;
 if so.id is null or so.revision<>(p->>'expectedRevision')::int then raise exception 'Sales order revision conflict';end if;
 doc:=so.snapshot;label:=(doc->>'number')||' · '||(doc->'customer'->>'name');
 if k='salesorder.pay' then
 amount:=(p->>'amount')::bigint;
 if so.status='cancelled' or coalesce(p->>'payment','') not in ('drawer','outside') or amount is null or amount<1 or amount>(doc->'totals'->>'total')::bigint-public.paid_value(doc) then raise exception 'Sales order not payable';end if;
 doc:=jsonb_set(doc,'{payments}',doc->'payments'||jsonb_build_array(jsonb_build_object('at',stamp,'amount',amount,'from',p->>'payment')));
 elsif k='salesorder.deliver' then
 if so.status<>'confirmed' then raise exception 'Sales order is not waiting for delivery';end if;
 for l in select value from jsonb_array_elements(doc->'lines') loop
 select snapshot into v from public.catalog_versions where restaurant_id=rid and item_id=l->>'itemId' and version=(l->>'catalogVersion')::int;
 for r in select value from jsonb_array_elements(coalesce(v->'recipe','[]'::jsonb)) loop
 insert into public.stock_movements values(rid,opid::text||'-'||(r->>'stockId'),r->>'stockId',-((r->>'qty')::bigint*(l->>'qty')::bigint),'preparation','Pesanan '||label,actor,at,now(),oid::text,opid,0)
 on conflict(restaurant_id,id) do update set qty=public.stock_movements.qty+excluded.qty;
 end loop;end loop;
 doc:=doc||jsonb_build_object('status','delivered','deliveredAt',stamp);
 elsif k='salesorder.cancel' then
 amount:=coalesce((p->>'refund')::bigint,0);
 if so.status<>'confirmed' or coalesce(length(trim(p->>'reason')),0)=0 or amount<0 or amount>public.paid_value(doc) or amount>0 and coalesce(p->>'payment','') not in ('drawer','outside') then raise exception 'Invalid sales order cancellation';end if;
 doc:=doc||jsonb_build_object('status','cancelled','cancelReason',p->>'reason');
 if amount>0 then doc:=jsonb_set(doc,'{payments}',doc->'payments'||jsonb_build_array(jsonb_build_object('at',stamp,'amount',-amount,'from',p->>'payment')));end if;
 else raise exception 'Unknown operation';end if;
 if k in ('salesorder.pay','salesorder.cancel') and p->>'payment'='drawer' and amount>0 then
 if s.id is null or s.actor<>actor or at>s.expires_at or (p->>'shiftId')::uuid is distinct from s.id then raise exception 'Drawer payment requires your active shift';end if;
 insert into public.cash_movements values(rid,opid,s.id,case when k='salesorder.pay' then amount else -amount end,case when k='salesorder.pay' then 'Pembayaran ' else 'Pengembalian DP ' end||label,actor,at,null);
 end if;
 doc:=doc||jsonb_build_object('revision',so.revision+1,'updatedAt',stamp);
 update public.sales_orders set revision=so.revision+1,status=doc->>'status',snapshot=doc,updated_at=at where restaurant_id=rid and id=oid;
end $$;
-- Sent stock leaves the sender at once and is in transit until the receiving outlet books it in,
create or replace function public.op_transfer(rid uuid,actor uuid,opid uuid,at timestamptz,stamp text,k text,p jsonb,here public.restaurants) returns void language plpgsql set search_path='' as $$
declare t public.transfers%rowtype;doc jsonb;l jsonb;r jsonb;lines jsonb:='[]';item public.inventory_items%rowtype;dest public.restaurants%rowtype;qty bigint;seen text[]:='{}';label text;begin
 if k='transfer.send' then
 doc:=p->'transfer';
 select * into dest from public.restaurants where id::text=doc->>'to';
 if here.group_id is null or dest.id is null or dest.group_id is distinct from here.group_id or dest.id=rid then raise exception 'Destination is not a linked outlet';end if;
 if jsonb_typeof(doc->'lines')<>'array' or jsonb_array_length(doc->'lines') not between 1 and 100 or length(doc->>'note')>300 or doc->>'number' is distinct from 'TR-'||upper(left(opid::text,8)) then raise exception 'Invalid transfer';end if;
 for l in select value from jsonb_array_elements(doc->'lines') loop
 select * into item from public.inventory_items where restaurant_id=rid and id=l->>'stockId';
 if item.id is null or l->>'stockId'=any(seen) or (l->>'qty')::numeric<>trunc((l->>'qty')::numeric) or (l->>'qty')::bigint not between 1 and 1000000000000 then raise exception 'Invalid transfer line';end if;
 seen:=array_append(seen,item.id);
 lines:=lines||jsonb_build_array(jsonb_build_object('stockId',item.id,'name',item.name,'unit',item.unit,'qty',(l->>'qty')::bigint,'value',least(1000000000,round(coalesce((l->>'qty')::bigint*public.unit_cost(rid,item.id),0)))::bigint));
 end loop;
 label:='Transfer '||(doc->>'number')||' ke '||(dest.settings->>'name');
 for l in select value from jsonb_array_elements(lines) loop
 insert into public.stock_movements values(rid,opid::text||'-'||(l->>'stockId'),l->>'stockId',-(l->>'qty')::bigint,'transfer',label,actor,at,now(),doc->>'id',opid,(l->>'value')::bigint);
 end loop;
 insert into public.transfers values((doc->>'id')::uuid,rid,dest.id,'sent',jsonb_build_object('id',doc->>'id','number',doc->>'number','from',rid,'fromName',here.settings->>'name','to',dest.id,'toName',dest.settings->>'name','lines',lines,'note',coalesce(doc->>'note',''),'status','sent','sentAt',stamp),at,at);
 return;
 end if;
 select * into t from public.transfers where id::text=p->>'id' for update;
 if t.id is null or t.status<>'sent' then raise exception 'Transfer is not in transit';end if;
 doc:=t.snapshot;
 if k='transfer.cancel' then
 if t.from_restaurant<>rid or coalesce(length(trim(p->>'reason')),0)=0 then raise exception 'Invalid transfer cancellation';end if;
 for l in select value from jsonb_array_elements(doc->'lines') loop
 insert into public.stock_movements values(rid,opid::text||'-'||(l->>'stockId'),l->>'stockId',(l->>'qty')::bigint,'transfer','Transfer '||(doc->>'number')||' dibatalkan',actor,at,now(),t.id::text,opid,(l->>'value')::bigint);
 end loop;
 doc:=doc||jsonb_build_object('status','cancelled','cancelReason',p->>'reason','cancelledAt',stamp);
 elsif k='transfer.receive' then
 if t.to_restaurant<>rid or jsonb_typeof(p->'lines')<>'array' then raise exception 'Invalid transfer receipt';end if;
 label:='Transfer '||(doc->>'number')||' dari '||(doc->>'fromName');
 for l in select value from jsonb_array_elements(doc->'lines') loop
 -- Every sent line is answered: which item it becomes here and how much arrived (0 = lost).
 select x.value into r from jsonb_array_elements(p->'lines') x where x.value->>'stockId'=l->>'stockId';
 qty:=(r->>'qty')::bigint;
 if r is null or qty is null or (r->>'qty')::numeric<>trunc((r->>'qty')::numeric) or qty<0 or qty>(l->>'qty')::bigint then raise exception 'Invalid transfer receipt';end if;
 if qty>0 then
 select * into item from public.inventory_items where restaurant_id=rid and id=r->>'target';
 if item.id is null or item.unit<>l->>'unit' or item.id=any(seen) then raise exception 'Receiving item must exist here with the same unit';end if;
 seen:=array_append(seen,item.id);
 insert into public.stock_movements values(rid,opid::text||'-'||item.id,item.id,qty,'transfer',label,actor,at,now(),t.id::text,opid,least(1000000000,round((l->>'value')::numeric*qty/(l->>'qty')::bigint))::bigint);
 end if;
 lines:=lines||jsonb_build_array(jsonb_build_object('stockId',l->>'stockId','target',r->>'target','qty',qty));
 end loop;
 doc:=doc||jsonb_build_object('status','received','received',lines,'receivedAt',stamp);
 else raise exception 'Unknown operation';end if;
 update public.transfers set status=doc->>'status',snapshot=doc,updated_at=at where id=t.id;
end $$;
-- Linked outlets and recent transfers both ways, read when the Transfer page opens: bootstrap
create or replace function public.outlet_transfers() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare rid uuid;g uuid;begin
 select m.restaurant_id into rid from public.memberships m where m.user_id=auth.uid() and m.active and m.role in ('owner','manager','admin');
 if rid is null then raise exception 'Manager required' using errcode='42501';end if;
 select group_id into g from public.restaurants where id=rid;
 return jsonb_build_object(
 'outlets',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'name',r.settings->>'name') order by r.settings->>'name'),'[]') from public.restaurants r where g is not null and r.group_id=g and r.id<>rid),
 'transfers',(select coalesce(jsonb_agg(x.snapshot order by x.created_at desc),'[]') from (select snapshot,created_at from public.transfers where from_restaurant=rid or to_restaurant=rid order by created_at desc limit 100) x));
end $$;
revoke all on function public.received_value(jsonb),public.received_qty(jsonb,text),public.paid_value(jsonb),public.unit_cost(uuid,text),public.op_supplier(uuid,jsonb,timestamptz),
 public.op_purchase(uuid,uuid,uuid,uuid,timestamptz,text,text,jsonb,public.shifts),public.op_production(uuid,uuid,uuid,timestamptz,jsonb),
 public.op_sales_order(uuid,uuid,uuid,uuid,timestamptz,text,text,jsonb,public.shifts,jsonb),public.op_transfer(uuid,uuid,uuid,timestamptz,text,text,jsonb,public.restaurants) from public,anon,authenticated;
