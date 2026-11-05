# Deploying Lorefold on Coolify

This guide targets Coolify **v4.0.0-beta.431**. The repository supplies a
multi-stage Dockerfile with `web` and `worker` targets. Both run compiled Node 24
code as the unprivileged `node` user, with production npm dependencies only.
Python and Poppler are included for EPUB and text-based PDF extraction.

The runtime services are a dedicated PostgreSQL database, one web/API container,
and one import worker. Hono serves the built React frontend and `/api` on port
3000. No Vite development server, Redis, or separate frontend container is needed.
Production files live in private R2; do not copy development environment files,
databases, demo accounts, or local upload directories to the server.

## Resource budget

For the initial personal installation on the existing 4-vCPU / 16-GB server:

| Resource | Number of CPUs | Maximum Memory Limit |
| --- | --- | --- |
| PostgreSQL | `0.5` | `512m` |
| Web/API | `0.5` | `512m` |
| Worker | `0.5` | `1g` |

Set these under each resource's **Resource Limits**, save, and restart/redeploy
after changes. Leave CPU sets empty. These are starting caps, not reservations
or measured minimum requirements. Keep one web instance and `IMPORT_CONCURRENCY=1`.
Observe memory, restarts, import completion, and response times before lowering
limits. Rolling web deployments briefly run both the old and new container.

Builds also use CPU, memory, and disk on the deployment server. Runtime caps do
not establish a total build budget. For stronger isolation, build on a separate
machine/CI, push versioned images to a private registry, and create Docker Image
resources in Coolify. The two targets share their large runtime layers. The
Git/Dockerfile route below is the simplest first deployment; deploy sequentially.

## 1. PostgreSQL

Inside **Lorefold → Production → + New**, choose PostgreSQL on the intended
application server/destination. Use `postgres:16-alpine`, resource name
`lorefold-db`, username `lorefold`, initial database `lorefold`, and a fresh
generated password. Keep public access disabled and host port mappings empty.
Apply the limits above and start the database.

Coolify provisions a persistent volume. Copy its **Postgres URL (internal)**
directly into the applications' runtime `DATABASE_URL`; the URL contains a
password and must not go into Git, chat, build arguments, or frontend variables.
Select the same server and destination network for both applications. The
database hostname must be the internal hostname from Coolify, not `localhost`.

## 2. Web application

The selected Git branch must contain this Dockerfile. Use `main` after the
deployment changes are merged, or their exact review branch while testing them.

In **Lorefold → Production → + New**, choose **Public Repository** for
`https://github.com/the-medo/lorefold`, or use an existing GitHub App connection.
Select the same server/destination as PostgreSQL, then configure:

| Setting | Value |
| --- | --- |
| Name | `lorefold-web` |
| Build Pack | `Dockerfile` |
| Base Directory | `/` |
| Dockerfile Location | `/Dockerfile` |
| Docker Build Stage Target | `web` |
| Ports Exposes | `3000` |
| Ports Mappings | Empty |
| Pre/post-deployment commands | Empty |

The Dockerfile starts by applying the packaged Drizzle migrations, then starts
the web server only if they succeed. Do not put migrations in a build command or
run them from the worker. A Coolify pre-deployment command runs in the **existing**
container, so it cannot bootstrap the first deployment or reliably use the new
release's migration files. Keep future migrations compatible with the previous
web version during rolling updates. Back up the database before schema changes;
rolling back an image does not undo migrations.

For a temporary browser URL, use **Generate Domain** in General. Use an HTTPS URL
with a valid certificate and set both origin variables below to exactly that
browser origin (no trailing path or internal `:3000` suffix). Coolify's proxy
routes to the exposed internal port. The Dockerfile binds `0.0.0.0` inside the
container; no host port is published. Do not enter the final custom domain until
its DNS is ready. If temporary HTTPS is unavailable, leave Domains empty and
verify internal health until the custom domain is configured; do not sign in over
public HTTP.

Add these **runtime-only** environment variables, substituting your own values:

```dotenv
DATABASE_URL=<Postgres URL (internal) from lorefold-db>
APP_ORIGIN=https://<temporary-HTTPS-hostname>
BETTER_AUTH_URL=https://<temporary-HTTPS-hostname>
BETTER_AUTH_SECRET=<new random secret, at least 32 characters>
AUTH_COOKIE_PREFIX=lorefold-production
```

Generate the auth secret in a private terminal or password manager, for example
with `openssl rand -hex 32`, then store it directly in Coolify. Preserve it across
deployments. Runtime secrets must not have **Build Variable** enabled. The image
already sets `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=3000`, mock analysis,
private R2 storage mode, and disables personal ChatGPT connections.

Apply the web resource limits. Initially disable **Auto Deploy** under Advanced
so deployments remain deliberate while setup is in progress. Click **Deploy**.
Logs should show `Database migrations applied.` followed by the listening message.
The Dockerfile health check calls `/api/health`, which checks PostgreSQL.

At this stage the sign-in page and database health can work without R2, but
uploads cannot. Do not treat the import feature as ready until storage and the
worker are configured and verified.

## 3. Sign-in

For Google, use an OAuth Web client approved for this hosted installation. Set
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` together as web runtime variables.
Register the exact current HTTPS origin and this redirect URI in Google:

```text
https://<current-hostname>/api/auth/callback/google
```

Redeploy the web app. A verified Google sign-in creates an empty private account
automatically. Existing accounts with the same email retain their library.
Do not copy the worktree's development credential profile into production.

Alternatively, open the web container's interactive **Terminal** and run:

```bash
node dist/server/scripts/create-user.js
```

This privately provisions an email/password account with a hidden password prompt.
Public password signup is disabled. Do not run the development demo setup in
production. Password recovery/email delivery are not implemented.

Verify a real sign-in, refresh the page, create a universe, restart the web app,
and confirm the session and universe remain available. Check `/api/health` through
the same HTTPS origin used to sign in.

## 4. Private R2 storage

Cloudflare R2 is independent of the final DNS change. Create a private bucket for
this installation and credentials limited to object read/write in that bucket.
Keep public access disabled. Set these runtime variables on **both** web and worker:

```dotenv
LOREFOLD_STORAGE_MODE=r2
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_BUCKET=<private-bucket-name>
R2_ACCESS_KEY_ID=<bucket-scoped-access-key>
R2_SECRET_ACCESS_KEY=<bucket-scoped-secret>
R2_KEY_PREFIX=lorefold/production
LOREFOLD_AI_MODE=mock
LOREFOLD_IMPORT_LIVE=0
```

Use the endpoint actually shown by R2, including its jurisdiction suffix if one
applies. Both containers must use the same bucket and prefix. No persistent app
volume is required: PostgreSQL stores application state and R2 stores original
files and extracted chapter text. Never use the local development storage adapter
in production. Redeploy the web app after adding the storage variables.

## 5. Worker

Create a second Git/Dockerfile application from the same branch and destination:

| Setting | Value |
| --- | --- |
| Name | `lorefold-worker` |
| Build Pack | `Dockerfile` |
| Base Directory | `/` |
| Dockerfile Location | `/Dockerfile` |
| Docker Build Stage Target | `worker` |
| Domains | Empty; remove any automatically generated domain |
| Ports Mappings | Empty |
| Healthcheck | Keep the dashboard HTTP check disabled; the image supplies a database check |
| Pre/post-deployment commands | Empty |

If the UI requires **Ports Exposes**, its default `3000` can remain; no process
listens there, and without a domain or host mapping it does not publish a service.
Set runtime `DATABASE_URL`, the storage/analysis variables from step 4, and
`IMPORT_CONCURRENCY=1`. The worker does not need web auth secrets or Google keys.
Apply its resource limits and deploy **after the web deployment has migrated the
database**. Keep Auto Deploy off during setup.

The worker image runs a read-only PostgreSQL connectivity check every 30 seconds,
with bounded connection/query timeouts. It needs no domain, HTTP port, Google
credentials, or auth secrets. This checks database access, not import completion
or R2/provider access; verify an actual import below.

Coolify beta.431 scans the entire multi-stage Dockerfile for a health check,
including stages that were not built. A worker image without its own check can
therefore fail with `map has no entry for key "Health"`, even when the dashboard
check is disabled. Both targets now include their own checks with identical timing
options (Coolify parses the first check). If you hit this error with an older
commit, deploy the latest `main` with build target `worker`; changing the dashboard
toggle alone does not fix it. `Custom healthcheck found` is expected with these
images, followed by a healthy result when PostgreSQL is reachable.

Upload a small synthetic TXT or EPUB through the website. Confirm that the worker
finishes, original download works, progress can be saved, and chapter views follow
that progress. Mock output is explicitly labelled and does not call an AI model.
Stop/restart the worker and verify it resumes durable work. A running worker
container alone does not prove imports work; inspect job progress and runtime logs.

Real analysis is a separate opt-in: configure Cloudflare AI Gateway/provider access
and set `LOREFOLD_AI_MODE=gateway`, `LOREFOLD_IMPORT_LIVE=1`,
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_GATEWAY_ID`, and `CLOUDFLARE_API_TOKEN`.
The web app records provider mode on new jobs and the worker makes the calls, so
configure both consistently. Existing mock jobs retain their original mode.
Personal ChatGPT-plan connections remain disabled in production. See
[book imports](book-imports.md) for recovery and provider details.

Website ChatGPT credentials can be persisted in PostgreSQL without a shared app
volume: set `LOREFOLD_CHATGPT_STORAGE=database` and the same dedicated
`LOREFOLD_CHATGPT_ENCRYPTION_KEY` (64 hexadecimal characters) as runtime-only
variables on web and worker. Apply the packaged migrations first. Keep the key
outside PostgreSQL and preserve it across deployments. This configures storage
only; it does not yet enable the owner-only production OAuth/provisioning flow or
switch imports from mock. See [encrypted connection storage](chatgpt-connections.md#encrypted-postgresql-storage).

## 6. Final domain and operations

When Cloudflare DNS is ready, set the web domain to
`https://lorefold.the-medo.com`, update both `APP_ORIGIN` and `BETTER_AUTH_URL` to
that same origin, and register Google's final callback:

```text
https://lorefold.the-medo.com/api/auth/callback/google
```

Provision/verify the origin certificate and, if enabling Cloudflare's proxy, use
Full (strict) TLS. Redeploy and verify health, sign-in, refresh/session persistence,
an authenticated write, and an upload on the final origin. Sign in again after
switching hostnames; cookies do not move between hosts. Remove the temporary
domain/callback when it is no longer needed.

Schedule private PostgreSQL backups outside the VPS using Coolify, and verify a
restore. R2 objects do not replace the database backup. Keep only the web service
public; the database and worker use internal networking. Review resource usage
during an import as well as at idle.

## 7. Automatic deployments from main

After merging the deployment files, update **both** `lorefold-web` and
`lorefold-worker` under **Source**: set **Branch** to `main` and **Commit SHA** to
`HEAD`, then save. Preserve their respective `web` and `worker` Docker build
stage targets. Deploy the web application once, wait for it to become healthy,
then deploy the worker so the initial switch uses the current database schema.

For the public-repository setup in this guide, configure one GitHub push webhook:

1. In both applications, enable **Advanced → Auto Deploy**. Keep preview
   deployments disabled unless they are deliberately configured separately.
2. Open **Webhooks → Manual Git Webhooks** on each application. Set the same
   newly generated, private **GitHub Webhook Secret** on both and save. Copy the
   **GitHub** URL from that section; the **Deploy Webhook (auth required)** field
   is a different API endpoint and is not the GitHub payload URL.
3. Open the [repository's webhook settings](https://github.com/the-medo/lorefold/settings/hooks)
   and select **Add webhook**. Paste the copied URL into **Payload URL**, choose
   `application/json`, and enter the matching secret. Keep SSL verification and
   **Active** enabled, and select **Just the push event**.
4. On the next push or merge to `main`, inspect the webhook's **Recent Deliveries**
   and both applications' deployment logs. Verify that both deploy the new commit
   and that the web health check and a small synthetic import succeed. The GitHub
   webhook's initial ping alone does not verify deployment.

Coolify beta.431 matches the repository and branch, validates each application's
webhook secret, and queues deployments for matching applications with Auto Deploy
enabled. One webhook can therefore update both Lorefold applications. The webhook
secret belongs in Coolify and GitHub settings, never in this repository.

If the applications instead use an installed GitHub App source, its integration
handles webhook delivery; enable Auto Deploy and select `main` on both without
adding a duplicate manual webhook. Automatic deployments do not wait for CI
checks, so run the required checks before merging into `main`.

## Local verification

Build both images without production credentials:

```bash
docker build --target web -t lorefold:web .
docker build --target worker -t lorefold:worker .
```

Use only the isolated worktree database and synthetic fixtures for local container
smoke tests. Verify compiled migrations, static assets, sign-in, session and write
persistence across restart, non-root execution, the health check, and Python/PDF
tools. Source `.env` files and development credentials are excluded from the Docker
context by an allowlist and are never copied into the runtime image.

## References

- [Cloudflare R2 credentials](https://developers.cloudflare.com/r2/api/tokens/)
- [Cloudflare Full (strict) TLS](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)
- [Coolify Dockerfile builds](https://coolify.io/docs/applications/builds/dockerfile)
- [Coolify health checks](https://coolify.io/docs/applications/configuration/health-checks)
- [Health check detection in beta.431](https://github.com/coollabsio/coolify/blob/v4.0.0-beta.431/app/Models/Application.php#L1601-L1646)
- [Coolify PostgreSQL](https://coolify.io/docs/databases/postgresql)
- [Resource limits in beta.431](https://github.com/coollabsio/coolify/blob/v4.0.0-beta.431/resources/views/livewire/project/shared/resource-limits.blade.php)
- [General settings in beta.431](https://github.com/coollabsio/coolify/blob/v4.0.0-beta.431/resources/views/livewire/project/application/general.blade.php)
- [Manual Git webhooks](https://coolify.io/docs/applications/deployments/manual-webhooks)
- [GitHub webhook handling in beta.431](https://github.com/coollabsio/coolify/blob/v4.0.0-beta.431/app/Http/Controllers/Webhook/Github.php)
