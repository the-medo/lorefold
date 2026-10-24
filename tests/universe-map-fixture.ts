import { randomUUID } from "node:crypto";
import { db } from "../backend/db/client.js";
import * as s from "../backend/db/schema.js";

// Original test fiction deliberately reuses the sample's local IDs and Mara's name.
export async function seedMapBook(ownerId: string, universeId: string | null, completedChapter = 2) {
  const bookId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(s.books).values({ id: bookId, ownerId, universeId, title: "The Wandering Orchard", author: "Test author", description: "An original test story." });
    await tx.insert(s.chapters).values([
      { bookId, number: 1, title: "The garden", text: "Mara meets the gardener.", recap: "Mara visits a garden.", developments: [], analyzed: true },
      { bookId, number: 2, title: "A name", text: "The gardener is Orin, also called the sower.", recap: "The gardener shares his name.", developments: [], analyzed: true },
    ]);
    await tx.insert(s.progress).values({ bookId, userId: ownerId, completedChapter });
    await tx.insert(s.entities).values([{ bookId, id: "e1", kind: "character" }, { bookId, id: "e2", kind: "character" }]);
    await tx.insert(s.evidence).values([
      { bookId, id: "p1", chapter: 1, quote: "Mara meets the gardener." },
      { bookId, id: "p2", chapter: 2, quote: "The gardener is Orin, also called the sower." },
    ]);
    await tx.insert(s.facts).values([
      { bookId, id: "f1", entityId: "e1", kind: "label", value: "Mara", revealChapter: 1, evidenceId: "p1" },
      { bookId, id: "f2", entityId: "e2", kind: "label", value: "The gardener", revealChapter: 1, evidenceId: "p1" },
      { bookId, id: "f3", entityId: "e2", kind: "label", value: "Orin", revealChapter: 2, evidenceId: "p2" },
      { bookId, id: "f4", entityId: "e2", kind: "alias", value: "The sower", revealChapter: 2, evidenceId: "p2" },
      { bookId, id: "f5", entityId: "e2", kind: "description", value: "The gardener calls himself Orin.", revealChapter: 2, evidenceId: "p2" },
      // An early reveal with later evidence must still stay hidden at chapter 1.
      { bookId, id: "f6", entityId: "e1", kind: "description", value: "Mara knows Orin's name.", revealChapter: 1, evidenceId: "p2" },
    ]);
    await tx.insert(s.relationships).values([
      { bookId, id: "r1", sourceId: "e1", targetId: "e2", label: "meets", revealChapter: 1, evidenceId: "p1" },
      { bookId, id: "r2", sourceId: "e1", targetId: "e2", label: "knows as Orin", revealChapter: 1, evidenceId: "p2" },
    ]);
  });
  return bookId;
}
