// QA 2026-11-25, cluster catalog: catalog.publish and catalog.remove (menu/F1 F2 F7 F8, sql/SQL-05, sync/SYNC-13).
// Run with pnpm test:db. Each check builds its own restaurant with world().
export default async ({ db, test, read, assert, world }) => {
  // A menu item as the editor and the import build it (src/features/settings/Settings.tsx).
  const item = (id, price, version = 1, more = {}) => ({ id, name: id, category: "Minuman", type: "beverage", station: "bar", tags: [], aliases: [], groups: [], lowAt: 5, price, active: true, soldOut: false, favorite: false, modifiers: [], recipe: [{ stockId: "rice", qty: 18000 }], version, ...more });
  const stock = [{ id: "rice", name: "Beras", unit: "g", threshold: 1000000 }, { id: "egg", name: "Telur", unit: "pcs", threshold: 1000 }];
  const live = async (w) => Object.fromEntries((await read("select c.id,c.version,v.snapshot->>'price' as price from public.catalog_items c join public.catalog_versions v on v.restaurant_id=c.restaurant_id and v.item_id=c.id and v.version=c.version where c.restaurant_id=$1", [w.rid])).rows.map((r) => [r.id, `v${r.version} Rp${r.price}`]));
  const publish = (w, menu, stockRows = [], more = {}) => w.send(w.op("catalog.publish", { menu, stock: stockRows, ...more }));
  // A refusal the app can show and discard: P0001 or 42501 (serverTransport treats other codes as "try again", forever).
  const refused = async (promise, message) => assert.rejects(promise, (e) => { assert.match(e.message, message); assert.ok(["P0001", "42501"].includes(e.code), `${e.code} ${e.message}`); return true; });

  await test("QA catalog F1: a save that also carries an older copy of another menu is accepted; the older copy is skipped", async () => {
    const w = await world();
    await publish(w, [item("americano", 30000), item("latte", 30000)], stock);
    // Laptop A raises the americano. Laptop B has not pulled that yet and saves the latte: the app deployed before
    // this fix sends its whole catalog, with its old americano v1.
    await publish(w, [item("americano", 32000, 2), item("latte", 30000)], stock);
    await w.as(w.people.manager);
    await publish(w, [item("americano", 30000, 1), item("latte", 99000, 2)], stock);
    assert.deepEqual(await live(w), { nasi: "v1 Rp25000", americano: "v2 Rp32000", latte: "v2 Rp99000" });
    // The same whole catalog again, unchanged, is no news at all: no new version, nothing live moves.
    const versions = async () => (await read("select count(*)::int n from public.catalog_versions where restaurant_id=$1", [w.rid])).rows[0].n;
    const before = await versions();
    await publish(w, [item("americano", 32000, 2), item("latte", 99000, 2)], stock);
    assert.equal(await versions(), before);
    // The new app sends only the edited row, and no bahan at all: nothing else is touched.
    const touched = async () => (await read("select max(updated_at) as at from public.inventory_items where restaurant_id=$1", [w.rid])).rows[0].at;
    const at = await touched();
    await publish(w, [item("latte", 31000, 3)]);
    assert.deepEqual(await live(w), { nasi: "v1 Rp25000", americano: "v2 Rp32000", latte: "v3 Rp31000" });
    assert.deepEqual(await touched(), at);
  });

  await test("QA catalog F2: two different saves of the same version stay a refusal, and so does a version older than the live one that was never sent", async () => {
    const w = await world();
    await publish(w, [item("americano", 30000), item("latte", 30000)], stock);
    await publish(w, [item("americano", 33000, 2)]);
    await w.as(w.people.manager);
    await refused(publish(w, [item("americano", 35000, 2)]), /Catalog version immutable/);
    await publish(w, [item("americano", 34000, 4)]);
    await refused(publish(w, [item("americano", 36000, 3)]), /Stale catalog version/);
    assert.equal((await live(w)).americano, "v4 Rp34000");
  });

  await test("QA catalog F8: a removed menu stays removed whatever a device that has not pulled yet sends for it", async () => {
    const w = await world();
    await publish(w, [item("americano", 30000), item("trial", 20000)], stock);
    await w.send(w.op("catalog.remove", { ids: ["trial"] }));
    assert.deepEqual(await live(w), { nasi: "v1 Rp25000", americano: "v1 Rp30000" });
    const since = new Date(Date.now() - 1000).toISOString();
    await w.as(w.people.manager);
    // Sent again as it was (the older app's whole catalog), and edited on the stale device: neither brings it back.
    await publish(w, [item("americano", 31000, 2), item("trial", 20000)], stock);
    await publish(w, [item("trial", 21000, 2)]);
    assert.deepEqual(await live(w), { nasi: "v1 Rp25000", americano: "v2 Rp31000" });
    const pulled = (await db.query("select public.pull($1,$2) as p", [since, w.till])).rows[0].p;
    assert.deepEqual(pulled.catalog.menu.map((m) => m.id).sort(), ["americano", "nasi"]);
    // Its versions are kept: an order a till took before it pulled the removal still syncs (checked in test-db.mjs).
    assert.equal((await read("select count(*)::int n from public.catalog_versions where restaurant_id=$1 and item_id='trial'", [w.rid])).rows[0].n, 1);
  });

  await test("QA catalog SQL-05: a menu entry with a missing or null field is refused, for every role", async () => {
    const w = await world();
    const good = item("kopi", 15000);
    const without = (key) => { const { [key]: _, ...rest } = good; return rest; };
    for (const role of ["owner", "chef"]) {
      await w.as(w.people[role]);
      for (const key of ["id", "name", "category", "price", "active", "recipe", "modifiers", "version"]) {
        await refused(publish(w, [without(key)]), /Invalid menu/);
        await refused(publish(w, [{ ...good, [key]: null }]), /Invalid menu/);
      }
      await refused(publish(w, [{ id: "ghost", active: false, version: 1 }]), /Invalid menu/);
      for (const bad of [{ price: "15000" }, { price: 1.5 }, { price: -1 }, { price: 1000000001 }, { version: 0 }, { version: 1.5 }, { version: 3000000000 }, { active: "true" }, { recipe: {} }, { modifiers: {} }, { id: "" }, { name: "" }, { category: "" }, { photo: null }])
        await refused(publish(w, [{ ...good, ...bad }]), /Invalid menu/);
      for (const bad of [{ id: "x", name: "Extra", price: 1000 }, { id: "x", name: "Extra", price: null, recipe: [] }, { id: "x", price: 1000, recipe: [] }, { name: "Extra", price: 1000, recipe: [] }, { id: "x", name: "Extra", price: "1000", recipe: [] }])
        await refused(publish(w, [{ ...good, modifiers: [bad] }]), /Invalid modifier/);
    }
    assert.deepEqual(await live(w), { nasi: "v1 Rp25000" });
    // MENU-7 still stands: a chef needs a manager's PIN for an active item with an empty recipe, whatever the spelling.
    await w.as(w.people.chef);
    await assert.rejects(publish(w, [{ ...good, recipe: [] }]), /Manager approval required/);
    await publish(w, [{ ...good, recipe: [], active: false }]);
    await w.as(w.people.owner);
    await publish(w, [{ ...good, version: 2 }]);
    assert.equal((await live(w)).kopi, "v2 Rp15000");
  });

  await test("QA catalog SQL-05: a bahan with a missing or null field is refused, and so is a catalog that is not two lists", async () => {
    const w = await world();
    const sugar = { id: "sugar", name: "Gula", unit: "g", threshold: 0 };
    for (const key of ["id", "name", "unit", "threshold"]) {
      const { [key]: _, ...rest } = sugar;
      await refused(publish(w, [], [rest]), /Invalid stock item/);
      await refused(publish(w, [], [{ ...sugar, [key]: null }]), /Invalid stock item/);
    }
    for (const bad of [{ threshold: "5" }, { threshold: 1.5 }, { threshold: -1 }, { unit: "kg" }, { id: "" }, { production: { output: 1000 } }, { production: { inputs: {}, output: 1000 } }, { production: { inputs: [{ stockId: "rice", qty: 1000 }] } }])
      await refused(publish(w, [], [{ ...sugar, ...bad }]), /Invalid stock item|Invalid production recipe/);
    for (const payload of [{}, { menu: [] }, { stock: [] }, { menu: null, stock: [] }, { menu: {}, stock: [] }, { menu: [], stock: "x" }])
      await refused(w.send(w.op("catalog.publish", payload)), /Invalid catalog/);
    assert.equal((await read("select count(*)::int n from public.inventory_items where restaurant_id=$1", [w.rid])).rows[0].n, 2);
    // What the app sends is still taken: with and without the optional fields, and a made-in-house bahan.
    await publish(w, [], [sugar, { id: "syrup", name: "Sirup", unit: "ml", threshold: 0, aliases: ["gula cair"], area: "Bar", packs: [{ name: "botol", qty: 750000 }], shelfLife: 48, station: "bar", production: { inputs: [{ stockId: "sugar", qty: 500000 }], output: 1000000 } }, { id: "salt", name: "Garam", unit: "g", threshold: 0, production: null }]);
    assert.equal((await read("select count(*)::int n from public.inventory_items where restaurant_id=$1", [w.rid])).rows[0].n, 5);
  });

  await test("QA catalog F7: a menu photo and the logo may be a small JPEG as well as a WebP, and nothing else", async () => {
    const w = await world();
    const jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRg==", webp = "data:image/webp;base64,UklGRg==";
    await publish(w, [item("foto-jpeg", 10000, 1, { photo: jpeg }), item("foto-webp", 10000, 1, { photo: webp })]);
    for (const photo of ["data:image/png;base64,iVBORw0KGgo=", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/jpeg;base64,<svg>", `data:image/jpeg;base64,${"A".repeat(70000)}`, ""])
      await refused(publish(w, [item("foto-lain", 10000, 1, { photo })]), /Invalid menu photo/);
    assert.deepEqual(Object.keys(await live(w)).sort(), ["foto-jpeg", "foto-webp", "nasi"]);
    await db.query("select public.set_logo($1)", [jpeg]);
    assert.equal((await read("select logo from public.restaurants where id=$1", [w.rid])).rows[0].logo, jpeg);
    await db.query("select public.set_logo($1)", [webp]);
    await assert.rejects(db.query("select public.set_logo($1)", ["data:image/png;base64,iVBORw0KGgo="]), /check constraint/);
    await assert.rejects(db.query("select public.set_logo($1)", [`data:image/jpeg;base64,${"A".repeat(70000)}`]), /check constraint/);
  });
};
