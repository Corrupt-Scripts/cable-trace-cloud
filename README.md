# Cable Trace on Cloudflare

The website, the accounts and the sync for the Cable Trace phone app, running on your own Cloudflare account.
This replaces the single-token Node server in `cable_trace_server` (that one still works for a LAN-only setup).

- **Worker** (`src/worker.js`): login, teams, invite codes, sync, file access. No dependencies.
- **D1**: accounts, teams, sessions and every job / drawing / run document.
- **R2**: plan photos, waypoint photos.
- **`web/`**: the site (drawing tracer, 3D routes, run viewer, team page), served by the same Worker.

## How accounts work

- Sign-up needs a code. The **site sign-up code** (a secret only you know) creates a **new team** and makes that person its owner.
- The owner opens **Team** (click your name, top right) and creates **invite codes**. Staff sign up with an invite code and join that team.
- Everyone on a team sees the same jobs, drawings and runs. Other teams see nothing of yours.
- Passwords are hashed (PBKDF2-SHA256) and never stored. Sessions last 30 days. 10 failed logins in 15 minutes locks that email/IP for 15 minutes.
- On the phone: **cloud icon → server address, email, password**. The phone keeps only a session token. Changing your password signs out all other devices.

## Deploy (about 10 minutes, free tier is enough to start)

You need Node 20+ and a Cloudflare account.

```bash
cd cable_trace_cloud
npm install
npx wrangler login
npx wrangler r2 bucket create cable-trace-files   # first enable R2 in the dashboard (Storage & databases -> R2)
npx wrangler secret put SIGNUP_CODE               # choose a long random phrase; this is your "new team" code
npx wrangler deploy
```

(The D1 database `cable-trace` is already created in the Cloudflare account this was prepared for, its ID is in `wrangler.toml` and the tables exist, so skip `d1 create` and `migrations apply`. On a fresh account: `npx wrangler d1 create cable-trace`, paste the ID into `wrangler.toml`, then `npx wrangler d1 migrations apply cable-trace --remote`.)

Wrangler prints your address, e.g. `https://cable-trace.<your-subdomain>.workers.dev`. Open it, choose **I have an invite code**, and sign up with the site sign-up code and a team name. You are the owner of that team. Use that same address in the phone app.

Custom domain: Cloudflare dashboard → Workers → cable-trace → Settings → Domains & Routes.

## Run it locally

```bash
npx wrangler d1 migrations apply cable-trace --local
npx wrangler dev --local --var SIGNUP_CODE:founder-code-123
node --test test/api.test.mjs                 # API tests (needs the dev server running)
```

## Limits worth knowing

- One document (a drawing with its walls and routes, or a run with its scan samples) must stay under about 1.8 MB (D1 row limit). Photos are separate files (25 MB max each).
- The login throttle is per email and per IP. Offices behind one IP share the IP allowance.
- Invite codes and the site sign-up code are the only gate to sign-up. Rotate the site code any time with `wrangler secret put SIGNUP_CODE`.
- No email is sent by the system, so there is no "forgot password" yet: the owner can remove an account from Team and the person signs up again with a new invite.
- Data is in your Cloudflare account. Back it up with `npx wrangler d1 export cable-trace --remote --output backup.sql`.
