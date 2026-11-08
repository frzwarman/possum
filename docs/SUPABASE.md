# Supabase setup

Meja needs one hosted Supabase project for authentication and the restaurant
database. The browser receives only the project URL and publishable key. Keep
the service-role key on the owner's computer.

## 1. Create and migrate the project

Create a project at [supabase.com](https://supabase.com), then copy its project
reference from the dashboard URL (`https://supabase.com/dashboard/project/<ref>`).
From this repository:

```sh
supabase login
supabase link --project-ref <your-project-ref>
supabase db push --dry-run
supabase db push
```

Only run `supabase db reset --linked` against a disposable test project. It
erases the linked database.

In Supabase Dashboard → Authentication → Providers / Configuration, keep email
and password enabled and disable public sign-ups. Staff accounts are created
by the owner with the trusted script below; there is no public registration
flow in Meja.

## 2. Create the owner and staff accounts

Copy `.env.admin.example` to `.env.admin` and fill it with the project URL and
the **service-role** key from Dashboard → Settings → API. This file is ignored
by Git and must never be used as a `VITE_` variable.

```sh
cp .env.admin.example .env.admin
pnpm staff init owner@example.com "Nama Pemilik" --restoran "Nama Restoran"
pnpm staff add kasir@example.com cashier "Nama Kasir" --restaurant <restaurant-uuid>
pnpm staff list
```

The script prints generated passwords once. Hand them directly to each person
and ask them to change them after the first login. Use `pnpm staff reset-password`
for owner-assisted recovery.

## 3. Roles, PINs and paired devices

| | Pemilik | Manajer | Admin stok | Kepala dapur | Kasir | Barista | Dapur |
|---|---|---|---|---|---|---|---|
| Sell, send to stations, payment, open and close shift | yes | yes | no | no | yes | no | no |
| Discount, void, refund, cash out, cash gap over the limit | yes | yes | no | no | manager PIN | no | no |
| Station: tickets, ready, waste, prep batches | yes | yes | yes | yes | yes | yes | yes |
| Menu and recipes (an active item without a recipe) | yes | yes | PIN | PIN | no | no | no |
| Ingredients, receiving, purchase orders, catering, transfers | yes | yes | yes | no | no | no | no |
| Stock counts (approving the result) | yes | yes | PIN | PIN | no | PIN | PIN |
| Today, reports, audit log, settings, devices, team | yes | yes | no | no | no | no | no |

`202611060009_takar.sql` adds the roles, device modes (`devices.mode`: `pos`, `station`, `office`), the
`pull` and `audit_log` RPCs, `count.record`, the `counts` table, option deltas, stations on order lines and
the relaxed shift rules. Apply it with `supabase db push`; `pnpm test:db` runs every migration in PGlite.

Each owner and manager signs in once and sets a 6-digit approval PIN in *Lainnya → PIN persetujuan*.
At the till the cashier stays signed in; the manager picks their name and types the PIN. The server
checks it (bcrypt via `pgcrypto`) and issues an approval that works once, for that person, action,
order or count, and amount, within an hour. Three wrong PINs in five minutes pause approvals.

Staff accounts use a 6-digit PIN as their password: `pnpm staff add kasir@ziggy.local cashier "Budi"
--restaurant <uuid> --pin 482915`. The email is stored in `memberships.login`, so after an owner or
manager has signed in on a device, that device offers "name + PIN" sign-in to everyone on the team.

Pair each device from *Lainnya → Printer & perangkat*: the one POS device (owner moves it), station
tablets and back-office laptops (owner or manager). `apply_operation` accepts selling operations from
the POS device only and station / back-office operations from any paired device.

### More than one outlet

Each outlet is its own restaurant with its own staff, primary till, and stock.
Create the second one with `pnpm staff init <owner-email> "Nama" --restoran
"Cabang Dago" --force` (use a separate owner account), then link them:

```sh
pnpm staff link-outlets <restaurant-uuid> <other-restaurant-uuid>
```

Linked outlets can send each other stock: it leaves the sender at once and is
booked in by the receiving outlet's manager, line by line onto its own items.

## 4. Configure the frontend

Create a local `.env.local` (or set these variables in the Cloudflare build
environment):

```dotenv
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<publishable-or-anon-key>
```

Never put `SUPABASE_SERVICE_ROLE_KEY` in `.env`, `.env.local`, a `VITE_` variable,
or the Cloudflare frontend environment. Values beginning with `VITE_` are
compiled into public JavaScript.

## 5. Verify before opening service

```sh
pnpm test
pnpm test:db
pnpm build
```

Open the deployed app, sign in as the owner, and confirm that the initial
bootstrap loads the restaurant settings and menu. Enroll the primary cashier
device from the settings screen while online, then sign in on the cashier
device and open a shift. The local PGlite checks in `pnpm test:db` do not prove
that a hosted project is configured correctly; do one real sign-in and one
small cash sale before service.
