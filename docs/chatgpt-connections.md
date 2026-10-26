# Personal ChatGPT account connections

The website login (Google or provisioned email/password) identifies a Lorefold
reader. ChatGPT authorization separately grants permission to use a ChatGPT plan.
User settings → **AI & connections** manages the latter and saves model preferences.
Each reader starts with Astra (`gpt-6-astra`) at `high` effort and can choose Sol 6.1
or Astra at `medium`, `high`, or `xhigh`. The preference persists in PostgreSQL.
There is no analysis job or inference call behind these controls yet.

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

The app stores protected credentials under the ignored
`.lorefold/chatgpt-accounts/<sha256-of-Lorefold-user-id>/` directory. Tokens are never
returned by the API or placed in browser storage. The OAuth URL contains state,
nonce and a PKCE challenge, never tokens or the verifier. Account state comes only
from validated OpenAI ID tokens and granted scopes. Every settings/connection API
requires a Lorefold session; mutations also enforce the trusted request origin.

The CLI benchmark still uses its separate machine-local configuration described
in [book-benchmark.md](book-benchmark.md). Existing CLI credentials are neither
copied nor adopted by web accounts. Disconnecting in the website does not log out
the CLI, and CLI logout does not clear a website connection.

Graceful service shutdown cancels pending OAuth listeners. After a forced crash,
a protected store may retain `session.lock`; confirm its recorded PID is no longer
running before removing that specific stale lock. Never delete live session locks
or copy stores between worktrees. Removing a Lorefold user from the database does
not currently erase their local credential file; an account-deletion feature must
revoke and clear that store before deleting the user.

Tests use synthetic OAuth identities and isolated users. They verify ownership,
session binding, cancellation, revocation failures and settings persistence without
using plan allowance. The settings browser test mocks OpenAI responses; a real
user must complete the OpenAI consent screen to finish a live connection.
