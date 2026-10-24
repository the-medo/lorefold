# Local worktree development

This tooling isolates the application's local PostgreSQL database and environment.
It adapts SWUBase's isolation, ownership, and private Tailscale access conventions,
without its production dump restore, Crossfire, or IDE integration.

## Requirements and quick start

Linux or WSL, Bash, Python 3.10+, Git, and a running local Docker Engine are required.
The Docker user must be able to create containers and volumes. PostgreSQL 16 runs
in Docker; no host PostgreSQL installation is needed. The app requires Node.js 24+
and npm; database/environment commands only require Python and Docker. Background
`up` requires a systemd user manager; private remote access also requires Tailscale.

From the checkout or linked Git worktree:

```bash
scripts/worktree-dev/bootstrap-worktree.sh
scripts/worktree-dev/lorefold-worktree-dev status
scripts/worktree-dev/lorefold-worktree-dev psql -- -c 'SELECT current_database();'
```

Bootstrap calls `setup`, which starts a new empty database or reuses the existing
one. Docker pulls `postgres:16-alpine` if needed. No production data or credentials
are downloaded. To prepare and start the application, continue with:

```bash
npm ci
scripts/worktree-dev/lorefold-worktree-dev run -- npm run db:migrate
scripts/worktree-dev/lorefold-worktree-dev run -- npm run demo:setup
scripts/worktree-dev/lorefold-worktree-dev up
```

Use the **Browser URL** in `status` to match the auth origin. The generated
demo credentials are in ignored `.lorefold/demo-account.json`; do not copy or commit
them. `up` verifies the page and `/api/health`, which checks PostgreSQL connectivity.

## Stable access from another computer

Configure this once per development machine, using its DNS name from
`tailscale status --json` (both computers must have Tailscale access):

```bash
scripts/worktree-dev/lorefold-worktree-dev configure-access \
  --origin-template 'https://steamdeck.tail73a93e.ts.net:{frontend_port}' \
  --tailscale-serve
```

The profile lives at `${XDG_CONFIG_HOME:-~/.config}/lorefold/worktree-dev/access.json`.
Every new worktree inherits it and substitutes its reserved frontend port. Existing
worktrees adopt changes on `down` then `up`; active services retain their current
origin. `up` starts a session-independent systemd user service, checks local health,
and creates only the matching private Tailscale Serve route. It also checks health
through HTTPS. SWUBase and other apps' routes remain untouched. Funnel is not used.

The same browser origin drives Better Auth, API origin checks, and Vite's hostname
allowlist. No changing forwarded ports or per-worktree auth edits are required.
API and database listeners remain on loopback. Each worktree has its own cookie
prefix because browser cookies are scoped to hosts, not ports.

Without a profile the default is `http://localhost:{frontend_port}`. To restore it:

```bash
scripts/worktree-dev/lorefold-worktree-dev configure-access \
  --origin-template 'http://localhost:{frontend_port}'
```

The background service survives terminal/chat closure and restarts on failure.
The host and user service manager must remain running; run `up` after a reboot.
Logs are available with `journalctl --user -u <service_unit> -n 100`, using the
`service_unit` reported by `status --json`. Node must be on PATH when invoking `up`;
on the Steam Machine it is installed under `/home/medo/dev/nodejs/bin`.

## Lifecycle

| Command | Behavior |
| --- | --- |
| `setup` | Create/reuse PostgreSQL, wait for an authenticated connection, generate env files |
| `up` | Start database, background app, and configured private route; wait for health |
| `configure-access --origin-template ... [--tailscale-serve]` | Save the machine default for new/stopped worktrees |
| `configure-google --from-env .env` | Save only this app's development Google credentials for new `.env` files |
| `status [--json]` | Report resources, browser URL, HTTP health, and background service state, without secrets |
| `psql -- [arguments]` | Use the container's PostgreSQL client against this worktree's DB |
| `run -- command ...` | Run a foreground command with development config and enforced worktree overrides |
| `logs` | Last 100 lines of this database's logs |
| `down` | Stop the app, remove its exact private route, stop PostgreSQL; retain data and reservations |
| `down --purge-data` | Delete this worktree's PostgreSQL container/volume, generated env, and reservations |
| `prune` | Preview this repository's resources whose worktree directories no longer exist |
| `prune --yes` | Remove the previewed stale resources after validating ownership again |

`run -- npm run dev` remains a foreground debugging alternative; stop it with
Ctrl-C before `up` or `down`. `npm run dev` supervises API and frontend children,
terminates both when either exits, and refuses occupied ports. The background
service additionally stops every process in its systemd control group on `down`.
`status` probes the local API; `up` also verifies the configured private URL.

`down --purge-data` retains the developer-authored `.env` and any local fixture
files under `.lorefold/storage/`. It deliberately destroys the local database.
Inspect `status` first. Cleanup checks every target's ownership labels before
changing any resource and never runs Docker-wide prune commands.

## Isolation and state

Identity is based on the canonical checkout path plus the Git common directory,
not the branch name. A branch switch preserves the database. Linked worktrees
and separate clones get different identities, containers, volumes, credentials,
auth cookie prefixes, storage prefixes, and port reservations.
The launcher targets the checkout containing its script, even if called using
an absolute path while the terminal is in a different repository.

Resources are labelled with `com.lorefold.dev.managed`, `.repo`, `.worktree`, and
`.path`. The database binds to `127.0.0.1` only and has initial limits of one CPU
and 512 MiB. This local limit is not a production capacity recommendation.

Reservations are coordinated under a per-user lock in:

```text
${XDG_STATE_HOME:-~/.local/state}/lorefold/worktrees/
```

`LOREFOLD_DEV_REGISTRY` can select a different directory for tests. Use one
registry consistently for normal development; separate registries cannot
coordinate reserved application ports. Port ranges are:

| Service | Loopback port range |
| --- | --- |
| PostgreSQL | 15432–15531 |
| Backend | 13000–13099 |
| Vite frontend | 15173–15272 |

The allocator avoids other Lorefold reservations and current listeners. A
reservation is not an OS-level socket lock: a different program can claim a
stopped service's port. The database launcher refuses to change ports or stop
that program; resolve the conflict and retry. The app binds its assigned ports
strictly rather than silently finding another one.

State is saved in the registry and `.lorefold/state.json`, with restrictive file
permissions. Either copy can recover the other during setup. If both are lost
while resources still exist, setup refuses to invent replacement credentials.
If the copies disagree, inspect and recover the correct one instead of deleting
Docker data. Moving a checkout changes its identity; purge its development DB
before moving, or deliberately recover/export its data first.

## Environment files

| File | Ownership |
| --- | --- |
| `.env.example` | Tracked, safe template; no real credentials |
| `.env` | Developer-owned, ignored; created from the template and optional shared Google profile only when absent |
| `.env.worktree` | Generated, ignored; DB connection, backend port, origins, auth secret, cookie prefix |
| `frontend/.env.worktree` | Generated, ignored; public Vite port/proxy settings only |
| `.lorefold/postgres.env` | Generated, ignored; Docker database initialization credentials |
| `.lorefold/storage/` | Ignored worktree-local storage; private original uploads live in `uploads/` |

Do not copy generated files between worktrees. The launcher never reads another
project's `.env`, changes shell profiles, or silently imports production settings.
An existing `.env` is preserved byte-for-byte.

Use `run` when invoking database migrations, app commands, or other code:

```bash
scripts/worktree-dev/lorefold-worktree-dev run -- python3 -c \
  'import os; print(os.environ["LOREFOLD_WORKTREE_ID"])'
```

The merge order is inherited environment → root `.env` → generated worktree
overrides → generated frontend settings. Worktree DB/auth/port settings win over
both the shell and `.env`; edited generated env files cannot override them. Values
are parsed as data: shell substitution and variable expansion never execute.
Supported dotenv syntax is `KEY=value`, optional `export`, single/double quotes,
and comments; multiline values are not supported.

The application honors:

- Backend `HOST`/`PORT` and frontend `VITE_HOST`/`VITE_PORT` (strict ports).
- Vite's `/api` proxy using `VITE_API_PROXY_TARGET`, keeping requests same-origin.
- `DATABASE_URL` in Drizzle. The future worker must use it too.
- `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, and `AUTH_COOKIE_PREFIX`. Cookies are
  host-scoped rather than port-scoped, so the prefix must be configured in Better Auth.

Future providers must honor development `R2_KEY_PREFIX` and
`LOREFOLD_LOCAL_STORAGE_DIR`; the initial worker must honor `IMPORT_CONCURRENCY=1`.

The generated auth origin comes from the worktree's saved access profile. When social login
is implemented, register that worktree's exact provider callback URL; generated
credentials/origins do not constitute a working OAuth integration.

For a temporary tunnel using the default HTTP loopback profile, put its exact URL
in the worktree's developer-owned `.env`, for example
`LOREFOLD_DEV_BROWSER_ORIGIN=http://localhost:60204`, then restart the app through
`run -- npm run dev`. Prefer the stable private HTTPS profile for regular remote
work. Secure cookies from an HTTPS profile are not an HTTP tunnel fallback.
The application adds only that explicit HTTP loopback origin
to both Better Auth and API mutation checks. The generated origin, bind ports,
cookie prefix, and database isolation remain controlled by the launcher. This
option is rejected outside a development worktree. Do not edit generated env files.

`LOREFOLD_STORAGE_MODE=local` enables private original file uploads in development.
`LOREFOLD_AI_MODE=mock` remains a future provider contract. To exercise real services
later, use reviewed development credentials, a private development R2 bucket,
and the worktree key prefix. Treat each live AI request as potentially billable.
Never expose secrets through `VITE_*` variables or commit user ebooks.

## Shared Google development credentials

Lorefold worktrees can reuse one development Google Web OAuth client. Save only
its two credentials from an already configured Lorefold `.env`:

```bash
scripts/worktree-dev/lorefold-worktree-dev configure-google --from-env .env
```

The command writes `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to
`${XDG_CONFIG_HOME:-~/.config}/lorefold/worktree-dev/google.env` with mode `0600`.
Other values in the source file are ignored, and credentials are never printed.
The profile stays outside Git and is separate from `access.json`.

When bootstrap/setup creates a new root `.env`, it inserts this credential pair
into the safe template. If there is no profile, the template is unchanged.
An existing `.env` stays byte-for-byte unchanged, including blank Google values.
Generated database/frontend environment files do not receive the OAuth credentials.
A malformed or incomplete profile stops creation with a secret-free error.

To configure this on the development host from the main checkout's credentials:

```bash
scripts/worktree-dev/lorefold-worktree-dev configure-google \\
  --from-env /home/medo/dev/lorefold/.env
```

Every worktree still needs the Google sign-in implementation, its own invited user,
and its exact Browser URL plus `/api/auth/callback/google` registered as a redirect
URI on that client. Port allocation can choose any available port in 15173–15272;
pre-registering only the next few numbers does not cover every new worktree.

Changing the shared profile affects newly created `.env` files only. For rotation,
update existing worktrees' two Google values explicitly and restart with `down`
then `up`. Never share generated DB passwords, session secrets, cookie prefixes,
other providers' credentials, or production configuration through this profile.

## Working in another worktree

```bash
git worktree add ../lorefold-example -b example
cd ../lorefold-example
scripts/worktree-dev/bootstrap-worktree.sh
```

Use a separate `.env` there, adding only the development integrations needed.
Before removing the worktree, inspect `status` and deliberately purge its local
database if no longer needed. If the directory was removed first, `prune` previews
its orphaned resources. Existing directories are never auto-classified as stale.

## Verification

Fast checks (no Docker or network):

```bash
bash -n scripts/worktree-dev/bootstrap-worktree.sh \
  scripts/worktree-dev/lorefold-worktree-dev \
  scripts/worktree-dev/test-concurrent-worktrees.sh
python3 -m unittest discover -s scripts/worktree-dev/tests -v
```

After changing lifecycle, ownership, allocation, or env precedence:

```bash
scripts/worktree-dev/test-concurrent-worktrees.sh
```

The integration test creates two temporary detached worktrees, provisions their
databases concurrently, verifies data/env isolation and restart persistence,
and tests refusal to touch conflicting resources. It also exercises stale-resource
cleanup. It uses an isolated registry and empty test databases, never reads the
developer's `.env`, and purges only its own labelled test resources on exit.
It requires a local Docker daemon and the `postgres:16-alpine` image already present.
