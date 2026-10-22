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
| Graph exploration | Sigma.js + Graphology | Browser |

PostgreSQL stores chapter recaps, entities, relationships, evidence references,
reader progress, and processing checkpoints. R2 stores original ebooks and
extracted chapter text. Start with one concurrent book import.

See [architecture and data flow](docs/architecture.md) for the deployment split,
spoiler boundaries, and implementation decisions still to make.

## Local development

Each Git worktree gets its own PostgreSQL 16 container, volume, local credentials,
and port reservations. Requires Linux/WSL, Bash, Python 3.10+, Git, and local Docker.

```bash
scripts/worktree-dev/bootstrap-worktree.sh
scripts/worktree-dev/lorefold-worktree-dev status
scripts/worktree-dev/lorefold-worktree-dev psql -- -c 'SELECT current_database();'
```

The bootstrap preserves existing data and `.env`, creates safe local config if
missing, and generates ignored worktree-specific environment files. The API and
frontend ports are reserved for future app scaffolding; no app is running yet.

See [local development commands](scripts/worktree-dev/README.md) and
[AGENTS.md](AGENTS.md). `down` stops PostgreSQL while keeping its data;
`down --purge-data` deliberately deletes only this worktree's database resources.

## Inspiration and status

Inspired by the mindmap-style exploration in [AI Coding Dictionary](https://www.aicodingdictionary.com/?term=afk).

**Status:** Architecture agreed; local database/worktree tooling implemented.
The application, authentication, database schema, and AI import pipeline are not
implemented yet.
