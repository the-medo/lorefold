# Lorefold

A reading and listening companion that turns stories into interactive knowledge graphs, revealing the world as you progress.

Upload your own ebook and let AI analyze its chapters in the background, identifying characters, locations, factions, objects, events, and their relationships. Explore an interactive mindmap and revisit what happened without seeing spoilers beyond your current chapter.

## The idea

Complex stories can be hard to follow, especially when listening to an audiobook or returning after a few days away. Lorefold helps answer: **Where did I leave off, who is this character, and how does everything connect?**

The initial use case is following *Outbound Flight* in the Star Wars universe: import the ebook, mark chapters as read or listened to, and use recaps and maps to regain context.

## Planned experience

1. Upload an ebook and have it analyzed in the background.
2. Mark the chapters you have read or listened to.
3. Read a recap of the current chapter or catch up on the story so far.
4. Explore a graph of the current chapter, or everything revealed from the beginning through your selected chapter.
5. Filter by chapter, source, or entity type, such as characters and locations.

Every summary, entity description, and relationship should respect your progress. Later revelations must stay hidden even when the entire source has already been analyzed.

See the [product flow and implementation roadmap](docs/product-flow.md) for the
complete reading loop, build milestones, and first coding task.

## Starting scope

- Ebook import and chapter detection.
- AI-generated chapter recaps and entity/relationship extraction.
- Reading and listening progress tracking.
- Interactive chapter and story-so-far graphs.
- Links from graph details back to the chapters that support them.

Longer term, support multiple books and other sources, including movies through transcripts or subtitles, with section recaps and filters across sources.

## Application stack

Lorefold starts as a personal, single-user application. The frontend, API,
database, and import worker run on the existing Hetzner VPS through Coolify.
Cloudflare R2 and AI Gateway remain part of the setup.

| Component | Technology | Hosting |
| --- | --- | --- |
| Frontend + API | React + Vite + TypeScript; Hono serves the frontend and API | One Coolify application |
| Authentication | Better Auth | Within the API |
| Database | PostgreSQL + Drizzle | Coolify |
| Background imports | Separate TypeScript worker; durable jobs stored in PostgreSQL | Coolify |
| Ebook files + extracted text | Private R2 object storage | Cloudflare |
| AI requests | AI Gateway → Workers AI or an external model chosen through testing | Cloudflare gateway |
| Graph exploration | Three.js + OrbitControls | Browser |

PostgreSQL stores chapter recaps, entities, relationships, evidence references,
reader progress, and processing checkpoints. R2 stores original ebooks and
extracted chapter text. Start with one concurrent book import.

See [architecture and data flow](docs/architecture.md) for the deployment split,
spoiler boundaries, and implementation decisions still to make.

## Run the application locally

Requires Node.js 24+, npm, Linux/WSL, Bash, Python 3.10+, Git, and local Docker.
Each worktree has its own PostgreSQL 16 container, database, auth cookies, and ports.

```bash
scripts/worktree-dev/bootstrap-worktree.sh
npm ci
scripts/worktree-dev/lorefold-worktree-dev run -- npm run db:migrate
scripts/worktree-dev/lorefold-worktree-dev run -- npm run demo:setup
scripts/worktree-dev/lorefold-worktree-dev up
```

Open the **Browser URL** from `scripts/worktree-dev/lorefold-worktree-dev status`.
`up` runs the app in a background systemd user service. For remote development,
configure the machine's private Tailscale origin once using
[`configure-access`](scripts/worktree-dev/README.md#stable-access-from-another-computer).
New worktrees inherit it, giving each a stable HTTPS URL that also configures
sign-in. Without a profile, the browser URL uses localhost. Vite proxies `/api`
to Hono and both application listeners stay on loopback.

Sign-in details are saved in `.lorefold/demo-account.json`, readable only by the
local user and ignored by Git. The password is randomly generated per worktree;
there is no public registration or shared default password. Demo setup is restricted
to the local development launcher and preserves existing progress when repeated.

For your own account instead, run the interactive private provisioning command
and seed the book into that account:

```bash
scripts/worktree-dev/lorefold-worktree-dev run -- npm run user:create
scripts/worktree-dev/lorefold-worktree-dev run -- npm run db:seed -- you@example.com
```

The first page is **Universes**. Open **Bellweather**, then **The Lantern at
Bellweather**, select Chapter 1 under **I've finished**, and
save. Explore its recap, original sample text, and story map; select an entity for
its connections and supporting passages. Chapters 2 and 3 introduce deliberate
identity reveals. Try finishing chapter 3, then browsing chapter 1: later names and
facts disappear, while saved progress stays at 3. Set progress back to 0 to start over.

The story map is a 3D scene: drag to orbit, scroll or pinch to zoom, and right-drag
or use two fingers to pan. Select a sphere or label for its evidence and highlighted
connections; reset, focus, and fullscreen controls are in the bottom corner. Arrow
keys orbit a focused map; plus/minus zoom and Home resets. The entity list remains
available when WebGL is unavailable. Reduced-motion settings disable camera transitions.

The selected Lorefold icon is **Folded worlds**, available at `/brand/lorefold.svg`.
The five original SVG options and a ZIP download are at `/brand/icon-options/index.html`.

Create more universes to organize your own sources. Inside a universe, upload a
book (EPUB, PDF, TXT, or Markdown) or reference document (PDF, TXT, or Markdown), up
to 25 MB. Original files are private and downloadable. **My Library** still lists
all your books; unassigned books can be added to a universe without changing progress.
Uploads are stored locally in this development worktree. Chapter extraction and
AI analysis are not available yet, so uploaded books show an explicit pending state.

The sample content is original synthetic fiction seeded transactionally in PostgreSQL.
No R2, chapter extraction, model, or external AI calls are used. Processing progress is
displayed separately from reading progress. The API owns the spoiler boundary;
changing a browser URL cannot fetch knowledge beyond saved progress.

`npm run build` builds React and compiles the Hono server. `npm start` serves both
from one server after setting `DATABASE_URL`, `HOST`, `PORT`, `APP_ORIGIN`,
`BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, and `AUTH_COOKIE_PREFIX`. The two origins
must match the URL used in the browser. Set `NODE_ENV=production` and use HTTPS for
a hosted environment. Production deployment, backups, and account recovery belong
to milestone 5; the development launcher intentionally enforces development settings.

See [local development commands](scripts/worktree-dev/README.md) and [AGENTS.md](AGENTS.md).
`down` stops the app, its private route, and PostgreSQL; data is preserved.
Use `run -- npm run dev` for foreground debugging when the background app is stopped.

## Checks

```bash
npm run typecheck
npm run build
scripts/worktree-dev/lorefold-worktree-dev run -- npm test
# Stop the preview, then start only its DB for lifecycle tests:
scripts/worktree-dev/lorefold-worktree-dev down
scripts/worktree-dev/lorefold-worktree-dev setup
scripts/worktree-dev/lorefold-worktree-dev run -- npm run test:dev
# Restore the background app and private URL:
scripts/worktree-dev/lorefold-worktree-dev up
# Install the browser once if it is not already available:
npx playwright install chromium
scripts/worktree-dev/lorefold-worktree-dev run -- npm run test:browser
```

API tests apply migrations twice, provision isolated test accounts, and cover
sign-in/out, private signup, ownership, input validation, CSRF, spoiler boundaries,
progress persistence, graph scopes, and repeatable seeding. Browser tests run the
reading loop at desktop and mobile sizes. They start the app if needed and remove
their own accounts afterward. To use an existing Chromium installation, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its executable path. Screenshots/traces stay in
ignored `test-results/`. Tests never truncate a database or touch other worktrees.

`npm run db:generate -- --name descriptive_change` generates a checked-in Drizzle
migration after a schema change. Apply it through the worktree launcher as above.

## Inspiration and status

Inspired by the mindmap-style exploration in [AI Coding Dictionary](https://www.aicodingdictionary.com/?term=afk).

**Status:** Milestone 1 implemented: React/Hono application, private Better Auth
sign-in, Drizzle migrations, a user-owned library, saved progress, chapter recaps,
and an interactive Three.js 3D graph with evidence. EPUB import, background jobs,
R2, AI extraction, and hosted deployment remain later milestones.
