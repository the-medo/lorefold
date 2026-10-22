# Local worktree development

This is working database/environment tooling for a repository that does not yet
contain the application. It adapts SWUBASE's isolation and ownership conventions,
without its production dump restore, Crossfire, remote access, or IDE integration.

## Requirements and quick start

Linux or WSL, Bash, Python 3.10+, Git, and a running local Docker Engine are required.
The Docker user must be able to create containers and volumes. PostgreSQL 16 runs
in Docker; neither a host PostgreSQL installation nor Bun/Node is needed yet.

From the checkout or linked Git worktree:

```bash
scripts/worktree-dev/bootstrap-worktree.sh
scripts/worktree-dev/lorefold-worktree-dev status
scripts/worktree-dev/lorefold-worktree-dev psql -- -c 'SELECT current_database();'
```

Bootstrap calls `setup`, which starts a new empty database or reuses the existing
one. Docker pulls `postgres:16-alpine` if needed. No production data or credentials
are downloaded. No application dependencies, schema migrations, R2 providers,
mock AI implementation, API, frontend, or import worker exist at this stage.

## Lifecycle

| Command | Behavior |
| --- | --- |
| `setup` | Create/reuse PostgreSQL, wait for an authenticated connection, generate env files |
| `up` | Currently the same as `setup`; does not start an unimplemented app |
| `status [--json]` | Report the current worktree's resources and reserved ports, without secrets |
| `psql -- [arguments]` | Use the container's PostgreSQL client against this worktree's DB |
| `run -- command ...` | Run a foreground command with development config and enforced worktree overrides |
| `logs` | Last 100 lines of this database's logs |
| `down` | Stop PostgreSQL and retain its data, credentials, and port reservations |
| `down --purge-data` | Delete this worktree's PostgreSQL container/volume, generated env, and reservations |
| `prune` | Preview this repository's resources whose worktree directories no longer exist |
| `prune --yes` | Remove the previewed stale resources after validating ownership again |

`run` is a foreground launcher, not a background process supervisor. Stop your
commands with Ctrl-C before `down`. Later app scaffolding must explicitly add
application lifecycle and health checks; the current command never claims the
reserved frontend/API URLs are live.

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
| Future backend | 13000–13099 |
| Future Vite frontend | 15173–15272 |

The allocator avoids other Lorefold reservations and current listeners. A
reservation is not an OS-level socket lock: a different program can claim a
stopped service's port. The database launcher refuses to change ports or stop
that program; resolve the conflict and retry. Future app launchers must bind
the assigned port strictly rather than silently finding another one.

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
| `.env` | Developer-owned, ignored; copied from the template only when absent |
| `.env.worktree` | Generated, ignored; DB connection, backend port, origins, auth secret, cookie prefix |
| `frontend/.env.worktree` | Generated, ignored; public Vite port/proxy settings only |
| `.lorefold/postgres.env` | Generated, ignored; Docker database initialization credentials |
| `.lorefold/storage/` | Ignored worktree-local fixture storage, reserved for future providers |

Do not copy generated files between worktrees. The launcher never reads another
project's `.env`, changes shell profiles, or silently imports production settings.
An existing `.env` is preserved byte-for-byte.

Use `run` when invoking database migrations, future app commands, or other code:

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

Future application integration must honor:

- Backend `HOST`/`PORT` and frontend `VITE_HOST`/`VITE_PORT` (strict ports).
- Vite's `/api` proxy using `VITE_API_PROXY_TARGET`, keeping requests same-origin.
- `DATABASE_URL` in Drizzle and the worker.
- `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, and `AUTH_COOKIE_PREFIX`. Cookies are
  host-scoped rather than port-scoped, so the prefix must be configured in Better Auth.
- Development `R2_KEY_PREFIX` and `LOREFOLD_LOCAL_STORAGE_DIR` for source isolation.
- `IMPORT_CONCURRENCY=1` for the initial worker.

The generated auth origin is `http://localhost:<frontend port>`. When social login
is implemented, register that worktree's exact provider callback URL; generated
credentials/origins do not constitute a working OAuth integration.

`LOREFOLD_STORAGE_MODE=local` and `LOREFOLD_AI_MODE=mock` are future provider
contracts, not implemented providers or a sandbox. To exercise real services
later, use reviewed development credentials, a private development R2 bucket,
and the worktree key prefix. Treat each live AI request as potentially billable.
Never expose secrets through `VITE_*` variables or commit user ebooks.

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
