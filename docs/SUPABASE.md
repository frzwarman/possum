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

## 3. Configure the frontend

Create a local `.env.local` (or set these variables in the Cloudflare build
environment):

```dotenv
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<publishable-or-anon-key>
```

Never put `SUPABASE_SERVICE_ROLE_KEY` in `.env`, `.env.local`, a `VITE_` variable,
or the Cloudflare frontend environment. Values beginning with `VITE_` are
compiled into public JavaScript.

## 4. Verify before opening service

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
