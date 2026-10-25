# Book model benchmark

This standalone development CLI compares six candidate models on the same selected
chapters. It does not create library books, update reading progress, import generated
knowledge, use R2, or implement the production worker. Node 24+ and Python 3 are
required; there are no new package dependencies.

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

## Resume and evaluate

```bash
scripts/worktree-dev/lorefold-worktree-dev run -- npm run benchmark:book -- --resume <run-id>
# A live resume also requires its original development account/gateway and --live.
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
