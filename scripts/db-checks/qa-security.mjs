// QA 2026-11-25, cluster security: who may move the till (AUTH-04, SQL-13) and what the API roles hold on a hosted
// project (SQL-18, member_role). Run by scripts/test-db.mjs.
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFile, readdir } from "node:fs/promises";
export default async ({ db, test, read, send, assert, randomUUID, settings, world }) => {
  await test("QA security AUTH-04, SQL-13: a manager cannot take the till away, in one call or in two; the owner's move leaves a handover row", async () => {
    const w = await world("Warung Kasir Aman"), mine = randomUUID(), next = randomUUID();
    const state = async () => (await read("select r.primary_device_id as till,(select count(*)::int from public.device_handovers h where h.restaurant_id=r.id) as handovers,(select d.mode from public.devices d where d.restaurant_id=r.id and d.id=$2 and d.revoked_at is null) as mode from public.restaurants r where r.id=$1", [w.rid, w.till])).rows[0];
    const pair = (device, mode) => db.query("select public.enroll_device($1,$2)", [device, mode]);
    await w.as(w.people.manager);
    await assert.rejects(pair(mine, "pos"), /explicit reconciled handover required/);
    // The two-call route: un-pair the till (as a station or a laptop), then claim another device as "the first".
    for (const mode of ["station", "office"]) await assert.rejects(pair(w.till, mode), (e) => e.code === "42501" && /Owner required to re-pair the till/.test(e.message));
    await assert.rejects(pair(mine, "pos"), /explicit reconciled handover required/);
    assert.deepEqual(await state(), { till: w.till, handovers: 0, mode: "pos" });
    // What a manager does pair stays: another tablet as a station, and the till once more as the till (nothing changes).
    await pair(mine, "station");
    await pair(w.till, "pos");
    assert.deepEqual(await state(), { till: w.till, handovers: 0, mode: "pos" });
    // The real till still sells, and the owner moves it in one call: the open shift follows and one handover row is written.
    await w.as(w.people.cashier);
    const shift = randomUUID();
    await send(w.op("shift.open", { id: shift, opening: 0 }));
    await w.as(w.people.owner);
    await pair(next, "pos");
    assert.deepEqual(await state(), { till: next, handovers: 1, mode: null });
    assert.deepEqual((await read("select device_id from public.shifts where restaurant_id=$1 and id=$2", [w.rid, shift])).rows, [{ device_id: next }]);
    // The owner may still re-pair the till as something else once no shift is open; a manager may claim a till only while none is assigned.
    await assert.rejects(pair(next, "office"), /Close the shift before re-pairing the till/);
    await w.as(w.people.cashier);
    await send(w.opOn(next, "shift.close", { id: shift, counted: 0 }));
    await w.as(w.people.owner);
    await pair(next, "office");
    assert.equal((await state()).till, null);
    await w.as(w.people.manager);
    await pair(mine, "pos");
    assert.equal((await state()).till, mine);
    await w.as(w.people.owner);
  });
  // The checks below need what a hosted Supabase project has before the first migration: default privileges that grant
  // everything in public to anon and authenticated until a migration revokes it. The shared database above has none.
  const hosted = new PGlite({ extensions: { pgcrypto } });
  await hosted.exec(`create schema auth;create schema extensions;create role anon;create role authenticated;create role service_role;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
   grant usage on schema public,auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;
   alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
   alter default privileges in schema public grant all on functions to anon,authenticated,service_role;
   alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;`);
  for (const file of (await readdir("supabase/migrations")).sort()) await hosted.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
  await test("QA security SQL-18: with Supabase's default privileges, no table or view in public is left writable (anon holds nothing, a member only SELECT)", async () => {
    const { rows } = await hosted.query(`select c.relname as relation,r.name as role,string_agg(p.name,',' order by p.name) as holds
     from pg_class c join pg_namespace n on n.oid=c.relnamespace,unnest(array['anon','authenticated']) r(name),unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(name)
     where n.nspname='public' and c.relkind in ('r','p','v','m') and has_table_privilege(r.name,c.oid,p.name) and not (r.name='authenticated' and p.name='SELECT') group by 1,2 order by 1,2`);
    assert.deepEqual(rows, []);
    // TRUNCATE ignores row level security: it is the privilege itself that has to be gone.
    await hosted.exec("set role anon");
    try { await assert.rejects(hosted.query("truncate public.device_handovers"), /permission denied/); } finally { await hosted.exec("reset role"); }
  });
  await test("QA security: member_role is not executable by anon, no SECURITY DEFINER function is, and a signed-in member still reads through the policies that call it", async () => {
    const { rows } = await hosted.query(`select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and has_function_privilege('anon',p.oid,'EXECUTE') order by 1`);
    assert.deepEqual(rows, []);
    assert.deepEqual((await hosted.query("select has_function_privilege('anon','public.member_role(uuid)','EXECUTE') as anon,has_function_privilege('authenticated','public.member_role(uuid)','EXECUTE') as member")).rows, [{ anon: false, member: true }]);
    const rid = randomUUID(), owner = randomUUID(), cashier = randomUUID(), till = randomUUID();
    await hosted.query("insert into auth.users values($1),($2)", [owner, cashier]);
    await hosted.query("insert into public.restaurants(id,settings) values($1,$2)", [rid, JSON.stringify(settings)]);
    await hosted.query("insert into public.memberships values($1,$2,'owner','Pemilik',true),($1,$3,'cashier','Kasir',true)", [rid, owner, cashier]);
    const as = async (user, role = "authenticated") => { await hosted.exec("reset role"); await hosted.query("select set_config('request.jwt.claim.sub',$1,false)", [user ?? ""]); await hosted.exec(`set role ${role}`); };
    try {
      await as(owner);
      await hosted.query("select public.enroll_device($1,'pos')", [till]);
      assert.equal((await hosted.query("select public.member_role($1) as role", [rid])).rows[0].role, "owner");
      // memberships, devices and device_handovers are all read through policies that call member_role.
      assert.equal((await hosted.query("select count(*)::int as n from public.memberships")).rows[0].n, 2);
      assert.deepEqual((await hosted.query("select id from public.devices")).rows, [{ id: till }]);
      assert.deepEqual((await hosted.query("select count(*)::int as n from public.device_handovers")).rows, [{ n: 0 }]);
      assert.deepEqual((await hosted.query("select stock_id from public.stock_balances")).rows, []);
      await as(cashier);
      assert.equal((await hosted.query("select count(*)::int as n from public.memberships")).rows[0].n > 0, true);
      assert.deepEqual((await hosted.query("select id from public.devices")).rows, []);
      await as(null, "anon");
      await assert.rejects(hosted.query("select public.member_role($1)", [rid]), /permission denied for function member_role/);
      await assert.rejects(hosted.query("select * from public.memberships"), /permission denied/);
    } finally { await hosted.exec("reset role"); }
  });
  await hosted.close();
};
