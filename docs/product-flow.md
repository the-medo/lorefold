# Product flow and implementation roadmap

This is the proposed build plan. The repository currently contains documentation
and local development tooling; the application features below are not implemented.
The deployment and technology choices are recorded in [architecture.md](architecture.md).

## First-release goal

Use Lorefold alongside *Outbound Flight*, return after a few days, and understand
where you left off without spoilers.

The first release completes one reading loop:

**Import a book → set reading progress → get a recap → explore the chapter or
story-so-far graph.**

## User flow

### 1. Open your library

Each book shows your last completed chapter and a **Continue** button. Processing
progress appears separately: “12/20 chapters analyzed” must never imply you have
read them.

### 2. Import an EPUB and check its chapters

Upload the file, review the detected title and chapter list, and exclude things
like copyright pages or appendices before analysis. Start with EPUB: it supplies
reading-order and navigation structures we can use for extraction, although we
still need to validate chapter boundaries. See the [EPUB specification](https://www.w3.org/TR/epub-33/).

### 3. Let analysis run in the background

Show understandable progress: “Extracting chapters,” then “Analyzing chapter 3 of
22.” Completed chapters become usable immediately. Failed work can be retried
without restarting the whole book.

### 4. Set your last completed chapter

This becomes the spoiler boundary. If you are listening to chapter 9 but have only
finished chapter 8, Lorefold initially shows information through chapter 8.
Browsing an earlier chapter should not change your saved progress.

### 5. Use the book workspace

Start with a chapter list, a main view with **Recap / Graph** tabs, and a details
panel when you select a character or location.

- **Recap:** a short account of what happened, key developments, and who appeared.
- **Graph:** **This chapter** and **Story so far** modes, with
  character/location/faction filters and search.
- **Entity details:** descriptions, connections, and supporting passages, all
  within the selected chapter boundary and saved reading progress.

## Implementation milestones

Each milestone should leave something usable and independently reviewable.

| Milestone | What we build | What proves it works |
| --- | --- | --- |
| 1. Working application skeleton | React/Hono, database migrations, private sign-in, library and book workspace, deterministic sample data | Run locally and explore a synthetic three-chapter book with progress, recaps, and a small graph |
| 2. Real book import | Private R2 upload, EPUB extraction, chapter review, durable worker jobs | Import an EPUB, see its chapters, and resume processing after a worker restart |
| 3. Reliable AI extraction | Gateway integration, structured recaps/entities/relationships, evidence validation, saved checkpoints | Process sample chapters with acceptable accuracy, spoiler handling, and measured cost |
| 4. Complete reading experience | Saved progress, real graph data, both graph modes, filters, search, evidence panel | Complete the entire Outbound Flight companion flow |
| 5. Personal hosted release | Coolify deployment, backups, recovery checks, import retry/delete controls | Use it from a phone or desktop and recover from a failed import or service restart |

The first milestone's sample data lets us refine the interaction without waiting
for model responses or paying for every UI change. Before investing heavily in
graph polish, test extraction on a few representative chapters as well.

## Knowledge and spoiler handling

A character cannot have just one description that gets overwritten as the book
progresses. That would leak later discoveries into earlier views.

For example:

- Chapter 2 introduces “the captain.”
- Chapter 5 reveals their name.
- Chapter 9 reveals their allegiance.

At chapter 3, the UI must still show “the captain,” with only the information
available then. Labels, aliases, relationships, search results, and summaries all
need the same rule.

Establish this model early: **entities have chapter-scoped facts and evidence**,
and the server constructs the appropriate view. Test it with a small invented
story containing deliberate identity reveals. Known fictional universes also need
evaluation because a model may introduce facts it remembers from outside the
uploaded text. Model prior knowledge is not source evidence.

## Model evaluation

Compare a few candidate models on the same chapters:

- Factual accuracy and supporting evidence.
- Entity consistency, including aliases and mistaken merges.
- Spoiler leaks.
- Latency and cost.

Cloudflare AI Gateway provides request/token/error metrics and supported cost
estimates to help with that comparison. See [Gateway analytics](https://developers.cloudflare.com/ai-gateway/observability/analytics/).

## After the first release

Prioritize these additions:

1. **Catch me up:** a brief recap through saved reading progress.
2. **Where did we last see them?:** the latest relevant appearance of a selected
   character.
3. **Corrections:** fix mistaken character merges or unsupported relationships.
4. **Audiobook bookmarks:** save a listening position and accommodate chapter
   numbering differences.
5. **Multiple books and sources:** shared universes, cross-book graphs, then
   transcripts and other formats.

Cross-book knowledge deserves its own phase: progress becomes a separate boundary
for each source, and identity matching becomes more complicated.

## First coding task

Implement milestone 1: a running application with a synthetic three-chapter story,
working progress controls, recaps, and a basic interactive graph. This gives us
the actual Lorefold experience to evaluate while establishing the spoiler rules
that everything else depends on.
