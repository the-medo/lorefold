# Book imports

An uploaded book now queues a PostgreSQL job in the same transaction that creates
its library record. A separate worker extracts every nonempty linear EPUB spine
section, then analyzes every chapter part in order. A second, isolated pass matches shared
identities without rewriting the notes. Recaps, source quotes, entities,
relationships, and checkpoints are persisted. The book page polls progress and
supports pause/resume. Analysis never changes the reader's finished chapter.

## Development

The normal `lorefold-worktree-dev up` starts API, frontend, and worker processes.
Run migrations before startup. A standalone worker uses the same worktree launcher:

```bash
scripts/worktree-dev/lorefold-worktree-dev run -- npm run worker
```

Only one worker can own an import at once, even if multiple processes start.
The default `LOREFOLD_AI_MODE=mock` makes no model calls. It produces deterministic
source excerpts and simple named-entity fixtures, visibly labelled **Mock analysis**.
It is a workflow simulation, not a substitute for real literary analysis.

To use the reader's connected personal ChatGPT account, configure the worktree's
private `.env` and restart:

```dotenv
LOREFOLD_AI_MODE=chatgpt-plan
LOREFOLD_IMPORT_LIVE=1
LOREFOLD_CHATGPT_PERSONAL=1
LOREFOLD_CHATGPT_CALLBACK_PORT=15190
LOREFOLD_CHATGPT_SSH_TARGET=reader@your-private-host
```

Each reader must connect in **Settings → AI & connections**. No CLI or other user's
credentials are adopted. Imports without a usable connection pause with a resume
action. Plan limits, expiry, and request failures pause processing without switching
to a paid API. A personal production VM uses the
[owner-only connection setup](chatgpt-connections.md#personal-server-on-coolify)
with encrypted PostgreSQL storage instead of the development callback listener.

Alternatively set `LOREFOLD_AI_MODE=gateway`, `LOREFOLD_IMPORT_LIVE=1`, and private
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_GATEWAY_ID`, `CLOUDFLARE_API_TOKEN` values.
This uses the existing Cloudflare Responses provider. Model access depends on the
configured gateway. Every upload snapshots the reader's model and effort; changing
settings affects new imports. Provider mode is also fixed for an existing job.
The default is Astra high. An import can contain many requests and consume shared
plan allowance or gateway credits. Upload UI states the configured mode before
submission. No live service calls are made by the automated tests.

## Sources and storage

EPUB supports EPUB 2/3 navigation, inline XHTML, multiple chapters in one document,
and navigation anchors. The linear spine determines reading order. Text before a
chapter anchor and unlabelled sections are retained; introductory/back matter may
appear as sections. Navigation-only and image-only content does not become a chapter.
No DRM bypass is attempted. Invalid anchors, encrypted content, duplicate ZIP paths,
unsafe references, XML entities, and excessive expansion are rejected.

UTF-8 TXT/Markdown use chapter/prologue/epilogue/part lines or Markdown headings.
Text-based PDFs use local `pdftotext`; install Poppler utilities on the worker host.
Scanned PDFs require OCR before upload. Without explicit headings, text is one
chapter. Reference documents remain stored-only; this import workflow is for books.

Python 3 is required by EPUB extraction. Both subprocesses have time and output
limits. Uploads remain limited to 25 MB; extracted text to 24 MiB, 1,500 sections,
and 2,000 analysis parts (up to 4,000 extraction/matching steps). Long paragraphs are split without cutting Unicode code
points; each part contains at most 24,000 UTF-16 text units. The worker processes
all parts, rather than silently truncating a chapter.

Originals and extracted text use the same private storage adapter. Local storage
is development-only under the worktree's `.lorefold/storage/`. R2 uses its S3 API
with server-only credentials and a mandatory `R2_KEY_PREFIX`. Development R2 also
requires `LOREFOLD_R2_LIVE=1`. The generated prefix keeps worktree objects separate.
Configure `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`; keep
the bucket private. Readers access originals and chapter text through authorized
API routes, not public object URLs. Chapter rows hold text keys; the synthetic
sample retains its original inline text. A production worker runs
`npm run start:worker` from the built app with PostgreSQL and the same storage config.
The build includes the EPUB parser. Hosted deployment itself is not part of this change.

## Shared characters and spoiler boundaries

The extraction pass sees only the current part and earlier identities from this
book. The separate identity pass sees the already validated entities and supported
names/aliases from other books owned by that reader in the same universe. It can
return links only: it cannot change the notes, names, aliases, or facts. Each pass
has its own durable checkpoint. Matching is skipped without another model request
when there are no current entities or other-book candidates. A bounded directory prioritizes names found in
the current text and same-book identities (up to 100 entries / 48,000 characters).
It includes one source passage per candidate. The directory is identity context,
not evidence for new facts. Missing/ambiguous matches stay separate.

The extraction model returns local entities with optional same-book matches; the
identity pass returns only cross-book candidate matches. The server checks
candidate membership, entity kind, current-part quotes, shared identity names, and
unique matches. Same-book matches reuse the local identity. Cross-book matches
store both source endpoints and their reveal chapters/evidence. Matching names
alone never merges books automatically. Mechanical checks establish provenance,
not semantic certainty; AI can still misinterpret a passage or identity.

Facts, aliases, names, and relationships remain book-local. Each is filtered on the
server by that book's reading cutoff; a chapter contributes knowledge only after
all its parts validate. A cross-book match is returned only when both supported
endpoints are visible. The universe map then combines those permitted identities
*after* applying source selection. Excluding a book removes its facts, aliases,
and identity bridges. Every displayed fact retains its book/chapter attribution.
No hidden canonical name is exposed by a shared node. Model prompts never use
external fictional knowledge as source evidence.

## Review duplicate points

Run the point merge script against an existing book when its map shows the same
person, place, faction, or object more than once. This is an operator command. Its
private JSON report can contain names and passages from **all analyzed chapters**,
including chapters beyond the owner's saved reading progress.

Use the account email and the book ID from its `/books/BOOK_ID` URL. Choose a
new file under the worktree's ignored `.lorefold/` directory for each scan.

```bash
scripts/worktree-dev/lorefold-worktree-dev run -- npm run point-merge -- suggest \
  --owner you@example.com --book BOOK_ID --plan .lorefold/merge-plan.json
```

Open the report and review the two points, the quoted evidence from each, the
reason and the reveal chapter. For example, if a surname and a full name could
belong to relatives, accept the pair only if the passages establish one person.
The following command applies suggestions 1 and 3 from that report.

```bash
scripts/worktree-dev/lorefold-worktree-dev run -- npm run point-merge -- apply \
  --owner you@example.com --book BOOK_ID --plan .lorefold/merge-plan.json --accept 1,3
```

The scan uses the configured import provider and the owner's current model and effort.
The default mock suggests overlapping names deterministically. For an AI review,
use the ChatGPT plan or gateway configuration above. Larger books can use multiple
requests. Every pair of named points of the same kind is eligible, including points
in different batches. The prompt samples up to six passages each for labels, aliases
and descriptions per point. The scan runs separately from import. A scan can miss
a duplicate when the sampled passages omit the identity reveal.

Applying the selection rechecks the owner, book, labels and cited facts, then saves
all selected links in one transaction. Reapplying the same report is safe. The
reader sees one point once both names and both citations are available. Rewinding
before the reveal restores the earlier view. Linked points keep their original
evidence, relationships to other points and chapter appearances. The latest visible
label becomes the display name, with other visible names available as aliases.
These links also apply on the universe map and preserve existing cross-book matches.

In a built installation, run `node dist/server/scripts/point-merge.js` with the
same arguments and a private, writable plan path accessible to both commands.

## Recovery and validation

The worker uses a PostgreSQL session advisory lock and a per-run fencing token.
Prompts, identity candidates, raw responses, attempts, token usage, and part status
are durable private records. Each extraction or matching response is saved before its knowledge
transaction. That transaction commits all part facts and its checkpoint together;
a restart can revalidate the saved response without another model call.

Failed steps get three automatic retries after the initial attempt, with delays of
2, 10, and 30 seconds. This covers malformed JSON, unsupported citations and other
validation failures, model/connection errors, extraction, and storage/processing
errors. Retry counts and the next retry time persist in PostgreSQL across worker
restarts. Delayed jobs release the worker so other queued books can proceed.
Each completed step resets the retry allowance for the next step.

After that allowance is exhausted, the import pauses with **Resume analysis**
available. Resume grants a fresh allowance for the unfinished step, including for
jobs exhausted under the old three-attempt cap. Lifetime inference counts, received
token usage, completed parts, and reading progress are preserved. Rejected responses
are kept privately in `import_failures` before replacement. Invalid output never
publishes knowledge, and completed parts are never replayed.

An interrupted request with no saved response has unknown usage; its bounded retry
may consume usage again. A saved response is reused after a persistence error,
without another model call or duplicate token accounting. An explicit pause takes
effect after the current request is saved and also cancels a scheduled retry.
Graceful worker shutdown aborts inference and leaves the job paused for resume.
Reported token totals include rejected responses but cannot include unknown
provider usage. Retries never switch providers or fall back to a paid API.

Deploy the web image first to apply migration `0008_resumable_import_retries`, then
deploy the worker from the same revision. Existing failed jobs can be resumed from
their book page; no counter reset or re-upload is required.

The chapter list displays extracted source titles even before reading or analysis.
It is a compact, scrollable table of contents; unread chapters remain locked and
unvalidated recaps, source text, and map knowledge remain unavailable.

Private model responses contain source text; keep database backups private. Files
written just before a process/DB failure can become unreferenced; automatic orphan
storage cleanup and account-deletion storage cleanup are not implemented. Do not
manually delete an original or chapter key referenced by an active import.

Validation covers full EPUB upload-to-map flow, fragment chapters, oversized input,
source ownership, spoofed candidates, name/evidence validation, interrupted calls,
saved-response recovery, serial execution, pause/resume, bounded retries, and
cross-book cutoffs/source exclusion. Provider adapters are tested without sending
private books to live services. The six-model benchmark remains a separate tool. Its comparison table measures
extraction only; cross-book matching is an additional request when candidates exist.
