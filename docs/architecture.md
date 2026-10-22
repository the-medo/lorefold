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
| Interactive graph | Sigma.js + Graphology | Browser |

Use a separate PostgreSQL resource in Coolify for independent lifecycle and
backups unless measured server usage warrants sharing the existing PostgreSQL
instance. Even if sharing an instance, use a separate Lorefold database and role.
Do not share SWUBASE application tables, credentials, or migration history.

The web app, database, and import worker are the three runtime services we operate.
The worker can use the same application image with a different entry point.
The runtime and PostgreSQL queue library are still implementation choices; start
with the familiar Hono/TypeScript approach and verify the queue library against
the selected Bun or Node runtime before pinning dependencies.

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
- The local provider contract defaults to local fixture files and mock AI; live
  R2/AI calls will require explicit development configuration. These providers,
  the app, authentication, schema, and worker are not implemented yet.

## References

- [Coolify Docker Compose](https://coolify.io/docs/applications/builds/docker-compose)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
- [Cloudflare AI Gateway providers](https://developers.cloudflare.com/ai-gateway/usage/providers/)
- [SWUBASE agent guide that informed local development](https://github.com/the-medo/swu-collection/blob/main/AGENTS.md)
