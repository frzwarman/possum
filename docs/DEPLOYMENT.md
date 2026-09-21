# Deployment — Cloudflare Workers (Free)

Meja builds to a folder of static files. There is no server to run: authorization lives in
Postgres, not in the frontend. Audience: whoever sets up the hosting.

> Status: the build, the headers file and the redirects file are in the repository and the
> production build has been measured locally. **An actual Cloudflare Pages deployment has not
> been performed from this environment** — the settings below are what to enter, not a record
> of a live site.

## Build settings

| Field | Value |
|---|---|
| Framework preset | None (or "Vite") |
| Build command | `pnpm build` |
| Build output directory | `dist` |
| Root directory | `/` |
| Node version | `22` — set the `NODE_VERSION` environment variable, or commit an `.nvmrc` |
| Package manager | pnpm, detected from `pnpm-lock.yaml` (`packageManager: pnpm@10.30.3`) |

`pnpm build` runs `tsc -b && vite build`, so a type error fails the deploy rather than shipping.

Vite 7 needs Node 20.19+ or 22.12+. The repository does not pin a version, so pin it in
Cloudflare; otherwise a future default change can break the build without a code change.

## Environment variables

Set these in Cloudflare Pages → *Settings* → *Environment variables* (Production, and Preview
if you use it). They are the **only** two values the frontend may contain:

| Variable | Example | Why it is safe in the bundle |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://abcdefgh.supabase.co` | the project address, public by design |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | the project's publishable / anon key | it authorizes nothing on its own — every table is under RLS, clients hold `SELECT` only, and all writes go through one RPC that checks the caller |

Anything with `VITE_` in its name is compiled into public JavaScript. **Never** put a
service-role key there. The service-role key belongs in `.env.admin`, which is gitignored and
read only by `scripts/provision-staff.mjs` on the owner's own machine.

`src/lib/supabase.ts` treats placeholder values (`YOUR_PROJECT`, `YOUR_…`) as unconfigured: the
login button stays disabled and only the local demo works. That is the expected state of a
deploy with no variables set.

## SPA routing — `wrangler.jsonc`, not `_redirects`

```jsonc
"assets": { "directory": "dist", "not_found_handling": "single-page-application" }
```

TanStack Router owns the URL, so a hard refresh of `/orders` — or `/admin`, which is chosen
from the URL before the router mounts — must still return `index.html` with status 200.

On **Workers** (`wrangler deploy`, which is what this project uses) that is the
`not_found_handling` setting above. A `public/_redirects` holding `/* /index.html 200` is
**rejected**: Workers Assets already strips `.html` and `/index`, so the rule matches its own
output and the API fails the deploy with *“Infinite loop detected in this rule”* (code 100324).
That file was removed; `public/_headers` still works and is still used.

Committing `wrangler.jsonc` also stops Wrangler improvising a config on every build — its
generated one has no `not_found_handling`, so every route but `/` would 404 on reload even
after a green deploy.

On **Pages** the equivalent is still a `_redirects` file with that one line. Pick one target;
the two are configured differently.

## Security headers — `public/_headers`

Read the file before changing it; each header below is actually present.

### `/*`

| Header | Value | Effect |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | the browser must trust the declared MIME type instead of guessing, so a mistyped asset cannot be executed as script |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | full URLs stay inside the origin; cross-site requests leak only the origin, and nothing over plain HTTP |
| `X-Frame-Options` | `DENY` | the POS cannot be framed — no clickjacking over the payment buttons |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | these devices are switched off for the page and everything it embeds; the app uses none of them |
| `Content-Security-Policy` | see below | what the page may load and where it may talk to |

The CSP, directive by directive:

| Directive | Value | Effect |
|---|---|---|
| `default-src` | `'self'` | the fallback: same origin only |
| `script-src` | `'self'` | only bundled scripts. No inline script, no CDN, no `eval` |
| `style-src` | `'self' 'unsafe-inline'` | inline styles are allowed because the receipt preview sets paper width through inline CSS custom properties |
| `img-src` | `'self' data: blob:` | bundled images, plus the `data:`/`blob:` URLs used for icons and file downloads |
| `connect-src` | `'self' https://*.supabase.co` | the app may call its own origin and Supabase — nothing else |
| `worker-src` | `'self'` | the service worker may only come from this origin |
| `frame-ancestors` | `'none'` | the modern equivalent of `X-Frame-Options: DENY`; both are sent |
| `base-uri` | `'self'` | an injected `<base>` tag cannot re-point relative URLs |
| `form-action` | `'self'` | a form cannot be made to post credentials elsewhere |

`connect-src` is a wildcard across `*.supabase.co`. Narrowing it to your exact project
hostname is a one-word edit and strictly better; it is left broad so the repository works
against any project.

### `/assets/*`

```
Cache-Control: public, max-age=31536000, immutable
```

Vite fingerprints these filenames, so a year of immutable caching is safe — a new build
produces new names.

### `/sw.js`

```
Cache-Control: no-cache
```

The service worker must be revalidated on every load, or a device can stay pinned to an old
app version forever.

## Domain and HTTPS

The free subdomain is `https://<project-name>.pages.dev`, with a Cloudflare-managed
certificate. A custom domain is optional and does not change any of the above.

HTTPS is not cosmetic here: **a service worker only registers on HTTPS or on `localhost`.**
Over plain HTTP there is no offline shell, no install prompt, and no PWA at all.

## PWA verification after deploying

Open the deployed URL in Chrome on Android (and in desktop Chrome for the DevTools view):

1. **Service worker registered** — DevTools → *Application* → *Service workers*: one worker,
   status "activated and is running", scope `/`.
2. **Manifest valid** — *Application* → *Manifest*: name "Meja — Kasir restoran", short name
   "Meja", `display: standalone`, `start_url: /`, theme `#205c45`, background `#f6f5f0`, and
   the SVG icon resolving.
3. **Installable** — Chrome offers "Install app" / "Add to Home screen". Install it and confirm
   it opens without browser chrome.
4. **Offline shell** — with the app open, switch the device to airplane mode and reload. The
   app must still start. (What you can *do* offline is a separate limit: see
   [OPERATIONS.md](OPERATIONS.md).)
5. **Precache size** — measured locally at 931.1 KiB raw / 287.5 KiB gzip across 13 files. If
   that grows sharply, check what was added to `globPatterns`.

## Updates are prompted, never automatic

`vite.config.ts` sets `registerType: 'prompt'`. When a new version is deployed, the app shows
"Pembaruan tersedia" with a *Perbarui sekarang* button and the note that drafts and the queue
are kept. Nothing reloads until someone taps it.

This is deliberate. `registerType: 'autoUpdate'` would let the page reload itself while a
cashier is halfway through taking payment. Do not change it for convenience.

Workbox is configured with `navigateFallback: '/index.html'` (so offline deep links still boot
the SPA) and `cleanupOutdatedCaches: true` (so old precaches are removed on activation).

## Deploy checklist

```sh
pnpm test        # 109 unit tests
pnpm test:db     # 19 database checks
pnpm test:e2e    # 3 end-to-end tests
pnpm measure     # initial JS must stay under 300 KiB gzip; exits 1 above it
pnpm build       # what Cloudflare will run
pnpm preview     # look at the real build once before pushing
```

After the deploy: load the site, confirm the login screen renders, confirm the service worker
registered, then sign in on the primary cashier device and check that the sync badge in the top
bar reads "Tersinkron".
