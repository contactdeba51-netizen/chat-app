# Chat App

A WhatsApp-inspired real-time chat application built with React, Express, Socket.IO, and PostgreSQL.

## Requirements

- Node.js 20+
- PostgreSQL 13+ (portable binaries work; no admin install required)
- A free Brevo account for verification and recovery emails (or Resend as a fallback)

## 1. Start PostgreSQL

This project includes scripts for a portable PostgreSQL 17 install under `%USERPROFILE%\pgsql`:

```powershell
cd "C:\Users\Debanjan\Chat App"
.\scripts\start-db.ps1
```

To stop it later:

```powershell
.\scripts\stop-db.ps1
```

If you use your own PostgreSQL server instead, skip this step and point `DATABASE_URL` at it.

## 2. Configure the backend

Create `backend/.env` from `backend/.env.example`:

```powershell
Copy-Item "C:\Users\Debanjan\Chat App\backend\.env.example" "C:\Users\Debanjan\Chat App\backend\.env"
```

Fill in:

```env
PORT=5000
CLIENT_URL=http://localhost:5173
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/chat_app
DATABASE_SSL=false
JWT_SECRET=USE_A_LONG_RANDOM_SECRET

BREVO_API_KEY=xkeysib-your-brevo-key
EMAIL_FROM=your-verified-sender@gmail.com
EMAIL_FROM_NAME=Chat App
```

Brevo's free plan allows about 300 emails per day. Verify the sender address once in the Brevo dashboard — no domain is required for a single sender. If a sender is not configured, sign-ups and password recovery return a clear "email delivery is not configured" error; existing accounts can still log in.

Resend remains supported as an optional fallback when `RESEND_API_KEY` is set and `BREVO_API_KEY` is empty.

## 3. Create the database and run migrations

```powershell
cd "C:\Users\Debanjan\Chat App\backend"
npm run db:setup
```

This connects to the `postgres` maintenance database, creates `chat_app` if needed, and applies every pending migration from `backend/database/migrations` (it works without `psql`/`createdb` on your PATH).

Migration commands:

| Command | Purpose |
| --- | --- |
| `npm run db:status` | Show applied/pending migrations and flag edited files |
| `npm run db:migrate` | Apply every pending migration |
| `npm run db:baseline` | Record `0001_baseline` on a database that already has the schema (one-time, never re-runs SQL) |

Migrations are forward-only and checksummed. Never edit a migration that has already run; add a new numbered file instead. `0001_baseline.sql` is a copy of the original `database/schema.sql`, which is kept for reference only.

## 4. Run the app

Terminal 1:

```powershell
cd "C:\Users\Debanjan\Chat App\backend"
npm run dev
```

Terminal 2:

```powershell
cd "C:\Users\Debanjan\Chat App\frontend"
npm run dev
```

Open the Vite URL (normally `http://localhost:5173`).

Sessions are per browser tab. Opening a second tab and signing in as another account keeps both tabs independent; closing a tab signs that tab out (the token is stored in `sessionStorage`, not a shared cookie).

Sign-up is phone-first: pick a country (all countries and dial codes are built in), enter the phone number, display name, email, and a password, then type the 6-digit code Brevo sends to that email. Phone numbers are the login identity; email is required for verification and password recovery. Existing email-only accounts can keep signing in from the **Email** tab and can connect a phone in Settings.

## 5. Add contacts and groups

Open **New chat** (✎) → choose a country and enter a phone number.

- If the number is registered, the person is saved to your contacts and a direct chat opens.
- If it is not registered, you get an invite link plus a **Share on WhatsApp** button (`wa.me`). When that person signs up with the invited number, the invite becomes a direct message in a new chat.

People are discoverable by exact phone number only. "Let people find me by phone number" can be turned off in Settings.

To start a group, open the **⋮** menu → **New Group**, enter a name, and pick members from your chats and saved contacts. A group needs at least one other member, so a two-person group (you + one) is allowed. Groups use the same thread features as direct chats — text, photos, replies, reactions, and delivered/read receipts. Audio and video calls remain one-to-one only.

Last seen shows the exact local time (for example, "last seen today at 14:05") whenever the other person shares it. Turning off last-seen sharing in Settings hides it entirely.

## 6. Verify the API

With the backend running:

```powershell
cd "C:\Users\Debanjan\Chat App\backend"
npm run smoke
```

The smoke test seeds verified accounts directly in PostgreSQL (sign-up itself needs a real email provider), then checks phone/email login, contacts, the "existing contacts only" privacy rule, pending invites, invite delivery, messaging, unread counts, receipts, editing, reactions, stars, replies, search, archiving, blocking, deletion, upload validation, signed and expiring media URLs, locked-chat PIN enforcement, status visibility, the newest-100 message window with its older-history cursor, group creation and membership, group messaging/receipts/replies/reactions, non-member rejection, and logout. Test rows are removed at the end.

### Security regression check

`npm run security:check` exercises authorization the way an attacker would: it seeds throwaway accounts, mints their own tokens, and connects to Socket.IO with each token separately from REST, so a REST-only fix cannot hide a broken handshake.

```powershell
cd "C:\Users\Debanjan\Chat App\backend"

# Local API
npm run security:check

# Deployed API (DATABASE_URL must point at the same database)
$env:SECURITY_BASE_URL = "https://chat-app-api-ku3h.onrender.com"
$env:DATABASE_URL = $env:DIRECT_DATABASE_URL
npm run security:check
```

It covers missing/forged tokens, revoked `token_version` (the password-reset path) on both transports, outsider membership, and an exhaustive locked-chat bypass: reading, sending, editing, deleting, forwarding, reacting, read receipts, attachment uploads, `chat:join`, `chat:typing`, and `call:request`. It then verifies the correct PIN unlocks all of them and that no bypass attempt wrote a message or receipt. All rows are deleted afterwards.

### Browser tests (Playwright)

```powershell
cd "C:\Users\Debanjan\Chat App\frontend"
npm run test:e2e           # headless, 9 tests
npm run test:e2e:headed    # watch the browsers
```

Playwright starts Vite and the backend itself, reusing anything already listening on 5173/5000, seeds two verified accounts directly in the development database, and deletes them at the end. The suite signs in through the real form in two isolated browser contexts and checks: a live two-way message exchange with distinct per-tab tokens, staying signed in after a reload, the mobile layout and composer, an audio call, a video call with real frames (`videoWidth > 0` on both sides), and three cold-start retries (proxy 503, network failure, and a login retry).

The config defaults to the installed Google Chrome (`channel: 'chrome'`) because the Playwright browser CDN is blocked on some networks. Install Chrome, or run `npx playwright install chromium` once and start with `PLAYWRIGHT_CHANNEL=chromium`. Edge works with `PLAYWRIGHT_CHANNEL=msedge`. Calls need no real camera: the suite launches with Chrome's fake media devices.


## 7. Production deployment (Neon + object storage + Render)

Production uses three managed pieces, all with free tiers:

| Piece | Service | Why |
| --- | --- | --- |
| Database | Neon PostgreSQL 17, Singapore (`ap-southeast-1`) | Managed, backed up, connection pooling |
| Media | Neon Object Storage, private `media` bucket, same region | S3-compatible, no second account, 5 GB free |
| App server | Render web service, Singapore | Runs the Express + Socket.IO server |

Backblaze B2 (EU Central) is the supported fallback. One driver (`src/storage/s3.js`) talks to any path-style S3 endpoint, so switching is a set of `S3_*` values, a `b2` provider in `media_objects`, and no code change. See 7.2.1 for the trade-off.

Render's disk is **ephemeral**: anything written to `backend/uploads` disappears on the next deploy or restart. That is why production must run with `MEDIA_DRIVER=s3`. The local disk driver is for development only.

### 7.1 Neon

1. Create a Neon project with PostgreSQL 17 in `ap-southeast-1` (Singapore).
2. Copy both connection strings from **Connect**:
   - **Pooled** (host contains `-pooler`) → `DATABASE_URL`
   - **Direct** (no `-pooler`) → `DIRECT_DATABASE_URL`
3. Set `DATABASE_SSL=true`.

The pooled connection is for the running app; migrations, backfills, and backups use the direct connection because they rely on session-level advisory locks.

Point the migration runner at Neon and apply everything:

```powershell
cd "C:\Users\Debanjan\Chat App\backend"
$env:DIRECT_DATABASE_URL = "postgresql://user:password@ep-xxx.ap-southeast-1.aws.neon.tech/chat_app?sslmode=require"
$env:DATABASE_SSL = "true"
npm run db:status
npm run db:migrate
```

For a database that already contains the schema but no migration history, run `npm run db:baseline` once before `npm run db:migrate`.

### 7.2 Object storage

The app talks to any S3-compatible private bucket through `src/storage/s3.js`. Neon Object Storage is the default because it lives in the same project and region as the database, so media requests stay in Singapore.

1. In the Neon console open **Settings → Credentials → Create credential**, tick `storage:read` and `storage:write`, and create it on the branch the app uses (`production`). Copy the four AWS-format values; the secret is shown once.
2. Make sure the bucket exists (`media`) and is **private**.
3. Configure:

```env
MEDIA_DRIVER=s3
S3_ENDPOINT=https://br-xxxx.storage.c-1.ap-southeast-1.aws.neon.tech
S3_REGION=ap-southeast-1
S3_BUCKET=media
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
S3_FORCE_PATH_STYLE=true
MEDIA_PREFIX=prod
```

Neon and B2 both require path-style addressing; the driver defaults to it.

The browser never talks to the bucket directly. `/api/media/<file>?expires=...&signature=...` verifies the 7-day app signature, then redirects to a presigned GET. Two properties make that cheap:

- The presigned URL is signed with a **UTC-day-bucketed date**, so every request that day produces the identical URL. Objects upload with `Cache-Control: private, max-age=604800, immutable`, so a browser downloads each photo once and reuses it afterwards.
- The redirect itself is `Cache-Control: no-store`, so deleting the `media_objects` row (or the object) revokes access immediately instead of waiting for a cache to expire.

Check the bucket before deploying:

```powershell
npm run storage:test
```

#### 7.2.1 Backblaze B2 fallback

Same driver, different values. B2 puts the account in one region permanently at signup:

| Setting | B2 value |
| --- | --- |
| `MEDIA_DRIVER` | `s3` |
| `S3_ENDPOINT` | `https://s3.eu-central-003.backblazeb2.com` |
| `S3_REGION` | `eu-central-003` |
| `S3_BUCKET` | your private bucket |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | an application key scoped to that bucket |

Trade-off: B2 gives 10 GB of free storage, but free egress is only **3× your stored bytes per month** (roughly 30 MB with 10 MB stored), then $0.01/GB. Neon gives 5 GB of storage and 5 GB/month of egress in the same region as the database. Use B2 when storage volume matters more than egress, or as a second copy.

When switching providers, update `MEDIA_DRIVER`/`S3_*` and promote the rows with `npm run media:backfill` so `media_objects.storage_provider` matches where the bytes actually are.

### 7.3 Render

Render deploys through its GitHub app, not a personal access token. For a private repository, install the app once and give it access to this repo (**Dashboard → Account Settings → GitHub → Configure → Repository access**). Without that grant, service creation fails with `passed in repository URL is invalid or unfetchable` even when the repo exists.

Create a **Web Service** from the repository:

| Setting | Value |
| --- | --- |
| Root directory | `backend` |
| Runtime | Node |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/healthz` |
| Region | Singapore |
| Instance type | Free (see 10) |

Set `NODE_VERSION=22.14.0` on both services. Vite 8 builds with rolldown, whose Linux native binding declares `node >= 22.12.0`; on Node 22.11 npm silently skips that optional package and the static build fails with `Cannot find native binding`. A build that dies seconds after `vite build` starts is almost always this version mismatch, not the code.

Use `/healthz` for the Render health check and for any uptime monitor. It returns `200` without touching PostgreSQL, which matters because Neon's free plan bills compute while the database is awake. `/readyz` is the probe that actually queries the database; use it when debugging a deploy, not for frequent pings.

Environment variables:

```env
NODE_ENV=production
CLIENT_URL=https://your-frontend.example
ALLOWED_ORIGINS=https://your-frontend.example
DATABASE_URL=<Neon pooled URL>
DIRECT_DATABASE_URL=<Neon direct URL>
DATABASE_SSL=true
JWT_SECRET=<48+ random bytes>
MEDIA_SECRET=<different 48+ random bytes>
BREVO_API_KEY=<key>
EMAIL_FROM=<verified sender>
EMAIL_FROM_NAME=Chat App
MEDIA_DRIVER=s3
MEDIA_FALLBACK=none
MEDIA_URL_TTL_SECONDS=604800
MEDIA_SIGNED_URL_TTL_SECONDS=604800
MEDIA_PREFIX=prod
S3_ENDPOINT=https://br-xxxx.storage.c-1.ap-southeast-1.aws.neon.tech
S3_REGION=ap-southeast-1
S3_BUCKET=media
S3_ACCESS_KEY_ID=<key>
S3_SECRET_ACCESS_KEY=<secret>
S3_FORCE_PATH_STYLE=true
TRUST_PROXY_HOPS=1
```

`TRUST_PROXY_HOPS=1` lets Express read the real client IP from Render's proxy so per-IP limits work. `CLIENT_URL` must be the exact frontend origin, including scheme and no trailing slash.

With `NODE_ENV=production` the API now refuses to start when `JWT_SECRET` or `MEDIA_SECRET` is missing, shorter than 32 characters, or when both hold the same value. The old behavior silently signed sessions and media links with a value committed to this repository. Development keeps a throwaway fallback so a fresh clone still runs.

Deploy the frontend separately. On a **Render Static Site** use root directory `frontend`, build command `npm ci && npm run build`, and publish directory `dist`. Set its build variables before building:

```env
VITE_API_URL=https://your-api.onrender.com/api
VITE_SOCKET_URL=https://your-api.onrender.com
```

`VITE_*` values are compiled into the bundle, so change them and redeploy the frontend whenever the backend URL changes.

#### Security headers on the static site

Render static sites ignore `_headers` files, so the browser security headers are **Render header rules**, not files in this repository. They are configured per service (`POST /v1/services/{id}/headers` with `{ path, name, value }`) and apply to `/`:

| Header | Value |
| --- | --- |
| `Content-Security-Policy` | `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://your-api.onrender.com; media-src 'self' blob: https://your-api.onrender.com; connect-src 'self' https://your-api.onrender.com wss://your-api.onrender.com; font-src 'self'; manifest-src 'self'; worker-src 'self' blob:` |
| `Permissions-Policy` | `camera=(self), microphone=(self), geolocation=(), payment=(), usb=()` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` |
| `Cross-Origin-Opener-Policy` | `same-origin` |

`script-src 'self'` works because the build emits no inline scripts; `style-src` needs `'unsafe-inline'` for React's inline style attributes. Calls need `camera=(self)` and `microphone=(self)`, so keep those in the policy. **If the API host ever changes, update `img-src`, `media-src`, and `connect-src`** — `connect-src` needs both the `https://` and `wss://` forms or Socket.IO will be blocked. Verify with:

```powershell
(Invoke-WebRequest -UseBasicParsing "https://your-frontend.onrender.com").Headers["Content-Security-Policy"]
```

#### Deployment CI and emergency recovery

Git-triggered auto-deploy is **off** on both Render services (`autoDeployTrigger: "off"`). Pushing to `main` runs the CI workflow but does not deploy. Production is deployed only by the `deploy` job, and it accepts only the full SHA of a commit that already passed CI.

- **Normal deployment:** dispatch **CI** with the tested SHA. The job confirms the SHA is on `main` with a successful CI run, waits for active Render deploys, triggers both services with that SHA, polls to `live`, checks each deployment record's commit, then verifies `/healthz`, `/readyz`, the frontend, and the CSP header.
- **Emergency: temporarily abandon the CI route.** Re-enable Git-triggered deploys with Render's supported field, then deploy from the dashboard:

  ```powershell
  # RENDER_API_KEY comes from the environment; never commit it.
  $body = '{"autoDeployTrigger":"commit"}'
  Invoke-RestMethod -Method Patch -Uri "https://api.render.com/v1/services/<service-id>" `
    -Headers @{ Authorization = "Bearer $env:RENDER_API_KEY"; "Content-Type" = "application/json" } `
    -Body $body
  ```

  Use `autoDeployTrigger: "commit"`; the `autoDeploy` field is deprecated. Set it back to `"off"` as soon as the CI route is usable again.
- **Emergency manual deploy (break-glass).** A dashboard or API deploy is allowed only when Actions is unavailable or a fix cannot wait. Record the incident (who, when, commit, reason), deploy the exact commit, verify `/healthz`, `/readyz`, the frontend, and the CSP header, then dispatch CI for the same SHA so the normal gate and provenance are restored. Never deploy an untested SHA as a shortcut, and never roll back automatically.


### 7.4 Move the existing local data

The portable PostgreSQL install has no `pg_dump`, so `scripts/copy-database.js` copies rows over the wire in foreign-key order. It is transactional, refuses a non-empty target unless `--truncate` is passed, and never overwrites conflicting keys.

```powershell
cd "C:\Users\Debanjan\Chat App\backend"

# 1. Destination schema first (against Neon).
$env:DIRECT_DATABASE_URL = "postgresql://...neon.tech/chat_app?sslmode=require"
$env:DATABASE_SSL = "true"
npm run db:migrate

# 2. Preview the copy, then run it.
$env:SOURCE_DATABASE_URL = "postgresql://postgres:PASSWORD@localhost:5432/chat_app"
$env:TARGET_DATABASE_URL = $env:DIRECT_DATABASE_URL
npm run db:copy -- --dry-run
npm run db:copy
```

Then move the media bytes. The database already records the two files that were backfilled locally as `storage_provider = local`; running the backfill against object storage uploads those bytes and flips the rows to `s3` automatically (older unreferenced files are skipped):

```powershell
$env:MEDIA_DRIVER = "s3"
$env:S3_ENDPOINT = "https://br-xxxx.storage.c-1.ap-southeast-1.aws.neon.tech"
$env:S3_REGION = "ap-southeast-1"
$env:S3_BUCKET = "media"
$env:S3_ACCESS_KEY_ID = "..."
$env:S3_SECRET_ACCESS_KEY = "..."
npm run media:backfill
npm run media:verify
```

`media:verify` checks object sizes, samples checksums, and confirms every `/uploads/...` URL has a `media_id`. Only then switch Render to `MEDIA_DRIVER=s3`.

If you need to re-run the copy, use `npm run db:copy -- --truncate`; it truncates the application tables (never `schema_migrations`) inside the same transaction.

## 8. Media quotas and limits

| Limit | Default | Environment variable |
| --- | --- | --- |
| Image upload | 5 MB | multer limit in `server.js` |
| Status image/video | 25 MB | multer limit in `server.js` |
| Storage per account | 1 GB | `MEDIA_ACCOUNT_QUOTA_BYTES` |
| Uploads per account per day | 100 MB | `MEDIA_DAILY_QUOTA_BYTES` |
| Objects per account | 1,000 | `MEDIA_MAX_OBJECTS` |
| Uploads per account per hour | 40 | `UPLOAD_RATE_LIMIT` |
| Uploads per IP per hour | 120 | `UPLOAD_IP_RATE_LIMIT` |
| Image pixels / dimension | 40 MP / 4096 px | `MEDIA_MAX_PIXELS`, `MEDIA_MAX_DIMENSION` |

Uploads are sniffed by magic bytes, re-encoded with `sharp` (EXIF/GPS stripped, oversized images scaled down), and stored under a random UUID key. Quota checks run inside a transaction with a per-user row lock, so concurrent uploads cannot exceed the cap.

`GET /api/users/me/storage` returns the current account usage. A rejected upload removes the object it just wrote, so failed requests do not leak storage.

## 9. Backups and restore

### Database

- **Neon** keeps point-in-time history on paid plans and a shorter window on Free. Check **Branches → Restore** in the Neon console before relying on it. For a manual snapshot, create a branch; it is instant and copy-on-write.
- **Logical backup** (works with `pg_dump` from any PostgreSQL client install):

```powershell
pg_dump --format=custom --no-owner --no-privileges `
  --file="chat_app-$(Get-Date -Format yyyyMMdd).dump" `
  "postgresql://user:password@ep-xxx.neon.tech/chat_app?sslmode=require"
```

Store the dump outside the app server. A scheduled job can upload it to the `backups/` prefix of the media bucket. `npm run db:copy` is the no-`pg_dump` fallback for a live copy into an empty database.

- **Restore:** create a fresh Neon branch/database, run `pg_restore --no-owner --no-privileges --dbname "<target>" <file>`, point `DATABASE_URL`/`DIRECT_DATABASE_URL` at it, then run `npm run db:status` and `npm run media:verify`.

### Media

- Object keys are stable and unique (`prod/<kind>/<year>/<month>/<uuid>.<ext>`), and `media_objects.object_key` is the source of truth. Restoring bytes under the same keys needs no database changes.
- Mirror the bucket weekly to cold storage with the AWS CLI (works against Neon Object Storage and B2):

```powershell
aws s3 sync "s3://media/prod/" "./prod-backup/" --endpoint-url $env:S3_ENDPOINT
```

Keep at least one copy outside the same storage account. A deleted object can be recovered by re-uploading it under the key recorded in `media_objects`.

### Restore drill

1. Restore the database into a branch.
2. Run `npm run db:status` — expect every migration applied.
3. Run `npm run media:verify` — expect `Media verification passed`.
4. Sign in, open an old chat with a photo, and upload a new photo.
5. Only then switch production traffic to the restored database.

The no-`pg_dump` path is drilled the same way: create an empty scratch database, `npm run db:migrate`, then `SOURCE_DATABASE_URL=<prod> TARGET_DATABASE_URL=<scratch> npm run db:copy`, and compare `COUNT(*)` for every table plus a sample of message bodies. Migration `up` must run before the copy — the script refuses a target without a `users` table. Drop the scratch database afterwards. The last drill copied 71 rows across 8 tables with identical counts and message bodies.

### Restart behavior

A Render restart is not a health-check failure: the old instance keeps answering `/healthz` while the new one boots, then existing Socket.IO connections drop. In a measured restart, one signed-in socket disconnected 30.8 s after the request and reconnected 1.3 s later (32.1 s total) with authentication intact; `/healthz` never failed. The frontend shows a reconnect banner while the socket is down, and REST calls retry a cold API twice (after 2 s and 5 s) before giving up.


## 10. Free-tier notes

- **Neon Free** gives 100 CU-hours of compute, 1 GB of Postgres storage, and **5 GB/month of network transfer shared across Postgres and Object Storage**. Running out of transfer suspends compute until the next billing period, and compute suspends after 5 minutes idle anyway. Keep the uptime ping on `/healthz` so it does not wake the database.
- **Neon Object Storage Free** includes **5 GB per project**, in the same region as the database. Media quotas (section 8) cap each account long before that. Egress counts against the 5 GB shared transfer allowance; exceed it and the project's compute suspends rather than billing you.
- **Render Free** gives 512 MB RAM and spins the service down after about 15 minutes without traffic, so the first request can take 30–60 seconds. Point a free uptime monitor (UptimeRobot, cron-job.org, or a GitHub Actions schedule) at `https://your-api.onrender.com/healthz` every 10 minutes. That keeps the instance warm without keeping Postgres awake. If cold starts are unacceptable, the Render Starter plan ($7/month) removes the spin-down. Even without a monitor, the app recovers by itself: `/auth/me` and login retry after 2 s and 5 s and show "Waking the chat server…" instead of stranding the user on a login screen. A 40-socket load check (960 messages across 20 chats) held ~100 MB RSS with p95 latency of 115 ms and no dropped connections, so the 512 MB cap leaves room for personal use.
- Brevo Free sends about 300 emails per day, enough for sign-up codes and password resets.
- Uploads are processed one image at a time (`sharp.concurrency(1)`) to stay inside 512 MB.

## 11. Known data notes

- Two old messages contain inline `data:image/jpeg;base64,...` content from before uploads were stored as files. They cannot be moved to object storage, but they still render and are excluded from `media:verify` link checks.
- `backend/uploads` contains 26 unreferenced UUID files plus one older pre-UUID image (`1793112232638-*.png`). None are linked from any chat; the backfill skips them and `media:verify` reports how many UUID files remain. Archive the folder after cutover.
- `database/schema.sql` is historical. New schema changes go in `backend/database/migrations/NNNN_name.sql`.

## Features

- Phone-first registration with a searchable country picker, email verification (Brevo), and password recovery
- Independent per-tab sessions, so different tabs can stay signed in as different accounts
- Editable profiles, profile pictures, bios, and display names; profile edits appear live in other open tabs
- Contacts by phone number, with invite links and WhatsApp sharing for unregistered numbers
- "Existing contacts only" mode blocks strangers who add your number until a chat already exists
- Direct one-to-one chats and group chats (members chosen from chats and contacts, two-person groups allowed)
- Sent, delivered, and read receipts in direct and group chats
- Online/offline presence, exact last-seen times, and phone discoverability controls
- Typing indicators and timestamps
- Reply, forward, copy, edit, delete, react to, and star messages
- Unread counts and unread separators
- Search across chats and message content
- Block users, report users, and control who can start chats
- Menus close when you click elsewhere or press Escape
- WebRTC audio and video calls with ringing timeout, decline, busy handling, and automatic cleanup when either side disconnects or loses the connection (one-to-one chats only)
- Reconnect banner and call notices so a dropped socket is visible instead of silently swallowing calls
- Archive, locked chats, starred messages, and status updates

## Security notes

- Passwords are hashed with bcrypt; verification codes are stored as HMAC hashes, expire in 10 minutes, and allow five attempts.
- Phone numbers are **not verified by SMS** (no SMS budget). Account protection comes from the verified email; someone could still claim a phone number they do not own.
- An account whose email is inaccessible and whose password is lost cannot be recovered.
- API and Socket.IO connections require an authenticated session. The browser sends a per-tab bearer token, so tabs signed in as different accounts never share a session. Socket.IO re-verifies the token (and its `token_version`) on every handshake rather than trusting the cookie or a previous REST check.
- Presence and last-seen updates are only sent to saved contacts, direct-chat partners, and group co-members, and are suppressed when the user has hidden them.
- Status updates are visible only to their author, saved contacts, and chat partners; blocked users are excluded.
- Authorization checks protect chat membership, group membership, message editing, blocking, and reporting. Groups can only be created with saved contacts or existing chat partners, and group calls are rejected server-side.
- Uploads are validated by magic bytes, re-encoded to strip metadata, and size-capped (5 MB images, 25 MB status media) with per-account storage, daily-byte, object-count, and rate quotas.
- Media is never publicly mounted. Each avatar, chat photo, and status image is served through a signed, expiring `/api/media/...` URL (7 days by default); object-storage reads are a presigned redirect behind it, re-validated on every request. Chat photos must be uploaded before they can be attached, and only the uploader (or a chat that already contains the file) can attach it.
- Login, sign-up, code entry, and password-reset endpoints are rate limited. Sending messages, uploading media, and posting statuses are additionally limited per account (90 messages/minute over REST, 60/minute over Socket.IO, 40 uploads/hour, 10 statuses/day), with a separate upload budget per IP. IPv6 addresses are keyed by subnet so limits cannot be bypassed by rotating addresses.
- Password-reset requests bump a per-account token version, so every session issued before the reset stops working immediately.
- A locked chat keeps a bcrypt-hashed PIN on the server. Messages, previews, search results, uploads, and writes stay hidden until `POST /api/chats/:chatId/unlock` returns a 15-minute signed token; the PIN is never stored in the browser. The check runs on every REST route and Socket.IO event that can touch the chat — including `chat:join`, `chat:typing`, `message:send`, and `call:request` — and the regression suite proves each one is refused without a token. Failed PIN attempts are throttled in PostgreSQL (10 per 15 minutes per account and chat), so a restart or a second instance cannot reset the counter.
- Account deletion removes the user, their chats, and the media files they own; expired statuses are cleaned up hourly.
- Call history is stored per account so missed, declined, and completed calls survive a reload.
- Message content is stored unencrypted in PostgreSQL; production end-to-end encryption is not implemented yet.
- Production media lives in a private S3-compatible bucket (Neon Object Storage by default, Backblaze B2 as a fallback). The local disk driver is development-only because Render's filesystem is ephemeral. Storage failures are recorded on the media row and retried instead of silently dropping bytes.
- Google Drive backup is not implemented. Database backups use Neon branches/point-in-time restore plus `pg_dump` (or `npm run db:copy`), and the media bucket is mirrored separately; see sections 7–9.
