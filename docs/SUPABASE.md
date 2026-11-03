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

## 3. Roles and manager approval

| | Pemilik (super admin) | Manajer (admin) | Kasir |
|---|---|---|---|
| Sell, kitchen, payment, reprint (marked SALINAN) | yes | yes | yes |
| Discount, void, refund, cash out | yes | yes | manager PIN |
| Expected cash and variance at shift close | yes | yes | no (blind count) |
| Sales reports, history outside own shift, audit | yes | yes | no |
| Menu, stock, purchasing, production, catering, outlet transfers, settings | yes | yes | no |
| Staff accounts, primary till device | yes | no | no |

Back office is manager work (`202611020007_backoffice.sql`,
`202611020008_operations.sql`): suppliers; purchase orders received over
several deliveries and paid in parts (from the drawer, outside it, or owed);
production runs costed at each input's latest price; catering/B2B sales orders
with a down payment, delivery from stock, and settlement; and stock transfers
between outlets. The server enforces all of this in
`apply_operation`, `bootstrap`, and RLS (`202611020006_approvals.sql`): a cashier cannot read sales tables through the
API, and `bootstrap` returns no expected cash or variance to a cashier.

Each manager and owner signs in once and sets a 6-digit PIN in Lainnya →
PIN persetujuan. At the till the cashier stays signed in; the manager picks
their name and types the PIN. The server checks it (bcrypt via `pgcrypto`)
and issues an approval that works once, for that cashier, action, order, and
amount, within an hour. Five wrong PINs in 15 minutes pause approvals for the
restaurant. Approvals need a connection; the approver's name is stored in the
order and shown in Laporan → Koreksi & persetujuan.

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
