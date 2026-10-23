import { and, asc, eq, lte, sql } from "drizzle-orm";
import { db } from "./db/client.js";
import * as s from "./db/schema.js";
import type {
  Book,
  Entity,
  GraphMode,
  Workspace,
} from "../shared/contracts.js";

const bookSelection = {
  id: s.books.id,
  title: s.books.title,
  author: s.books.author,
  description: s.books.description,
  universeId: s.books.universeId,
  resourceId: sql<string | null>`(select id from resources where book_id = ${s.books.id})`,
  completedChapter:
    sql<number>`coalesce(${s.progress.completedChapter}, 0)`.mapWith(Number),
  totalChapters:
    sql<number>`(select count(*) from chapters where book_id = ${s.books.id})`.mapWith(
      Number,
    ),
  analyzedChapters:
    sql<number>`(select count(*) from chapters where book_id = ${s.books.id} and analyzed)`.mapWith(
      Number,
    ),
};
export function listBooks(userId: string, universeId?: string): Promise<Book[]> {
  return db
    .select(bookSelection)
    .from(s.books)
    .leftJoin(
      s.progress,
      and(eq(s.progress.bookId, s.books.id), eq(s.progress.userId, userId)),
    )
    .where(and(eq(s.books.ownerId, userId), universeId ? eq(s.books.universeId, universeId) : undefined))
    .orderBy(asc(s.books.createdAt));
}

export async function getWorkspace(
  userId: string,
  bookId: string,
  selectedChapter: number | undefined,
  mode: GraphMode,
): Promise<Workspace | null> {
  // Read progress and all knowledge from one snapshot, even while another tab changes progress.
  return db.transaction(
    async (tx) => {
      const [book] = await tx
        .select(bookSelection)
        .from(s.books)
        .leftJoin(
          s.progress,
          and(eq(s.progress.bookId, s.books.id), eq(s.progress.userId, userId)),
        )
        .where(and(eq(s.books.id, bookId), eq(s.books.ownerId, userId)));
      if (!book) return null;
      const cutoff = Math.min(
        selectedChapter ?? book.completedChapter,
        book.completedChapter,
        book.totalChapters,
      );
      const chapterList = await tx
        .select({
          number: s.chapters.number,
          analyzed: s.chapters.analyzed,
          title: sql<
            string | null
          >`case when ${s.chapters.number} <= ${cutoff} then ${s.chapters.title} else null end`,
        })
        .from(s.chapters)
        .where(eq(s.chapters.bookId, bookId))
        .orderBy(asc(s.chapters.number));
      const [chapter] =
        cutoff === 0
          ? []
          : await tx
              .select({
                number: s.chapters.number,
                title: s.chapters.title,
                text: s.chapters.text,
                recap: s.chapters.recap,
                developments: s.chapters.developments,
              })
              .from(s.chapters)
              .where(
                and(
                  eq(s.chapters.bookId, bookId),
                  eq(s.chapters.number, cutoff),
                  eq(s.chapters.analyzed, true),
                ),
              );
      const visibleFacts = await tx
        .select({
          entityId: s.facts.entityId,
          kind: s.entities.kind,
          factKind: s.facts.kind,
          value: s.facts.value,
          chapter: s.facts.revealChapter,
          evidence: {
            id: s.evidence.id,
            chapter: s.evidence.chapter,
            quote: s.evidence.quote,
          },
        })
        .from(s.facts)
        .innerJoin(
          s.entities,
          and(
            eq(s.entities.bookId, s.facts.bookId),
            eq(s.entities.id, s.facts.entityId),
          ),
        )
        .innerJoin(
          s.evidence,
          and(
            eq(s.evidence.bookId, s.facts.bookId),
            eq(s.evidence.id, s.facts.evidenceId),
          ),
        )
        .where(
          and(
            eq(s.facts.bookId, bookId),
            lte(s.facts.revealChapter, cutoff),
            lte(s.evidence.chapter, cutoff),
          ),
        )
        .orderBy(asc(s.facts.revealChapter), asc(s.facts.id));
      const present =
        mode === "chapter"
          ? new Set(
              (
                await tx
                  .select({ id: s.appearances.entityId })
                  .from(s.appearances)
                  .where(
                    and(
                      eq(s.appearances.bookId, bookId),
                      eq(s.appearances.chapter, cutoff),
                    ),
                  )
              ).map((e) => e.id),
            )
          : null;
      const nodes = new Map<string, Entity>();
      for (const fact of visibleFacts) {
        if (present && !present.has(fact.entityId)) continue;
        const node = nodes.get(fact.entityId) ?? {
          id: fact.entityId,
          kind: fact.kind,
          label: "",
          aliases: [],
          facts: [],
        };
        if (fact.factKind === "label") node.label = fact.value;
        if (fact.factKind === "alias") node.aliases.push(fact.value);
        if (fact.factKind === "description")
          node.facts.push({
            value: fact.value,
            chapter: fact.chapter,
            evidence: fact.evidence,
          });
        nodes.set(node.id, node);
      }
      // An entity without a supported visible name must not escape through an edge or ID.
      for (const [id, node] of nodes) if (!node.label) nodes.delete(id);
      const edges = await tx
        .select({
          id: s.relationships.id,
          source: s.relationships.sourceId,
          target: s.relationships.targetId,
          label: s.relationships.label,
          chapter: s.relationships.revealChapter,
          evidence: {
            id: s.evidence.id,
            chapter: s.evidence.chapter,
            quote: s.evidence.quote,
          },
        })
        .from(s.relationships)
        .innerJoin(
          s.evidence,
          and(
            eq(s.evidence.bookId, s.relationships.bookId),
            eq(s.evidence.id, s.relationships.evidenceId),
          ),
        )
        .where(
          and(
            eq(s.relationships.bookId, bookId),
            lte(s.relationships.revealChapter, cutoff),
            lte(s.evidence.chapter, cutoff),
            mode === "chapter" ? eq(s.evidence.chapter, cutoff) : undefined,
          ),
        )
        .orderBy(asc(s.relationships.id));
      return {
        book,
        cutoff,
        mode,
        chapters: chapterList,
        chapter: chapter ?? null,
        graph: {
          entities: [...nodes.values()],
          relationships: edges.filter(
            (e) => nodes.has(e.source) && nodes.has(e.target),
          ),
        },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function saveProgress(
  userId: string,
  bookId: string,
  completedChapter: number,
) {
  return db.transaction(async (tx) => {
    const [book] = await tx
      .select({ id: s.books.id })
      .from(s.books)
      .where(and(eq(s.books.id, bookId), eq(s.books.ownerId, userId)))
      .for("update");
    if (!book) return "missing" as const;
    const [{ total }] = await tx
      .select({ total: sql<number>`count(*)`.mapWith(Number) })
      .from(s.chapters)
      .where(eq(s.chapters.bookId, bookId));
    if (completedChapter < 0 || completedChapter > total)
      return "invalid" as const;
    await tx
      .insert(s.progress)
      .values({ bookId, userId, completedChapter })
      .onConflictDoUpdate({
        target: [s.progress.bookId, s.progress.userId],
        set: { completedChapter, updatedAt: new Date() },
      });
    return "saved" as const;
  });
}
