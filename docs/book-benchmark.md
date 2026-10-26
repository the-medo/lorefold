# Book model benchmark

This standalone development CLI compares six candidate models on the same selected
chapters. It does not create library books, update reading progress, import generated
knowledge, use R2, or implement the production worker. Node 24+ and Python 3 are
required. The ChatGPT plan connection uses `jose` to verify OpenAI identity tokens.

## Start without spending credits

From the worktree root:

```bash
# Original three-chapter fixture, all six model slots, deterministic mock.
scripts/worktree-dev/lorefold-worktree-dev run -- npm run benchmark:book

# Inspect a private EPUB without making model calls.
scripts/worktree-dev/lorefold-worktree-dev run -- npm run benchmark:book -- \
  --epub '/absolute/path/book.epub' --list

# Review input sizes and cost reservations, still without model calls.
scripts/worktree-dev/lorefold-worktree-dev run -- npm run benchmark:book -- \
  --epub '/absolute/path/book.epub' --chapters 1,2,3 --plan

# Exercise extraction, output validation, checkpoints and reporting on that EPUB.
scripts/worktree-dev/lorefold-worktree-dev run -- npm run benchmark:book -- \
  --epub '/absolute/path/book.epub' --chapters 1,2,3
```

Default chapter selection requires exact `Chapter N` navigation labels. It keeps
front matter, bonus stories and excerpts out of the test. Missing or repeated labels
fail instead of guessing. For other titles, inspect `--list` and use
`--sections 5,6,7` to explicitly select whole XHTML spine documents. In that mode,
evidence chapter numbers are section numbers. EPUB 2 NCX and EPUB 3 TOC navigation
are supported. Fragment-based chapter splits, malformed XHTML, encrypted text and
ambiguous packages are deliberately unsupported. The reader never extracts ZIP
entries to disk or fetches external resources; it limits archive and XML sizes.

`--models gpt,claude` narrows the comparison. The available keys are `gpt`, `claude`,
`glm`, `deepseek`, `oss`, and `gemma`. `--max-output` defaults to 8192 per call;
`--context-chars` defaults to 16000 characters of earlier selected paragraphs.
Each request receives its full current chapter plus the same bounded earlier
source context for every model. It never receives later chapters or model-generated
context. Missing earlier chapters are not implicitly included. Large requests fail
the conservative context check rather than silently truncating the current chapter.

## Configure a live development test

The existing gateway is `lorefold-book-upload-dev`. Store these values privately in
this worktree's root `.env`, preserving its existing settings, or export them in
the invoking shell. Do not put a token in command arguments, source files or `VITE_*`.

```dotenv
LOREFOLD_BENCHMARK_LIVE=1
CLOUDFLARE_ACCOUNT_ID=<your development account ID>
CLOUDFLARE_AI_GATEWAY_ID=lorefold-book-upload-dev
CLOUDFLARE_API_TOKEN=<your account-scoped development API token>
```

The token needs inference access for the chosen account, including Workers AI and
AI Gateway. Use Cloudflare's current [REST API token guidance](https://developers.cloudflare.com/ai-gateway/usage/rest-api/).
The Codex MCP connection does not supply a token to this process. A live smoke test
is still necessary to confirm account/model access. Separate OpenAI/Anthropic keys
are not needed with [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/).
`LOREFOLD_AI_MODE=mock` remains the application's future provider contract; the
standalone benchmark uses its own opt-in and never changes app configuration.

```bash
# Small billable smoke test with synthetic text and one model.
scripts/worktree-dev/lorefold-worktree-dev run -- npm run benchmark:book -- \
  --live --models gpt --chapters 1 --budget-usd 0.25

# Three chapters, all six models. Inspect the matching --plan before running.
scripts/worktree-dev/lorefold-worktree-dev run -- npm run benchmark:book -- \
  --epub '/absolute/path/book.epub' --chapters 1,2,3 --live --budget-usd 2
```

Live calls require both `--live` and `LOREFOLD_BENCHMARK_LIVE=1`; production mode is
rejected. The fixed Cloudflare API origin receives the named gateway header on
every request. Requests are sequential, at least 6.1 seconds apart, with a three-minute
timeout, no automatic retry, no response cache, and gateway payload logging disabled.
GPT uses Responses, Claude uses Messages, and the four Workers AI models use Chat
Completions. Reasoning effort is explicitly low where supported; Claude and Gemma
use their provider defaults. This compares practical configured behavior, not
identical hidden reasoning budgets.

## Budget and output

The dollar budgets and prices below apply to the Cloudflare provider. For ChatGPT
plan usage, use the request-count controls in the next section; dollar estimates
and output-token caps do not apply.

Every run saves a private snapshot under `.lorefold/benchmarks/<run-id>/`:

- `run.json`: model IDs, price snapshot, prompt version, selected source paragraphs,
  settings and source hash. It contains private book text, never credentials.
- `<model>-chapter-<number>.json`: a checkpoint written before dispatch, then the
  response text, normalized usage, elapsed time, estimated cost and validation.
- `report.json` and `report.md`: comparison totals and review guidance.

The directory is ignored by Git with permissions 0700; files use 0600. Do not
commit or publish these reports. Terminal progress contains no book passages or
model outputs. Mock reports are explicitly labeled: they verify the runner, not
model quality, and make no network calls.

Prices are a **2026-10-25 snapshot**, in USD per million uncached input/output tokens:

| Key | Model ID | Input / output |
| --- | --- | --- |
| gpt | `openai/gpt-6.1-sol` | $2 / $10 |
| claude | `anthropic/claude-sonnet-5.5` | $2 / $10 |
| glm | `@cf/zai-org/glm-5.3-flash` | $0.15 / $0.50 |
| deepseek | `@cf/deepseek-ai/deepseek-v4.1-flash-1017` | $0.30 / $1.20 |
| oss | `@cf/openai/gpt-oss-120b` | $0.35 / $0.75 |
| gemma | `@cf/google/gemma-4-26b-a4b-it` | $0.10 / $0.30 |

Sources: [GPT catalog](https://developers.cloudflare.com/ai/models/openai/gpt-6.1-sol/),
[Claude catalog](https://developers.cloudflare.com/ai/models/anthropic/claude-sonnet-5.5/),
[Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).
Recheck before future live evaluations. GPT requests are conservatively restricted
below its 272k input pricing threshold. [Reasoning output counts toward billed output](https://developers.openai.com/api/docs/guides/reasoning)
and is never counted twice. Costs use reported input/output totals; cached reads
are estimated at uncached rates, and reported Anthropic cache writes at 1.25x.
The credit-purchase fee, infrastructure, taxes and any discounts are excluded.

Before each request the runner reserves its estimated maximum cost using UTF-8
request bytes plus 1024 as a conservative input-token proxy, and the output limit.
This is **not exact tokenization or a guaranteed financial cap**. A new live run is
refused if the total planned reservations exceed `--budget-usd` (default $2).
Reported usage replaces the reservation. Missing usage, failed calls and interrupted
requests retain the full reservation instead of claiming zero cost. The gateway's
separate $10 daily limit is also [best effort](https://developers.cloudflare.com/ai-gateway/features/spend-limits/).

## Use a ChatGPT subscription for personal benchmarks

The `chatgpt-plan` provider uses the official
[Sign in with ChatGPT flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).
This is personal development tooling. Eligibility covers local personal projects
and open-source clients; offering a hosted or paid service requires separate access.
It does not add ChatGPT sign-in to the Lorefold web app or change its production
architecture. The app's Google/Better Auth login remains separate.

```bash
# Sign in locally; select another free callback port in 15184–15190 if necessary.
scripts/worktree-dev/lorefold-worktree-dev run -- npm run chatgpt:plan -- login

# See connection state and the actual account-specific model catalog.
scripts/worktree-dev/lorefold-worktree-dev run -- npm run chatgpt:plan -- status
scripts/worktree-dev/lorefold-worktree-dev run -- npm run chatgpt:plan -- models

# At most two tiny requests, only for Sol/Astra offered by the account.
LOREFOLD_BENCHMARK_LIVE=1 scripts/worktree-dev/lorefold-worktree-dev run -- \
  npm run chatgpt:plan -- smoke

# Offline plan (or omit --plan for a deterministic mock run).
scripts/worktree-dev/lorefold-worktree-dev run -- npm run benchmark:book -- \
  --provider chatgpt-plan --models sol,astra --epub '/absolute/path/book.epub' --plan

# Six requests: three chapters, two models, medium reasoning by default.
LOREFOLD_BENCHMARK_LIVE=1 scripts/worktree-dev/lorefold-worktree-dev run -- \
  npm run benchmark:book -- --provider chatgpt-plan --models sol,astra \
  --epub '/absolute/path/book.epub' --chapters 1,2,3 --max-calls 6 --live

# Compare effort with two separate six-request runs. Keep all other settings equal.
# Run once with medium, then again with xhigh (extra high).
LOREFOLD_BENCHMARK_LIVE=1 scripts/worktree-dev/lorefold-worktree-dev run -- \
  npm run benchmark:book -- --provider chatgpt-plan --models sol,astra \
  --epub '/absolute/path/book.epub' --chapters 1,2,3 --max-calls 6 \
  --reasoning xhigh --timeout-seconds 600 --live
```

Login prints **Continue with ChatGPT** and an OpenAI authorization URL. Complete
the browser consent, including permission to use your plan. Login itself makes
no model calls; `login --smoke` additionally runs the two connection probes and
requires `LOREFOLD_BENCHMARK_LIVE=1`. The flow uses PKCE, state, nonce, dynamic
client registration and verified issuer/audience/signature/expiry/account identity.
It never reads the Codex app's credentials or an OpenAI API key.

Credentials are stored outside Git at
`${XDG_CONFIG_HOME:-~/.config}/lorefold/chatgpt-plan/accounts.json`, with directory
mode 0700 and file mode 0600. The machine's stable host ID and each registration
persist across restarts. Use `--profile another-name` for a separate account or
workspace; later login reuses that profile's issued client ID. Profiles and their
tokens are never combined. `status` prints connection information, never tokens.
Refresh is serialized with `session.lock`; check its PID before removing a stale
lock after a crash. `logout --profile personal` revokes the renewable session and
clears local tokens, retaining registration for future sign-in. If revocation
cannot be confirmed, the CLI directs you to disconnect Lorefold in ChatGPT settings.

### Browser on another computer

OpenAI requires `http://127.0.0.1:<port>/auth/callback`. That address belongs to the
computer running the browser. For the development host in this repository, open
a terminal **on your browser computer**, then keep this tunnel running while signing in:

```bash
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:15190:127.0.0.1:15190 medo@steamdeck.tail73a93e.ts.net
```

Start `login --port 15190` on the development host, then open its printed OpenAI
URL in your browser. The tunnel delivers the loopback callback to the listener.
Do not paste the callback URL, authorization code or credentials into chat. Close
the tunnel after the CLI confirms connection. This temporary OAuth tunnel does
not replace the app's stable private HTTPS preview or expose the listener publicly.
If either end already uses that port, select a free port within 15184–15190 for
both the tunnel and login; never stop another worktree to make room.

### Allowance and preview limitations

Requests use the same allowance as Codex/ChatGPT Work. They do not buy Cloudflare
credits or use API-key billing. In [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage),
set Lorefold's weekly percentage cap and choose whether connected apps may use
extra credits after limits. This tool cannot change those account controls.
There is no automatic fallback to Cloudflare or another paid API.

`--max-calls` defaults to 6, allows 1–100, and counts all saved attempts on resume,
including failed or interrupted calls. A new plan exceeding that limit is refused.
Any transport, account, or usage-limit failure stops the remaining requests.
Reports show reported input/output/reasoning tokens and `shared-chatgpt-plan`
billing; dollar costs and remaining subscription percentage are **unknown**, not
zero. The account catalog is checked before dispatch; a completed request is the
actual access test. No unavailable model is silently replaced.

`sol` selects `gpt-6.1-sol`; `astra` selects `gpt-6-astra`. `--reasoning` accepts
`low`, `medium` (default), `high`, or `xhigh` (extra high) and is saved with the run.
The [Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) and
[Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) model references
both support `xhigh`. Use `--reasoning low`
when comparing to the original Cloudflare GPT baseline. The same source selection,
prompt and mechanical validation are used on both providers; the subscription
route still needs semantic review.

The current [preview contract](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
requires streamed Responses with `store: false`, full input context and no
`max_output_tokens`. Therefore `--budget-usd` and `--max-output` are rejected for
this provider. `--timeout-seconds` defaults to 180 and accepts integers from 30 to
900; it is saved and reused on resume. For effort comparisons, use the same timeout
for every configuration (for example 600 seconds). The timeout, 4 MiB stream limit, and request-count cap
are local safeguards; they do not guarantee an allowance cap. Streaming text is
not accepted until `response.completed`; errors after streaming starts are failures.
Structured output enforcement and semantic recovery are separate future changes.

## Resume and evaluate

```bash
scripts/worktree-dev/lorefold-worktree-dev run -- npm run benchmark:book -- --resume <run-id>
# Live resume requires --live and its original gateway or ChatGPT registration.
scripts/worktree-dev/lorefold-worktree-dev run -- npm run benchmark:book -- --resume <run-id> --live
```

Resume keeps saved settings and skips **every attempted call**, including failures,
invalid outputs and unknown in-flight outcomes. It sends only calls that have no
checkpoint, preventing silent duplicate charges after a lost response. A deliberate
retry is a new run with narrowed `--models`/`--chapters` and its own budget. Never
delete a request checkpoint to force a retry. A lock blocks overlapping processes;
after SIGKILL or a host crash, check the PID in `.lock` and confirm the process is
stopped before removing that lock file. Ctrl+C requests graceful cancellation.

Exit status is 0 when all selected calls complete, pass structural/evidence
validation and (in live mode) report usage; 2 for incomplete/failed/invalid runs or
missing live usage, and 1 for configuration/input errors.
Automatic checks cover JSON shape, exact quotes after whitespace normalization,
paragraph IDs, reveal/cutoff chronology, current-chapter recap support, unique entity
IDs and relationship endpoints. Each label, fact, alias and relationship requires
evidence. No tools or book instructions are executed.

Prompt `book-evidence-v2` and the validator share one limits definition: 1–8 recap
points (aiming for 3–8 when supported), 0–30 entities, 0–6 aliases and 0–6 facts per
entity, 0–40 relationships, and 1–6 citations in every evidence array. Nonempty
strings are bounded to 2,000 UTF-16 code units for claims/relationships, 200 for
labels, 80 for entity/paragraph IDs, and 1,200 per quote. This makes the previously
unstated evidence limit explicit and removes the wider array allowances in the old
validator. Old prompt-version runs remain readable but cannot resume with new
instructions; start a new comparison so all models receive the same contract.

**A matching quote does not establish that it supports the model's claim.** Human
review must assess factual entailment, omissions, alias timing, model-memory spoilers,
and relationship accuracy. The synthetic fixture reveals Rowan's identity only in
chapter 3, providing a small manual spoiler check. Compare real outputs before
choosing a model; more extracted entities do not imply better quality. No AI judge
or automatic semantic score is included in this first runner.

## Verification

```bash
npm run test:book-benchmark
npm run typecheck
npm run build
```

Tests use original synthetic fiction and mocked HTTP responses. They cover both
EPUB navigation versions, archive/XML rejection, selection and future-text isolation,
evidence failures, provider formats and reasoning accounting, opt-in and credentials,
budget stops, private artifacts, locking, interruption checkpoints and resume.
ChatGPT tests also cover OAuth state/PKCE and ID-token validation, callback handling,
protected storage, token rotation, account binding, permission denial, logout,
stream completion/errors, request-count stops and allowance reporting.
