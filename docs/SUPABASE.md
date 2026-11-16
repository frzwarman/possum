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

## 6. Telegram for owners and managers (optional, free)

One bot sends three things to linked owners and managers: approval requests from
the till (Setujui / Tolak), the morning report at 07:00 WIB for the business day
that just ended, and an alert when a shift closes with a cash gap over the limit.
An approval from Telegram is the same one-use approval as a PIN at the till.
Telegram's Bot API is free; everything else runs inside the Supabase project.

1. In Telegram, open **@BotFather**, send `/newbot`, pick a name and a username
   ending in `bot` (for example `takar_ziggy_bot`), and copy the token.
2. Make two random secrets, one for Telegram and one for the scheduled jobs:

   ```sh
   openssl rand -hex 24
   openssl rand -hex 24
   ```

3. Store the secrets on the project and deploy the function (`supabase/config.toml`
   already turns off the gateway JWT check for it; the function checks its own
   secrets):

   ```sh
   supabase secrets set TELEGRAM_BOT_TOKEN=<token> TELEGRAM_WEBHOOK_SECRET=<secret-1> CRON_SECRET=<secret-2>
   supabase functions deploy telegram --no-verify-jwt
   ```

4. Point the bot at the function:

   ```sh
   curl -s "https://api.telegram.org/bot<token>/setWebhook" \
     -d url=https://<project-ref>.supabase.co/functions/v1/telegram \
     -d secret_token=<secret-1> \
     -d 'allowed_updates=["message","callback_query"]'
   ```

5. Turn on the **pg_cron** and **pg_net** extensions (Dashboard → Database →
   Extensions), then run once in the SQL editor. pg_cron runs in UTC, so
   `0 0 * * *` is 07:00 WIB; alerts are checked every five minutes.

   ```sql
   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/telegram', 'telegram_url');
   select vault.create_secret('<secret-2>', 'telegram_cron_secret');
   select cron.schedule('telegram-report', '0 0 * * *', $$
     select net.http_post(
       url := (select decrypted_secret from vault.decrypted_secrets where name = 'telegram_url'),
       headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret',
         (select decrypted_secret from vault.decrypted_secrets where name = 'telegram_cron_secret')),
       body := '{"job":"report"}'::jsonb) $$);
   select cron.schedule('telegram-alerts', '*/5 * * * *', $$
     select net.http_post(
       url := (select decrypted_secret from vault.decrypted_secrets where name = 'telegram_url'),
       headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret',
         (select decrypted_secret from vault.decrypted_secrets where name = 'telegram_cron_secret')),
       body := '{"job":"alerts"}'::jsonb) $$);
   ```

6. Add the bot's username (without `@`) to the frontend environment and rebuild;
   without it the Telegram buttons stay hidden:

   ```dotenv
   VITE_TELEGRAM_BOT=takar_ziggy_bot
   ```

7. Each owner and manager signs in, opens the account area at the bottom of
   *Lainnya*, taps **Telegram → Hubungkan**, and presses **Start** in the bot. The
   link code is valid for 15 minutes and works once. From then on the till's
   approval dialog shows **Minta lewat Telegram**; a request stays open for five
   minutes, the first manager to answer decides it, and the PIN at the till keeps
   working as before.
