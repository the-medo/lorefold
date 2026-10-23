# Architecture

Agreed on 2026-10-22. Start as a personal, single-user application on the existing
Hetzner server (4 vCPUs, 16 GB RAM), alongside SWUBASE, managed with Coolify.
Capacity still needs to be measured under real load.

## Deployment

| Component | Technology | Location |
| --- | --- | --- |
| Frontend and API | React + Vite + TypeScript; Hono serves the built frontend and API | One Coolify application |
| Authentication | Better Auth, with private user-owned libraries | Within the API |
| Database | PostgreSQL + Drizzle | Coolify; a dedicated Lorefold database and role |
| Import processing | Separate TypeScript worker; durable jobs in PostgreSQL | Separate Coolify application |
| Ebook files and extracted chapter text | Private object storage | Cloudflare R2 |
| AI requests | Cloudflare AI Gateway → Workers AI or an external model chosen through evaluation | Cloudflare gateway; inference at the chosen provider |
| Interactive graph | Three.js + OrbitControls | Browser |

Use a separate PostgreSQL resource in Coolify for independent lifecycle and
backups unless measured server usage warrants sharing the existing PostgreSQL
instance. Even if sharing an instance, use a separate Lorefold database and role.
Do not share SWUBASE application tables, credentials, or migration history.

The web app, database, and import worker are the three runtime services we operate.
The worker can use the same application image with a different entry point.
Milestone 1 uses Node.js 24+, Hono, and TypeScript. The PostgreSQL queue library
remains an implementation choice for milestone 2; verify it against Node before
pinning the dependency.

There is no requirement for Next.js, Vercel hosting, D1, Redis, or Cloudflare Queues.
Cloudflare R2 and AI Gateway remain explicit parts of the chosen architecture.
Cloudflare DNS/proxying can sit in front of Coolify independently of app hosting.

## Import and storage flow

1. An authenticated request creates a source/import record and authorizes a
   private R2 upload. The API may also stream an upload to R2.
2. After validating upload completion, record the processing job durably in
   PostgreSQL. Keep job creation and database state changes transactional.
3. The worker claims work, reads the ebook from R2, and saves ordered chapter text
   back to R2. Keep only object keys and source offsets in database references.
4. Analyze chapters through AI Gateway, using only the current chapter and earlier
   supported context. Validate structured output and its evidence references.
5. Save recaps, entities, facts, relationships, evidence references, and processing
   checkpoints in PostgreSQL. Save reader progress separately from processing progress.
6. The API builds filtered graph views from saved data. Moving between chapters
   should not invoke a model again.

Initially process one book at a time. Jobs need durable progress, bounded retries,
and writes that are safe to repeat after a crash. A queue library alone does not
make model calls or application-side writes exactly-once.

R2 buckets remain private. Readers obtain authorized access through the API or
short-lived signed URLs. Credentials remain server-side. Source texts are user
content, not instructions for the application or model tools.

## Spoiler boundaries

Record when each fact becomes known: source, chapter/section, supporting passage,
and extraction version. An entity's first appearance is not sufficient to gate
later aliases, identity revelations, descriptions, or relationships.

Apply progress restrictions server-side before returning results. Chapter recaps
and story-so-far recaps must use the same boundary. Model world knowledge is not
evidence; imported passages must support claims, particularly for well-known
fictional universes. Evaluate entity resolution, factual accuracy, spoiler leaks,
and per-book cost before selecting the extraction model.

## Operations and development

- Keep the import worker's concurrency and resource limits separate from the web
  app so imports can be throttled around Crossfire and other VPS workloads.
- PostgreSQL data needs persistent storage and scheduled backups outside the VPS.
  R2 holds originals and extracted text; database backups are also necessary.
- Local development has a separate PostgreSQL container and volume per Git worktree.
  See [local development](../scripts/worktree-dev/README.md).
- The application, Better Auth sign-in, and Drizzle schema/migrations are implemented.
  Local sample data is seeded directly without a model. Original file uploads use
  a development-only local storage adapter; R2/AI providers and the worker are not yet
  implemented. Live calls will require explicit development configuration.

## Milestone 1 implementation

Hono serves `/api` and the built Vite frontend. During development, Vite proxies
same-origin `/api` requests to the isolated backend. Better Auth uses the Drizzle
adapter, HTTP-only sessions, and each worktree's cookie prefix. Public signup is
disabled; a local provisioning command hashes the password and creates the user
and credential account in one transaction. Sign-in is rate limited in-process;
multi-instance rate limiting and trusted proxy configuration must be addressed
before hosted deployment. There is no password reset/email delivery yet.

Universes belong to a user and group books and reference documents. Books optionally
belong to one universe; the full library includes all owned books. Composite foreign
keys prevent assigning a book or uploaded resource to another owner's universe.
The sample migration creates Bellweather and preserves existing reading progress.

Uploads accept EPUB/PDF/TXT/Markdown books and PDF/TXT/Markdown documents, bounded
to 25 MB, with basic container signatures checked before storage. The development
adapter saves originals under `.lorefold/storage/uploads/` with random keys and
private file permissions. The API authorizes every download and serves files as
attachments with no-store and nosniff headers. Files are never executed, extracted,
or served from the frontend's static directory. Failed database writes remove the
new file. Production upload storage remains disabled until private R2 is connected;
crash recovery and orphan reconciliation belong with that durable import workflow.
An uploaded book has zero chapters and no generated recaps or graph. Reference
documents do not become library books or contribute knowledge automatically.

Books belong to a user. Every library, workspace, and progress query checks that
ownership. Facts and relationships reference chapter-specific evidence with source
quotes and an extraction version; appearances control the chapter graph scope.
The workspace transaction reads a consistent database snapshot and uses
`min(selected chapter, saved completed chapter, chapter count)` for the response.
It filters facts, evidence, edges, recaps, source text, and chapter titles before
serialization. It resolves the latest permitted label and cumulative permitted
descriptions/aliases, and drops edges without visible endpoints. The chapter map
includes entities appearing in that chapter and relationships evidenced there;
story-so-far includes everything established through the cutoff.

The synthetic seed is atomic and idempotent per owner, and never overwrites reader
progress. Browser search/filtering operates only over the already restricted
payload. API tests explicitly cover identity reveals, direct requests for later
chapters, rewinds, ownership, and repeated migrations/seeds.

## 3D story map

Three.js renders a perspective scene with OrbitControls for mouse, touch, and
keyboard navigation. A deterministic spring layout uses only visible entities and
relationships from the authorized response. Search and type filters do not fetch
hidden knowledge. Selecting a sphere, projected label, or entity-list item shares
the evidence panel and highlights its immediate connections.

The renderer loads on demand with the Story map tab. It draws only when the camera,
selection, or viewport changes, caps device pixel ratio at two, honors reduced motion,
and disposes GPU resources and listeners when unmounted or filtered. Context loss
shows an accessible list fallback; restoration or retry rebuilds the scene. Layout
is synchronous and intended for the small skeleton graph; large imported graphs
will need performance measurement and possibly worker-based layout/level of detail.

## References

- [Coolify Docker Compose](https://coolify.io/docs/applications/builds/docker-compose)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
- [Cloudflare AI Gateway providers](https://developers.cloudflare.com/ai-gateway/usage/providers/)
- [SWUBASE agent guide that informed local development](https://github.com/the-medo/swu-collection/blob/main/AGENTS.md)
