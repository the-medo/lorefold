# Personal ChatGPT account connections

The website login (Google or provisioned email/password) identifies a Lorefold
reader. ChatGPT authorization separately grants permission to use a ChatGPT plan.
User settings → **AI & connections** manages the latter and saves model preferences.
Each reader starts with Astra (`gpt-6-astra`) at `high` effort and can choose Sol 6.1
or Astra at `medium`, `high`, or `xhigh`. The preference persists in PostgreSQL.
New book imports use the saved preference and the installation's configured
analysis provider. Saving a preference itself does not call a model.

The model selector includes the six-configuration comparison measured on 26 October
2026: average time per chapter, output tokens (with reasoning included), chapter
validation passes, and exact-quote counts. The selected row follows the draft
selection; saving the default still requires the Save button. The shared input
total is 35,128 tokens per configuration across the same three chapters. Ratios
compare output tokens with Astra high, not subscription allowance or prices.
Only anonymous aggregate metrics are included in the frontend snapshot
`frontend/src/AnalysisComparison.tsx`; private book text and raw results remain local.

## Personal development setup

OpenAI’s [open-source flow](https://developers.openai.com/siwc/token-sharing-open-source)
supports local/personal installations and a loopback OAuth callback. Paid or
remotely hosted products require separate access through OpenAI’s interest form.
OpenAI also documents a [personal self-hosted VM flow](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms).
This integration is disabled by default and cannot be enabled with
`NODE_ENV=production`. It is not a hosted subscription integration.

Add these server-only settings to the worktree’s own `.env`:

```dotenv
LOREFOLD_CHATGPT_PERSONAL=1
LOREFOLD_CHATGPT_CALLBACK_PORT=15190
# Optional, when the browser is on a different computer:
LOREFOLD_CHATGPT_SSH_TARGET=reader@your-private-host
```

Use a free callback port in 15184–15190. Restart with the supported worktree
`down` / `up` commands after changing environment settings. No public callback
route, API key, Codex credential file, or Cloudflare balance is used.

From **AI & connections**, select **Continue with ChatGPT**. Lorefold starts its
loopback listener before showing the authorization link. If using another
computer, run the displayed SSH tunnel there and leave it open, then follow the
link and approve OpenAI’s request. The settings page polls for completion and
shows the connected email and whether plan permission was granted. A valid identity
without plan scopes remains unable to use the plan. The registration reconnects
to the same account/workspace; this first UI supports one registration per reader.

Attempts expire after 20 minutes, can be cancelled, and are tied to the initiating
Lorefold user and session. One callback listener is allowed at a time. A callback
cannot finish linking after the initiating Lorefold session has expired or been
deleted. Signing out of Lorefold does not revoke an already connected ChatGPT plan.

**Disconnect ChatGPT** cancels pending sign-in, attempts remote session revocation,
and removes local access, refresh, and ID tokens. It preserves the registration
and host ID for reconnection. If revocation cannot be confirmed, the UI instructs
the reader to disconnect in ChatGPT settings too. Usage controls are linked to
[ChatGPT Settings → Usage](https://chatgpt.com/settings/usage).

## Credential boundaries

By default, the app stores protected credentials under the ignored
`.lorefold/chatgpt-accounts/<sha256-of-Lorefold-user-id>/` directory. Alternatively,
select the encrypted database store below. Tokens are never returned by the API
or placed in browser storage. The OAuth URL contains state,
nonce and a PKCE challenge, never tokens or the verifier. Account state comes only
from validated OpenAI ID tokens and granted scopes. Every settings/connection API
requires a Lorefold session; mutations also enforce the trusted request origin.

The CLI benchmark still uses its separate machine-local configuration described
in [book-benchmark.md](book-benchmark.md). Existing CLI credentials are neither
copied nor adopted by web accounts. Disconnecting in the website does not log out
the CLI, and CLI logout does not clear a website connection.

Graceful service shutdown cancels pending OAuth listeners. With file storage, a forced crash
may retain `session.lock`; confirm its recorded PID is no longer
running before removing that specific stale lock. Never delete live session locks
or copy stores between worktrees. Removing a Lorefold user from the database does
not currently erase their local credential file; an account-deletion feature must
revoke and clear that store before deleting the user. Database credential rows
are deleted automatically with their Lorefold user; account deletion must still
attempt remote revocation first.

## Encrypted PostgreSQL storage

For a web app and worker that share PostgreSQL but have separate container
filesystems, configure both with the same runtime-only values:

```dotenv
LOREFOLD_CHATGPT_STORAGE=database
LOREFOLD_CHATGPT_ENCRYPTION_KEY=<dedicated 64-character hexadecimal key>
```

Generate a fresh key with `openssl rand -hex 32` in a private terminal and save it
directly in Coolify or your password manager. Use a separate development key in
each worktree. Never commit it, send it in chat, use a `VITE_*` variable, or store
it alongside the encrypted records in PostgreSQL. Preserve this key across
redeployments and back it up separately from the database. Changing it without
reencrypting existing records makes those connections unreadable; rotation is
not automated. A missing or incorrect key never falls back to file credentials.

Migration `0007_chatgpt_credentials` adds `chatgpt_credential_store`, with one row
per Lorefold account. The complete registration, verified identity, stable host
ID, tokens, scopes and expiry are encrypted with AES-256-GCM. Each write uses a
fresh nonce, and authenticated encryption binds the record to its Lorefold user
so copying ciphertext to another user's row cannot transfer a connection.

The web app and worker load the same record. A per-account PostgreSQL advisory
lock prevents concurrent refresh, reconnect or disconnect operations. Refresh
replaces the complete encrypted record atomically. No database transaction is
held open while waiting for browser consent. The lock is released when its
database connection closes, including after a container exits; a conflicting
operation reports that the connection is busy and can be tried again later.

Apply migrations before enabling this mode. Existing file connections and CLI
profiles are not copied automatically: reconnect the website account in a
configured personal development installation. Selecting database storage does
not enable OAuth or live imports by itself, and does not remove the production
restriction. An owner-only production authorization/provisioning flow remains
separate work. The database store itself needs no shared Docker volume.

Tests use synthetic OAuth identities and isolated users. They verify ownership,
session binding, cancellation, revocation failures and settings persistence without
using plan allowance. The settings browser test mocks OpenAI responses; a real
user must complete the OpenAI consent screen to finish a live connection.
