# Production Operations Guide

Operational reference for the deployed Chat App: CI/CD, Render services, environment
configuration, emergency procedures, database and media recovery, security controls,
monitoring, and the deploy checklist.

- **Audit date:** 2026-11-03
- **Production commit at audit time:** `f1dc9a39f660ea4c3ba72ccb903d092699f671f5` (`main`)
- **Scope:** documentation only. No application code, database, environment variable, or
  Render setting was changed during the audit.
- **Secrets:** this document lists variable and secret **names only**. Never paste values
  into this file, an issue, a commit, or a chat.

Capability labels used throughout:

| Label | Meaning |
| --- | --- |
| **VERIFIED** | Observed directly in the repository or against the live production service during this audit. |
| **DOCUMENTED BUT NOT TESTED** | The procedure exists on paper, but this audit did not execute it end to end. |
| **NOT CONFIGURED** | No implementation or configuration was found. |
| **OUTSTANDING** | Missing or unproven and required for production readiness. |

---

## 1. Architecture at a glance

```
Browser (React SPA)
   │  HTTPS + WSS
   ├──────────────► chat-app-web  (Render Static Site, CDN)
   │                   serves the built Vite bundle
   │
   └──────────────► chat-app-api  (Render Web Service, Node/Express + Socket.IO)
                       │
                       ├──► Neon PostgreSQL (pooled connection for runtime)
                       │       users, chats, messages, media_objects, ...
                       │
                       └──► Neon Object Storage (S3-compatible bucket, reached only through presigned URLs)
                               image/video bytes, served via signed /api/media links
```

| Component | Production value |
| --- | --- |
| API URL | `https://chat-app-api-ku3h.onrender.com` |
| Frontend URL | `https://chat-app-web-ywez.onrender.com` |
| API host | Render Web Service, Node runtime, Singapore, Free plan, 1 instance |
| Frontend host | Render Static Site, Singapore, Free plan |
| Database | Neon PostgreSQL, pooled URL for the app, direct URL for migrations |
| Media | Neon Object Storage, S3-compatible bucket (`media`), prefix `prod`; media is delivered only through signed/presigned URLs |
| Email | Brevo (primary; the code also supports Resend, but Resend is not configured in production) |
| Source of truth | `main` in `contactdeba51-netizen/chat-app` |
| Production deployment | GitHub Actions `deploy` job only; Render Git auto-deploy is **off** |

Request flow details:

- The browser calls the API with a per-tab bearer token (the API also accepts a cookie).
- Socket.IO uses the same API host over WSS and re-verifies the token on every handshake.
- Media is never served from a public directory. Each file is returned through an
  app-signed `/api/media/<uuid>.<ext>` link; the API then redirects to a short-lived
  presigned object-storage URL. The media row is re-read on every request, so deleting
  the row revokes access immediately.
- The API is stateless except for in-memory presence and call state; it runs as a single
  instance, so a restart drops open Socket.IO connections and active calls.

---

## 2. CI/CD architecture

Workflow file: `.github/workflows/ci.yml` (name: `CI`).

### 2.1 Triggers

| Event | What runs |
| --- | --- |
| `push` to `main` | Verify, then Deploy |
| `pull_request` (any branch) | Verify only; Deploy is skipped |
| `workflow_dispatch` | Verify, then Deploy **only when dispatched on `main`** |

There are no custom `workflow_dispatch` inputs. A manual run deploys the commit that is
the head of the selected branch at dispatch time — there is no box for entering a SHA.

### 2.2 Verify job

`verify` runs on `ubuntu-latest`, timeout 25 minutes, with read-only repository
permissions (`contents: read`).

| Step | What it proves |
| --- | --- |
| Check out the tested commit | Code under test is the run's commit |
| Set up Node.js 22.14.0 + npm cache | Matches the production Node version |
| Refuse any non-local test database | `DATABASE_URL`/`DIRECT_DATABASE_URL` must resolve to `localhost`/`127.0.0.1`/`::1` and `/chat_app_ci`; CI cannot accidentally hit Neon |
| Install backend and frontend dependencies | `npm ci` from both lockfiles |
| Backend JavaScript syntax checks | `node --check` over every file in `backend/src` and `backend/scripts` |
| Apply database migrations | `npm run db:migrate` against a disposable `postgres:17` service container |
| Assert no migrations are pending | `npm run db:status` must contain `0 pending` |
| Start the API and wait for health | `npm start`, then poll `http://localhost:5000/healthz` for up to 60 s |
| Smoke tests | `npm run smoke` |
| Security regression tests | `npm run security:check` |
| Production frontend build | `npm run build` (Vite) |
| Playwright end-to-end tests | Chromium, against the locally started API |
| Upload Playwright traces on failure | Artifact `playwright-<run_attempt>`, 7-day retention |
| Show API log on failure | Tail of the local backend log |
| Publish job summary | Per-step outcomes, commit SHA, disposable-DB note |

The CI database is a service container with hard-coded throwaway credentials. The job
also sets throwaway `JWT_SECRET`/`MEDIA_SECRET` values that exist only inside the job.

### 2.3 Deploy job

`deploy` runs only when **all** of these are true:

```yaml
if: needs.verify.result == 'success' &&
    (github.event_name == 'push' || github.event_name == 'workflow_dispatch') &&
    github.ref == 'refs/heads/main'
```

The job has `needs: [verify]`, timeout 60 minutes, and read-only repository permissions.
`RENDER_API_KEY` is exposed only to this job.

Sequence:

1. **Require the Render credential** — fails fast if `RENDER_API_KEY` is empty, with a
   message pointing at the repository secret settings.
2. **Check out the verified commit** with full history.
3. **Verify the deployment commit** — `TARGET_COMMIT` (set to `github.sha`) must equal the
   checked-out `HEAD`, `origin/main` must exist, and the commit must be an ancestor of
   `origin/main`.
4. **Verify Render services and wait for idle** — fetches each service by the hard-coded
   service ID, asserts name and type, then refuses to start while either service has an
   active deployment (up to 20 minutes).
5. **Trigger deployments** — `POST /v1/services/<id>/deploys` with
   `{"commitId": "<verified sha>"}` for the API and then the static site. If a trigger
   response is ambiguous, it inspects recent deployments and only proceeds when exactly
   one matching deployment exists; it never blindly retries.
6. **Wait for both deployments to go live** — polls every 10 seconds for up to 20 minutes,
   checking on every poll that the deployment's `commit.id` still equals the target SHA.
   `build_failed`, `update_failed`, `pre_deploy_failed`, `canceled`, and `deactivated` are
   terminal failures.
7. **Verify production health** — API `/healthz` must return HTTP 200 with
   `{"status":"ok"}`, `/readyz` must return 200, the frontend `/` must return 200, and the
   frontend CSP must contain `default-src 'self'` and `frame-ancestors 'none'`.
8. **Publish deployment summary** — target commit, both deployment IDs, and each step's
   outcome.

Both services are deployed with the **same** `TARGET_COMMIT`; the job fails if either
Render deployment record references a different commit.

### 2.4 Deployment invariants

| Invariant | Enforcement |
| --- | --- |
| Only verified code deploys | `needs.verify.result == 'success'` |
| Only `main` deploys | `github.ref == 'refs/heads/main'` |
| Pull requests never deploy | Event check excludes `pull_request` |
| Deployed SHA is the verified SHA | `TARGET_COMMIT == github.sha`, checkout check, ancestry check |
| Both services get the same SHA | Both trigger calls use `TARGET_COMMIT`; polling re-checks `commit.id` |
| No concurrent production deploys | `concurrency: production-deploy`, `cancel-in-progress: false` |
| Render does not deploy on its own | `autoDeployTrigger: off` on both services |

### 2.5 What the pipeline does **not** do

- **It does not run migrations against production.** Migrations run only against the
  disposable CI database. Production schema changes are a separate, manual operator step
  (section 7.2). A green deploy does not prove the production schema is current.
- **It does not back up anything.**
- **It does not roll back.** A failed or unhealthy deployment stays in place until a human
  acts (section 6.4).
- **It does not test login, Socket.IO, or messaging against production.** CI checks
  `/healthz`, `/readyz`, the frontend, and CSP after deploy. The remaining smoke checks
  are manual checklist items.

### 2.6 Concurrency

- Verify: `group: ci-verify-${{ github.event_name }}-${{ github.ref }}`,
  `cancel-in-progress: true`. Superseded verification runs for the same event and ref are
  canceled; this is safe because verification has no production side effects.
- Deploy: `group: production-deploy`, `cancel-in-progress: false`. A second production
  deployment **waits** rather than canceling or racing the running one.

Why this matters: two overlapping deploys can interleave API and frontend versions, leave
one service on an older SHA, cancel a build halfway through, or make rollback reasoning
impossible. Cancellation is disabled so an in-flight deploy always reaches a terminal
state that an operator can inspect.

---

## 3. GitHub Actions configuration and secrets

### 3.1 Required repository configuration

| Kind | Name | Used by | Notes |
| --- | --- | --- | --- |
| Secret | `RENDER_API_KEY` | `deploy` job only | Render account API key. The only repository secret confirmed on 2026-11-03. |
| Variable | *(none)* | — | The workflow references no `vars.*` entries. Do not add one unless the workflow is changed to use it. |

The only external credential the workflow needs is `RENDER_API_KEY`. Everything else the
deploy job uses is built in (`github.sha`, the read-only workflow token used by checkout)
or hard-coded (service IDs, API base URL, production URLs). Do **not** add database or
storage credentials to GitHub: production data credentials live in Render environment
variables. A local, Git-ignored `backend/.env.production.local` also exists on the operator
machine for deployment/audit work; it must never be committed, shared, or copied into CI.

`verify` runs with no production secrets. The disposable database and test secrets are
plain job-level environment values, not repository secrets.

### 3.2 Confirming a secret exists without reading it

- GitHub UI: **Settings → Secrets and variables → Actions** shows the secret name and its
  last-updated timestamp; it never shows the value.
- GitHub CLI (admin): `gh secret list --repo contactdeba51-netizen/chat-app`.
- REST: `GET /repos/{owner}/{repo}/actions/secrets` requires admin access. A read-only or
  fine-grained token without that permission returns HTTP 403 — absence of a response is
  not evidence that no secret exists.
- Workflow self-check: `deploy` fails immediately at **Require the Render credential** if
  the secret is missing or empty.

### 3.3 Rotating `RENDER_API_KEY`

1. In Render, open **Account Settings → API Keys** and create a new key.
2. In GitHub, **Settings → Secrets and variables → Actions → `RENDER_API_KEY` → Update**,
   and paste the new value.
3. Run **Actions → CI → Run workflow** on `main` and confirm Verify and Deploy succeed.
   This also proves the new key can read both services and trigger deployments.
4. Revoke the old key in Render.
5. Record the rotation date and operator in the incident/change log. Never write the key
   into a file, ticket, or commit.

If a key leaks: revoke it first, then rotate. Revocation stops new deployments but does
not affect already-running services.

### 3.4 Pull-request safety

- `pull_request` runs only `verify`; the `deploy` condition excludes that event.
- The deploy job, and therefore `RENDER_API_KEY`, is never scheduled for a pull request.
- Workflow permissions are `contents: read` at both workflow and job level; the workflow
  does not need write access to the repository.
- Do not add `pull_request_target` to this workflow. It would run untrusted PR code with
  access to repository secrets.

---

## 4. Render configuration

### 4.1 Services

| Setting | API (`chat-app-api`) | Frontend (`chat-app-web`) |
| --- | --- | --- |
| Service ID | `srv-dbjl9lc9v7es73aeeqs0` | `srv-dbjla58u01pc73fqe5kg` |
| Type | `web_service` | `static_site` |
| Repository | `contactdeba51-netizen/chat-app` | `contactdeba51-netizen/chat-app` |
| Branch | `main` | `main` |
| Root directory | `backend` | `frontend` |
| Runtime | Node | Static site |
| Build command | `npm ci` | `npm ci && npm run build` |
| Start command | `npm start` | *(not applicable)* |
| Publish path | *(not applicable)* | `dist` |
| Health check path | `/healthz` | *(none; CI checks `/`)* |
| Plan / region | Free / Singapore, 1 instance | Static site (plan/region not reported by the API) |
| Git auto-deploy | `autoDeployTrigger: off` | `autoDeployTrigger: off` |
| Last verified deployment | `dep-dbkn3q6k1f9s73df5od0`, live, `f1dc9a3…` | `dep-dbkn3qbncjis73eq4ofg`, live, `f1dc9a3…` |

> **Service ID discrepancy:** the Stage 5C brief listed the API service as
> `srv-dbjl9lc9v7es73aeeqs1`. That ID returns HTTP 404 from the Render API. The live,
> verified service is `srv-dbjl9lc9v7es73aeeqs0`, and that is the ID hard-coded in the
> workflow. Do not "correct" the workflow to the 404 ID.

### 4.2 How a deployment happens

1. GitHub Actions verifies a commit on `main`.
2. The deploy job calls Render's REST API with the commit SHA for each service.
3. Render builds the API (`npm ci`) and static site (`npm ci && npm run build`), then
   starts/publishes them.
4. Actions polls both deployments until `live` and checks the commit on each record.
5. Actions probes `/healthz`, `/readyz`, `/`, and the frontend CSP.

Render's own Git auto-deploy remains off, so a push that bypasses Actions (for example, a
direct commit made outside the workflow, or a workflow misconfiguration) will **not**
reach production on its own.

### 4.3 Inspecting deployments

Render dashboard → select the service → **Deploys**. Each entry shows status, trigger,
commit, and timestamps. Useful fields:

| Field | Meaning |
| --- | --- |
| `id` | Deployment ID (`dep-…`); quote it in incident notes |
| `status` | `created`, `build_in_progress`, `update_in_progress`, `live`, `deactivated`, `build_failed`, `update_failed`, `pre_deploy_failed`, `canceled` |
| `trigger` | `api` for Actions/bring-your-own-SHA deploys, `new_commit` for Render Git deploys |
| `commit.id` | Full commit SHA the deployment built |

A deployment is only trustworthy when `status` is `live` **and** `commit.id` equals the
intended full SHA. A `live` deployment of the previous commit means the new trigger did
not take effect.

### 4.4 Checking for active deployments

Before any manual deploy, confirm neither service has a deployment in a non-terminal
state. The workflow does this automatically (`wait_for_idle`). Manually, inspect the
deploys list and look for any status other than `live`, `deactivated`, `canceled`,
`build_failed`, `update_failed`, or `pre_deploy_failed`.

---

## 5. Environment configuration (names only)

Never copy values from Render into documentation. The lists below are the actual variable
names configured on each service as of the audit.

### 5.1 API service

| Group | Variables |
| --- | --- |
| Runtime | `NODE_ENV`, `NODE_VERSION` *(Render injects `PORT` at runtime; it is not user-set)* |
| Database | `DATABASE_URL`, `DIRECT_DATABASE_URL`, `DATABASE_SSL`, `PG_POOL_MAX` |
| Sessions | `JWT_SECRET` |
| Media signing | `MEDIA_SECRET`, `MEDIA_URL_TTL_SECONDS`, `MEDIA_SIGNED_URL_TTL_SECONDS` |
| Media storage | `MEDIA_DRIVER`, `MEDIA_FALLBACK`, `MEDIA_PREFIX`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` |
| Browser origins | `CLIENT_URL`, `ALLOWED_ORIGINS` |
| Proxy | `TRUST_PROXY_HOPS` |
| Email | `BREVO_API_KEY`, `EMAIL_FROM`, `EMAIL_FROM_NAME` |

Observed safe, non-secret values worth knowing operationally: `NODE_ENV=production`,
`NODE_VERSION=22.14.0`, `DATABASE_SSL=true`, `MEDIA_DRIVER=s3`, `MEDIA_FALLBACK=none`,
`MEDIA_PREFIX=prod`, media TTLs `604800`, `PG_POOL_MAX=5`, `S3_BUCKET=media`,
`S3_REGION=ap-southeast-1`, `S3_FORCE_PATH_STYLE=true`, `TRUST_PROXY_HOPS=1`.

`MEDIA_FALLBACK=none` means production does **not** mirror uploads to local disk. Render's
filesystem is ephemeral, so object storage is the only application-managed durable copy of
media bytes.

### 5.2 Frontend service

| Variable | Purpose |
| --- | --- |
| `NODE_VERSION` | Build-time Node version (`22.14.0`) |
| `VITE_API_URL` | API base including `/api` |
| `VITE_SOCKET_URL` | Socket.IO origin (no path) |

`VITE_*` values are compiled into the bundle. Changing either requires a **rebuild and
redeploy** of the static site; changing the Render variable alone does nothing to the
already-published bundle. If the API host changes, also update the frontend CSP
`img-src`, `media-src`, and `connect-src` (`connect-src` needs both `https://` and
`wss://`).

### 5.3 Production fail-closed rules

`backend/src/secrets.js` is evaluated at startup:

- `NODE_ENV=production` plus a missing/short (`< 32` characters) `JWT_SECRET` or
  `MEDIA_SECRET` aborts startup.
- `JWT_SECRET` and `MEDIA_SECRET` must differ.
- Development keeps a throwaway fallback so a fresh clone runs before `.env` is filled.

This is intentional: refusing to start is safer than signing sessions and media links with
a value committed to the repository.

---

## 6. Emergency procedures

### 6.1 Situation A — GitHub Actions is working

Preferred recovery for a bad deploy or an urgent fix.

1. Confirm the fix is merged to `main` (or identify the exact known-good commit already on
   `main`).
2. **Actions → CI → Run workflow → Branch: `main` → Run workflow.** There are no other
   inputs.
3. Watch `verify`. Do not bypass or re-run only `deploy`; the point is to re-verify.
4. On success, confirm `deploy` triggered both services with the same SHA.
5. Verify deployment records: both `live`, both `commit.id` equal to the intended SHA.
6. Probe `/healthz` (200, `status: ok`), `/readyz` (200), frontend `/` (200), and the
   frontend CSP.
7. Perform the manual smoke checks: login, Socket.IO connection, send a message.
8. Record the change and outcome.

A manual dispatch re-runs the normal gate. It is not a shortcut around verification.

### 6.2 Situation B — GitHub Actions is unavailable (break-glass)

Use only when Actions cannot run and the change cannot wait. A direct Render deploy
**bypasses the automated gate** and must be treated as an incident.

**Authorization:** the repository owner (`contactdeba51-netizen`) or an explicitly
designated maintainer. For a production-impacting change, get a second person to confirm
the SHA and the reason if one is available. Never let an unauthorized operator deploy
"quickly" from a dashboard.

**Procedure:**

1. **Identify the intended full SHA.** Use `git rev-parse origin/main` on a fresh clone,
   the GitHub commit page, or the SHA shown on a successful CI run. Write it down in full
   (40 characters); short SHAs are not acceptable for a break-glass deploy.
2. **Confirm the commit exists in the repository.**
   ```bash
   git fetch origin
   git cat-file -e <full-sha>^{commit}
   git merge-base --is-ancestor <full-sha> origin/main
   ```
   It must be reachable from `main`.
3. **Confirm the code passed CI where possible.** Find a successful `CI` run whose
   `GITHUB_SHA` is that commit. If no successful run exists, the commit is untested — do
   not deploy it merely because Actions is down. Use the last verified commit instead.
4. **Deploy both services deliberately, with auto-deploy still off.**
   - Dashboard: service → **Manual Deploy → Deploy a specific commit** → paste the full SHA.
   - API: `POST https://api.render.com/v1/services/<service-id>/deploys` with
     `{"commitId":"<full-sha>"}` and an `Authorization: Bearer <Render API key>` header.
   - Repeat for both `chat-app-api` and `chat-app-web` with the **same** SHA.
   - Do **not** re-enable `autoDeployTrigger`; leaving it off prevents an accidental
     second deploy path.
5. **Confirm both services run the same SHA.** In each service's deploy list, the newest
   deployment must be `live` and its `commit.id` must equal the full SHA.
6. **Verify production.**
   ```powershell
   curl.exe -sS -o NUL -w "%{http_code}`n" https://chat-app-api-ku3h.onrender.com/healthz
   curl.exe -sS -o NUL -w "%{http_code}`n" https://chat-app-api-ku3h.onrender.com/readyz
   curl.exe -sS -o NUL -w "%{http_code}`n" https://chat-app-web-ywez.onrender.com/
   curl.exe -sSI https://chat-app-web-ywez.onrender.com/ | Select-String "content-security-policy"
   ```
   Then check login, Socket.IO connection, and a basic message send in the browser.
7. **Record the incident.** Who authorized, who deployed, UTC timestamps, full SHA, reason,
   both deployment IDs, probe results, and any follow-up. Note explicitly that the normal
   CI gate was bypassed.
8. **Return to the normal process.** Leave `autoDeployTrigger` off. Once Actions is
   healthy, run the workflow on `main` for the same commit (or merge the next change
   normally). This re-establishes CI provenance and verifies the deployment path again.
   If the break-glass deployment used an untested commit, treat re-verification as
   mandatory and be prepared to redeploy a verified commit.

**Never** deploy an untested SHA simply because the pipeline is unavailable. "The site is
down" is a reason to deploy the last known-good, verified commit — not an unverified one.

### 6.3 Situation C — a deployment fails or health checks fail

Investigate in this order; do not change production settings to "make it pass".

1. **GitHub Actions log.** Open the failing run and read the failed step:
   credential, commit verification, Render preflight, trigger, poll, or production health.
   The job summary lists each step's outcome and both deployment IDs.
2. **Render deployment log.** For the deployment ID in the summary, read the build and
   runtime logs. Common causes: `npm ci` lockfile failure, Node version mismatch
   (`NODE_VERSION`), missing environment variable, process exiting at startup, port
   binding, or a migration/schema mismatch.
3. **`/healthz`.** Must be 200 with `{"status":"ok"}`. It does not touch the database, so a
   failure here points to the process, routing, or Render service state.
4. **`/readyz`.** Must be 200 (`{"status":"ready"}`). This queries PostgreSQL. A 5xx or
   timeout means database connectivity, credentials, pool exhaustion, or Neon suspension.
5. **Frontend availability.** `/` must return 200 and the built asset must load. A 404 on
   `/assets/...` usually means the build did not publish `dist` or the wrong branch/SHA
   was built.
6. **CSP headers.** Confirm the frontend response still has `default-src 'self'` and
   `frame-ancestors 'none'`, and that `connect-src` includes both the `https://` and
   `wss://` API host. A missing header is a Render header-rule problem, not an app bug.
7. **Database connectivity.** `/readyz`, then Neon console status (compute active vs.
   suspended, transfer quota). Check `DATABASE_URL`/`DIRECT_DATABASE_URL` presence and
   `DATABASE_SSL=true`; never print the URLs.
8. **Media storage connectivity.** Confirm `MEDIA_DRIVER=s3` and the `S3_*` names are still
   present. From a trusted machine with production credentials loaded into the shell only,
   `npm run storage:test` round-trips a tiny object through the configured bucket. This
   writes one small test object and deletes it; do not run it casually against production.
   A 503 on uploads with `MEDIA_DRIVER=s3` means incomplete storage credentials.
9. **Socket.IO connectivity.** In the browser devtools Network → WS, confirm the handshake
   to the API host succeeds and reconnects after a restart. Check for a CORS/origin
   rejection (`CLIENT_URL`/`ALLOWED_ORIGINS`), a 401 (token/secret issue), or a CSP
   `connect-src` block.

### 6.4 Rollback policy

There is **no automatic rollback** and no `rollback` workflow step. A rollback is an
explicit human decision:

1. Identify a verified known-good full SHA (it must have had a successful CI run).
2. Decide whether the current database schema is compatible with the older code.
   Migrations are forward-only; a code rollback does not undo schema changes.
3. Redeploy the known-good SHA to both services using the Situation A or B procedure.
4. Verify both deployment records, probes, CSP, login, Socket.IO, and messaging.
5. Record the rollback as an incident with the reason and both SHAs.

Render's dashboard may expose a rollback action for a previous deploy. If it does, that is
still a manual action and must be followed by the same verification. Never roll back
silently or assume the database will follow.

---

## 7. Database operations

### 7.1 Provider and connection architecture

- **Provider:** Neon PostgreSQL (managed). No database server runs inside Render.
- **Runtime connection:** pooled Neon URL in `DATABASE_URL`. The pool is capped at
  `PG_POOL_MAX=5`, with 30 s idle timeout and 10 s connection timeout.
- **Migration/direct connection:** `DIRECT_DATABASE_URL` uses Neon's direct (non-pooler)
  host. Advisory locks need a session connection, so migrations and copy/backfill scripts
  use the direct URL.
- **TLS:** `DATABASE_SSL=true`; the driver uses `rejectUnauthorized: false` because Neon
  presents a managed certificate chain.
- **Secrets:** both URLs are Render environment variables (also present in the local,
  Git-ignored operator env file). They are never in Git, CI, or this document.

### 7.2 Migrations

- Location: `backend/database/migrations/NNNN_name.sql`; the runner is
  `backend/scripts/migrate.js`.
- **Forward-only.** There are no down migrations. Each file is checksummed; editing an
  already-applied file causes drift detection to fail.
- A PostgreSQL advisory lock (`72810341`) serializes concurrent migration runs.
- Files tagged `-- migrate:no-transaction` run statement-by-statement (needed for
  `CREATE INDEX CONCURRENTLY`).
- Commands (run from `backend/` with `DIRECT_DATABASE_URL` set):
  ```powershell
  npm run db:status     # applied/pending + checksum drift
  npm run db:migrate    # apply all pending
  npm run db:baseline   # record 0001 on a database that already has the schema
  ```
- **Production is not migrated by CI or by `npm start`.** Apply migrations manually before
  (or in a compatible order with) deploying code that needs them. Rollout rule: make
  schema changes backward-compatible with the currently running code, apply them, deploy,
  then remove old columns/tables in a later migration.
- This audit did not query the production schema. Verify with `npm run db:status` using the
  direct URL before assuming production is at the latest migration.

### 7.3 Backup status

| Capability | Status | Evidence / limitation |
| --- | --- | --- |
| Application-scheduled `pg_dump` | **NOT CONFIGURED** | No cron, workflow, Render job, or script schedules a dump. `pg_dump` is not installed on the audit machine. |
| Backup upload to object storage | **NOT CONFIGURED** | README describes it as a possible manual job; no job exists. |
| Neon provider backups / PITR | **NOT VERIFIED** | Neon is expected to provide branch/restore history, but the plan's window and retention were not inspected. Verify in the Neon console (project → **Branches → Restore**). |
| Restore procedure | **DOCUMENTED BUT NOT TESTED** | README procedure plus the scripts below; the historical drill is partial (section 7.6). |
| Restore drill automation | **NOT CONFIGURED** | No recurring drill. |
| Retention policy | **NOT VERIFIED** | Do not assume a number. Read it from the Neon console. |

The only thing that can be stated with confidence: **no application-level backup schedule
was found in this repository, the single GitHub workflow, or the Render account service
list (two services, no cron job).** Whether Neon itself retains history is a provider
setting the operator must confirm. A restore script existing in the repo is not evidence
that backups exist.

Required access to operate backups/restores:

- Neon project access with permission to create branches/databases and read connection
  strings.
- Render environment-variable edit permission (to repoint `DATABASE_URL` /
  `DIRECT_DATABASE_URL` after a restore).
- GitHub repository admin (to rotate `RENDER_API_KEY`) if the change affects deploys.
- A machine with PostgreSQL client tools for `pg_dump`/`pg_restore`, or Node plus this
  repo's scripts for the no-`pg_dump` path.

### 7.4 Recovery procedure

1. **Confirm the recovery point.** In Neon, inspect the branch history / restore window
   and choose a timestamp before the damaging change. Record it.
2. **Create a new branch or database** from that point. Do not overwrite the production
   branch in place.
3. **Point a test instance at the restored database.** Use a temporary local or Render
   service configuration; do not change production yet.
4. **Apply/verify schema.** `npm run db:status` must report `0 pending`, or run
   `npm run db:migrate` if the chosen point predates a migration.
5. **Verify data.** Compare row counts for the main tables and sample message bodies.
   `npm run media:verify` checks that every referenced `/uploads/...` URL has a
   `media_objects` row and that object sizes/checksums match storage.
6. **Functional check.** Sign in, open an old chat with a photo, send a message, upload a
   new photo.
7. **Cut over deliberately.** Update Render's `DATABASE_URL` and `DIRECT_DATABASE_URL`,
   redeploy/restart, then re-run `/readyz` and the smoke checks. Keep the old branch until
   the new one is proven.
8. **Record** the recovery point, restore target, verification results, and cutover time.

**With `pg_dump` available**, a logical backup/restore is:

```powershell
pg_dump --format=custom --no-owner --no-privileges `
  --file="chat_app-$(Get-Date -Format yyyyMMdd-HHmm).dump" `
  "<direct-neon-url>"

pg_restore --no-owner --no-privileges --dbname "<restore-target-url>" "<dump-file>"
```

Store the dump outside the app server and outside the same provider account. Never commit
a dump.

**Without `pg_dump`**, use `backend/scripts/copy-database.js`:

```powershell
# Target schema first
$env:DIRECT_DATABASE_URL = "<target-direct-url>"
$env:DATABASE_SSL = "true"
npm run db:migrate

# Preview, then copy
$env:SOURCE_DATABASE_URL = "<source-direct-url>"
$env:TARGET_DATABASE_URL = "<target-direct-url>"
npm run db:copy -- --dry-run
npm run db:copy
```

The script copies in foreign-key order inside a transaction, refuses a non-empty target
unless `--truncate` is passed, and skips conflicting primary keys. It does **not** copy
media bytes; run `media:backfill` / restore the bucket separately and then
`media:verify`.

### 7.5 Verifying a restored database

| Check | Command / signal | Expected |
| --- | --- | --- |
| Schema complete | `npm run db:status` | `0 pending`, no checksum drift |
| App can reach it | `GET /readyz` | 200, `{"status":"ready"}` |
| Data present | `COUNT(*)` on users/chats/messages/media_objects | Non-zero, comparable to source |
| Content sane | Sample message bodies and timestamps | Match the chosen recovery point |
| Media consistency | `npm run media:verify` | `Media verification passed` |
| Functional | Login, open chat, send, upload | All succeed |

### 7.6 Historical evidence (not proof of current backups)

A previous isolated drill copied **71 rows across 8 tables** into a scratch database with
`db:copy`, compared per-table counts and sample message bodies, and found them identical.
That drill proves the copy script worked at that time against that data set. It does
**not** prove that:

- backups run on a schedule,
- a retention window exists,
- a restore from a provider backup works,
- media bytes are recoverable.

**Media bytes were not restored in that drill.** Treat database restore and media restore
as two separate capabilities.

---

## 8. Media operations

### 8.1 Actual architecture

| Item | Value |
| --- | --- |
| Driver | `MEDIA_DRIVER=s3` (generic S3-compatible) |
| Provider | Neon Object Storage |
| Endpoint | HTTPS S3-compatible endpoint in `ap-southeast-1` |
| Bucket | `media` (bucket policy not independently audited; the app uses only presigned access) |
| Key prefix | `prod` |
| Key shape | `prod/<kind>/<year>/<month>/<uuid>.<ext>` |
| Local fallback in production | Disabled (`MEDIA_FALLBACK=none`) |
| Read path | App-signed `/api/media/<file>` (HMAC, 7-day TTL) → presigned storage redirect |
| Metadata | `media_objects` table in PostgreSQL |

`media_objects` is the source of truth for ownership, provider, bucket, key, MIME type,
size, checksum, status (`ready` / `pending_delete` / `deleted`), and delete-retry
bookkeeping. Reads follow the row's `storage_provider`, not the current configuration, so
old local/R2 rows still resolve correctly. Chat messages and profiles store a
`/uploads/<uuid>.<ext>` reference; the API maps that to the key recorded in
`media_objects`.

Upload controls:

- MIME allowlist at the multer layer (JPEG/PNG/WebP/GIF for images; plus MP4/WebM/MOV for
  status media).
- Magic-byte sniffing and `sharp` re-encode (strips EXIF/GPS, caps pixels/dimensions).
- Per-account storage (1 GB), daily bytes (100 MB), object count (1,000), and rate limits.
- Quota checks run in a transaction with a per-user row lock.
- Objects are written to a scratch directory first and get a permanent UUID name only
  after validation.

### 8.2 Backup status

| Capability | Status | Evidence / limitation |
| --- | --- | --- |
| Scheduled bucket mirror/replication | **NOT CONFIGURED** | No cron, workflow, or Render job. The README's `aws s3 sync` is a manual procedure. |
| Object versioning | **NOT VERIFIED** | Not checked in this audit. |
| Cross-provider copy | **NOT CONFIGURED** | No second copy is configured. |
| Media restore procedure | **DOCUMENTED BUT NOT TESTED** | README procedure; no drill performed. |
| Media restore drill | **NOT CONFIGURED** | No record of one. The prior DB drill explicitly did not restore bytes. |
| Storage usage alerting | **NOT CONFIGURED** | No alert; only the per-account `/api/users/me/storage` endpoint. |

The media bucket is the **only copy the application relies on**. No second copy is
configured or verified. A database restore without a matching media restore produces rows
that reference missing objects.

### 8.3 Backup procedure (manual, not scheduled)

With AWS CLI configured for the S3-compatible endpoint:

```powershell
aws s3 sync "s3://media/prod/" "./prod-media-backup/" `
  --endpoint-url $env:S3_ENDPOINT
```

- Keep the copy outside the same storage account/provider.
- Store credentials only in the operator's environment; never commit them.
- Verify the copy: file count and total bytes should match the source, and
  `media:verify` (against the restored copy) should pass.
- This is a documented procedure, **not** an automated backup. Until a schedule exists,
  no one should assume a recent copy is available.

### 8.4 Restore procedure

1. Restore objects under their **original keys** (`prod/...`). `media_objects.object_key`
   is the reference; renaming keys breaks lookups.
2. Restore the database from the matching point in time. Older/newer object sets are
   tolerable in one direction:
   - Objects newer than the DB restore become unreferenced orphans (wasted space, no user
     impact).
   - Rows newer than the media restore point reference missing objects (broken images).
3. Run `npm run media:verify` (optionally `-- --sample=25`) to check sizes, sampled
   checksums, and link coverage.
4. Open a chat with an old photo and upload a new one; confirm both render.
5. Only then consider the restore complete.

### 8.5 Consistency and failure modes

- **DB restored, media not restored:** chat rows reference keys that do not exist. Media
  links 404/410; uploads still work; no automatic repair exists. Restore the bucket or
  accept permanent loss of the missing media.
- **Media restored, DB not restored:** orphan objects consume storage but are harmless.
  `media:verify` does not enumerate remote bucket orphans; use a bucket inventory to find
  them.
- **Partial media restore:** same as a missing restore for the affected keys; verify with
  `media:verify` before declaring success.
- **Delete races:** deletes are recorded (`pending_delete`, `delete_error`,
  `delete_attempts`) and retried hourly; bytes are only removed when no message, status,
  avatar, or chat still references them.

---

## 9. Security controls

| Control | Implementation | Status |
| --- | --- | --- |
| Session tokens | JWT (HS256), 7-day expiry, `token_version` invalidates tokens after password reset | VERIFIED in code |
| Per-tab sessions | Bearer token in `Authorization`; cookie fallback | VERIFIED in code |
| Socket authentication | Token + `token_version` re-verified on every handshake | VERIFIED in code |
| JWT secret | `JWT_SECRET`, ≥32 chars, distinct from media secret, startup abort in production | VERIFIED |
| Media signing | Separate `MEDIA_SECRET`, HMAC-SHA256 over file + expiry, `timingSafeEqual`, 7-day links | VERIFIED in code |
| Passwords | bcrypt cost 12 | VERIFIED in code |
| Verification/reset codes | Sign-up codes HMAC-SHA256, 10-minute expiry, 5-attempt cap; reset tokens SHA-256, 1-hour expiry | VERIFIED in code |
| Rate limiting | Login 30/15 min, reset 5/h, signup 20/h, code 20/15 min, invite 30/h, messages 90/min REST + 60/min Socket.IO, uploads 40/h per account + 120/h per IP, statuses 10/day; IPv6 keyed by /56 | VERIFIED in code |
| PIN throttling | PostgreSQL-backed sliding window, 10 per 15 min per account/chat | VERIFIED in code |
| API security headers | Helmet: CSP, HSTS, `X-Content-Type-Options`, `X-Frame-Options`, referrer policy, COOP/CORP | VERIFIED live |
| Frontend security headers | Render header rules: CSP, Permissions-Policy, Referrer-Policy, X-Frame-Options, COOP | VERIFIED live |
| Transport | HTTPS/WSS terminated by Render; API CSP includes `upgrade-insecure-requests` | VERIFIED live |
| CORS | Exact `CLIENT_URL` + `ALLOWED_ORIGINS` allowlist; localhost preview only outside production; credentials enabled | VERIFIED in code |
| Proxy trust | `TRUST_PROXY_HOPS=1` so per-IP limits see the client, not Render's proxy | VERIFIED |
| Input validation | Zod schemas across request bodies/params | VERIFIED in code |
| Upload validation | MIME allowlist, magic-byte sniff, `sharp` re-encode, EXIF strip, pixel/dimension caps, UUID keys, quotas | VERIFIED in code |
| Media privacy | Bucket accessed through presigned URLs (bucket policy not independently audited); no public directory; signed link + presigned redirect; row re-check revokes access | VERIFIED in code |
| Secret handling | Production fails closed on missing/short/shared secrets; runtime secrets come from Render env; a local ignored `backend/.env.production.local` exists for operator use and is not tracked | VERIFIED |

Not claimed:

- No end-to-end encryption; message content is stored unencrypted in PostgreSQL.
- Phone numbers are not SMS-verified; the verified email is the account anchor.
- Provider-side encryption at rest and backup encryption were not verified.
- No CSRF token mechanism was reviewed in depth; the primary API credential is a bearer
  header, not an ambient cookie. Revisit if cookie-only auth is ever made primary.
- Dependency and container scanning are not configured in CI.

---

## 10. Monitoring and logging

### 10.1 Current state

| Capability | Status | Notes |
| --- | --- | --- |
| Liveness probe | **VERIFIED** | `/healthz` returns 200 without touching PostgreSQL; Render health check and CI use it |
| Readiness probe | **VERIFIED** | `/readyz` runs `SELECT 1`; used by CI and for debugging |
| Deploy-time production probes | **VERIFIED** | CI checks health, readiness, frontend, CSP after every deploy |
| Application logs | **PARTIAL** | `console.log`/`console.error` to stdout; visible in Render dashboard logs |
| Centralized log drain | **NOT CONFIGURED** | No Logtail/Datadog/CloudWatch integration |
| Error tracking | **NOT CONFIGURED** | No Sentry/Rollbar/etc. |
| External uptime monitor | **NOT CONFIGURED** | README recommends UptimeRobot/cron-job/GitHub schedule; none verified |
| Alerting (email/SMS/pager) | **NOT CONFIGURED** | No alert route exists |
| Database performance monitoring | **NOT CONFIGURED** | The Neon console may expose metrics; no project-level monitoring or alerting was verified |
| Database connection monitoring | **NOT CONFIGURED** | No pool saturation metric or alert |
| Storage usage monitoring | **NOT CONFIGURED** | Per-account usage endpoint only; no bucket growth alert |
| Backup success monitoring | **NOT CONFIGURED** | No backups to monitor |

### 10.2 Recommended future work

1. **Optional trade-off:** if cold starts matter more than free-tier usage, point an uptime
   monitor at `https://chat-app-api-ku3h.onrender.com/healthz` every 10 minutes.
   `/healthz` deliberately avoids the database, so it does not wake Neon compute. However,
   polling more often than Render's idle spin-down threshold (about 15 minutes) can keep
   the free instance awake and consume the free plan's available instance hours. A
   10-minute interval therefore trades more instance-hour usage for fewer 30–60 s cold
   starts. If conserving free-tier usage matters more, skip the monitor and accept the
   cold start. Do **not** poll `/readyz` frequently.
2. Add error tracking that captures unhandled exceptions and 5xx responses, with the
   deployment SHA as a release tag.
3. Add a Render log drain to a searchable store with retention.
4. Configure Neon alerts for compute/transfer/storage limits and connection saturation.
5. Add a storage-usage check (bucket bytes vs. the 5 GB free allowance) and an alert.
6. Automate a weekly logical backup plus a monthly restore drill, and record the results.
7. Add dependency and secret scanning to CI if the repository becomes public or gains
   more contributors.

Do not install paid monitoring products without approval; the items above are
recommendations, not completed work.

---

## 11. Operational checklist

### Before deployment

- [ ] Changes reviewed and merged to `main`.
- [ ] CI `verify` is green for the exact commit being deployed.
- [ ] The intended full commit SHA is written down and matches `origin/main`.
- [ ] No unexpected active Render deployment on either service.
- [ ] Production secrets are still present (names only) and have not been copied into the
      repository or logs.
- [ ] If the change includes a migration: it is backward-compatible, and the operator is
      ready to run `npm run db:migrate` with the direct URL.
- [ ] If the change affects the API host or CSP: `VITE_*` and the three CSP host
      directives are updated together.

### After deployment

- [ ] API deployment is `live`.
- [ ] Frontend deployment is `live`.
- [ ] Both deployment records show the same full commit SHA.
- [ ] `/healthz` returns 200 with `status: ok`.
- [ ] `/readyz` returns 200.
- [ ] Frontend `/` returns 200 and its assets load.
- [ ] CSP header is present with `default-src 'self'` and `frame-ancestors 'none'`.
- [ ] Login works.
- [ ] Socket.IO connects (and reconnects after a restart, if tested).
- [ ] A basic message can be sent and received.
- [ ] An image upload and display works (if the change touched media).
- [ ] Deployment/incident note recorded.

### Backup and recovery

- [ ] Database backup configuration verified in the Neon console.
- [ ] Database restore procedure documented and a drill scheduled/performed.
- [ ] Media backup configuration verified (bucket copy exists outside the provider).
- [ ] Media restore procedure documented and drilled.
- [ ] Known recovery limitations recorded (media bytes are a separate restore).
- [ ] Restore point and retention window recorded from the provider, not assumed.

> Checklist items are **not** pre-completed. At audit time the backup/recovery boxes are
> unchecked except for the documented procedures; see section 12 for status.

---

## 12. Capability status summary

| Capability | Status |
| --- | --- |
| CI verification (syntax, migrations, smoke, security, build, Playwright) | VERIFIED |
| Deploy gate requires Verify success | VERIFIED |
| Pull requests verify but never deploy | VERIFIED (workflow condition) |
| Render Git auto-deploy disabled on both services | VERIFIED (live API) |
| Actions deploys the exact verified SHA | VERIFIED |
| Both services receive the same SHA | VERIFIED (workflow + live deployment records) |
| Production concurrency protection (`production-deploy`, no cancel) | VERIFIED (workflow) |
| Post-deploy `/healthz`, `/readyz`, frontend, CSP checks | VERIFIED |
| Push-to-main deployment | VERIFIED (Stage 4) |
| Verify failure blocks deploy (backend drill) | VERIFIED (Stage 5A, run `41607747561`) |
| Playwright failure blocks deploy | VERIFIED (Stage 5B, run `41613535082`) |
| Manual `workflow_dispatch` deployment | DOCUMENTED BUT NOT TESTED |
| Break-glass direct Render deploy | DOCUMENTED BUT NOT TESTED |
| Rollback procedure | DOCUMENTED BUT NOT TESTED |
| Secret rotation | DOCUMENTED BUT NOT TESTED |
| Database provider PITR/branch restore | NOT VERIFIED |
| Application-scheduled database backups | NOT CONFIGURED |
| Database restore drill (current) | OUTSTANDING (only a historical 71-row `db:copy` drill exists) |
| Media backup (scheduled/mirrored) | NOT CONFIGURED |
| Media restore drill | OUTSTANDING (never performed; prior drill excluded bytes) |
| External uptime monitoring | NOT CONFIGURED |
| Error tracking | NOT CONFIGURED |
| Centralized logging | NOT CONFIGURED |
| Database performance/connection monitoring | NOT CONFIGURED |
| Storage usage monitoring/alerting | NOT CONFIGURED |
| Automated backup verification | NOT CONFIGURED |

---

## 13. Known risks and outstanding work

| Risk | Impact | Mitigation / next step |
| --- | --- | --- |
| No scheduled database backup verified | Data loss beyond Neon's provider window | Confirm Neon restore window; add a scheduled logical backup and record retention |
| No media backup or restore drill | Permanent loss of uploaded images/videos | Schedule `aws s3 sync` to a second provider; run and record a restore drill |
| DB restore and media restore are unpaired | Restored DB can reference missing bytes | Always restore both to matching points; run `media:verify` |
| Production migrations are manual | Deploy can run against an old schema | Apply migrations deliberately; make them backward-compatible; verify `db:status` |
| Migrations are forward-only | A code rollback may not match the schema | Plan rollback compatibility; prefer forward fixes |
| No external uptime/error/alerting | Outages and 5xx spikes can go unnoticed | Add uptime monitor on `/healthz`, error tracking, log drain, provider alerts |
| Single API instance, in-memory presence/calls | Restart drops sockets and calls; no horizontal scale | Accept for current scale; add a Socket.IO adapter before scaling out |
| No graceful `SIGTERM` drain | Deploys/restarts drop connections abruptly | Documented behavior; frontend reconnects automatically |
| Free-tier cold starts and quotas | 30–60 s first request; Neon suspension when transfer/compute limits hit | Keep `/healthz` warm; monitor usage; upgrade if needed |
| Frontend CSP lives in Render header rules, not Git | Drift; API host change breaks media/socket | Keep section 5.2 checklist; re-verify headers after host changes |
| `VITE_*` are build-time | Stale API host baked into the bundle | Rebuild/redeploy the static site after changing them |
| Email depends on Brevo quota/deliverability | Sign-up/recovery can fail at the daily cap | Monitor Brevo; Resend fallback exists in code but is not configured |
| No SMS phone verification | Someone can claim a phone number they do not own | Known product limitation; verified email is the anchor |
| Repo contains local `backend/uploads` and backup copies | Not production evidence; clutter and accidental commit risk | Archive outside the repo; do not treat as production media |
| Local ignored `backend/.env.production.local` | Live credentials on the operator machine; accidental commit or exfiltration risk | Keep it ignored, restrict access, never paste values, rotate credentials if exposed |
| Service ID in the brief (`…qs1`) is 404 | Following it would fail deploys | Use the verified `…qs0`; the workflow already does |
| Stage 5B Playwright artifact retention | Artifact remains until 2026-11-10 | Harmless; delete after retention if permitted |
| PR #3 closure unverified | Possible stale open PR | Verify/close when a token with PR access is available |

---

## 14. Audit record

**What was verified on 2026-11-03:**

- Repository: branch `main`, clean working tree, `HEAD` `f1dc9a3…`, no uncommitted changes
  before this documentation work.
- Workflow triggers, jobs, gate condition, concurrency, steps, service IDs, probes, and
  CSP assertions were read from `.github/workflows/ci.yml`.
- Render service metadata (name, type, branch, root, build/start/publish, plan, region,
  health path, `autoDeployTrigger`) was read from the Render API for both services.
- Render environment variable **names** and safe non-secret values were read; secrets were
  only checked for presence.
- Render header rules for the static site were read; API and frontend headers were probed
  live.
- Deployment history for both services showed both `live` at `f1dc9a3…`.
- GitHub Actions repository secrets showed exactly one secret, `RENDER_API_KEY`, updated
  2026-11-03T05:02:14Z. The variables endpoint returned HTTP 403 with the audit token.
- Production probes: `/healthz` 200, `/readyz` 200, frontend `/` 200.
- Repository scripts, migrations, storage adapters, media pipeline, CSP config, probes,
  env examples, backup/restore scripts, and docs were inspected.
- A local Git-ignored `backend/.env.production.local` was used for read-only Render/GitHub
  API checks; its values were never printed or committed.

**What was not verified (do not assume):**

- Neon backup retention/PITR configuration and restore behavior.
- Any scheduled database or media backup.
- A current restore drill (database or media).
- Manual `workflow_dispatch` deployment and break-glass deployment.
- Secret rotation.
- Production schema revision (no production DB query was made).
- Error tracking, uptime monitoring, log drain, or alerts.
- Provider-side encryption at rest.
- Pull request #3 status (token lacked PR read/update permission).

**Production changes during this audit:** none. No deploy, no environment-variable edit, no
Render setting change, no database write, and no secret was printed or committed.

---

## Appendix — commands quick reference

```powershell
# Repository / CI
git rev-parse HEAD
git log --oneline -5
gh run list --workflow=ci.yml --limit 5
gh run view <run-id> --log

# Production probes (safe, read-only)
curl.exe -sS -o NUL -w "%{http_code}`n" https://chat-app-api-ku3h.onrender.com/healthz
curl.exe -sS -o NUL -w "%{http_code}`n" https://chat-app-api-ku3h.onrender.com/readyz
curl.exe -sS -o NUL -w "%{http_code}`n" https://chat-app-web-ywez.onrender.com/

# Schema (from backend/, direct URL in the environment)
npm run db:status
npm run db:migrate

# Media consistency (read-only checks plus sampled reads)
npm run media:verify
npm run media:verify -- --sample=25

# Storage round-trip (writes and deletes one tiny object)
npm run storage:test

# Row copy / no-pg_dump restore path
npm run db:copy -- --dry-run
npm run db:copy

# Media backfill (local uploads -> configured driver)
npm run media:backfill -- --dry-run
npm run media:backfill
```

Do not run `db:copy --truncate`, `media:backfill` without `--dry-run`, or any restore
command against production without an explicit change approval and a verified recovery
point.
