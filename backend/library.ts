import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "./db/client.js";
import * as s from "./db/schema.js";
import type {
  Book,
  GraphMode,
  Workspace,
} from "../shared/contracts.js";

import { readGraph, type KnowledgeReader } from "./knowledge.js";

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
export function listBooks(userId: string, universeId?: string, reader: typeof db | KnowledgeReader = db): Promise<Book[]> {
  return reader
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
      return {
        book,
        cutoff,
        mode,
        chapters: chapterList,
        chapter: chapter ?? null,
        graph: await readGraph(tx, bookId, cutoff, mode),
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
