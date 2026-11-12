import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { db } from "./db/client.js";
import * as s from "./db/schema.js";
import { mergedEntityIds, readPointMerges, readVisibleFacts, type KnowledgeReader, type VisibleFact } from "./knowledge.js";
import { importMode, liveAnalysisProvider } from "./imports/provider.js";
import { availableFrom, mergeBatches, mergePrompt, mockPointMerges, validatePairs } from "./point-merge-analysis.js";
import { defaultAnalysisPreference } from "../shared/ai.js";

async function ownedBook(tx: KnowledgeReader, email: string, bookId: string) {
  const [book] = await tx.select({ ownerId: s.books.ownerId, title: s.books.title })
    .from(s.books).innerJoin(s.user, eq(s.user.id, s.books.ownerId))
    .where(and(eq(s.books.id, bookId), eq(s.user.email, email.trim().toLowerCase())));
  if (!book) throw new Error("Book not found for this owner.");
  return book;
}

type Endpoint = { label: string; fact: VisibleFact };
type Proposal = { first: Endpoint; second: Endpoint; fromChapter: number; reason: string };
type MergePlan = {
  version: 1; ownerId: string; bookId: string; title: string; provider: string; suggestions: (Proposal & { number: number })[];
};

function directory(facts: VisibleFact[]) {
  const byId = new Map(facts.map(f => [f.id, f]));
  const labels = new Map<string, string>(), firstNamed = new Map<string, number>();
  for (const fact of facts) {
    if (fact.factKind !== "label") continue;
    labels.set(fact.entityId, fact.value);
    firstNamed.set(fact.entityId, Math.min(firstNamed.get(fact.entityId) ?? Infinity, availableFrom(fact)));
  }
  return (firstId: string, secondId: string, reason: string): Proposal => {
    const a = byId.get(firstId), b = byId.get(secondId);
    if (!a || !b || a.entityId === b.entityId || a.kind !== b.kind || !labels.has(a.entityId) || !labels.has(b.entityId))
      throw new Error("Missing or incompatible merge endpoints.");
    return {
      first: { label: labels.get(a.entityId)!, fact: a }, second: { label: labels.get(b.entityId)!, fact: b },
      fromChapter: Math.max(availableFrom(a), availableFrom(b), firstNamed.get(a.entityId)!, firstNamed.get(b.entityId)!),
      reason,
    };
  };
}

export async function suggestPointMerges(email: string, bookId: string): Promise<MergePlan> {
  const { book, preference, facts, links } = await db.transaction(async tx => {
    const book = await ownedBook(tx, email, bookId);
    const [saved] = await tx.select().from(s.userAiPreferences).where(eq(s.userAiPreferences.userId, book.ownerId));
    return { book, preference: saved ?? defaultAnalysisPreference, facts: await readVisibleFacts(tx, bookId), links: await readPointMerges(tx, bookId) };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
  const mode = importMode();
  const plan: MergePlan = { version: 1, ...book, bookId, provider: mode, suggestions: [] };
  const ids = mergedEntityIds(facts, links);
  const proposal = directory(facts);
  const seen = new Set<string>();
  let send: Awaited<ReturnType<typeof liveAnalysisProvider>> | undefined;
  let batchNumber = 0;
  for (const batch of mergeBatches(facts)) {
    batchNumber++;
    let response;
    if (mode === "mock") response = mockPointMerges(batch);
    else {
      send ??= await liveAnalysisProvider(book.ownerId, mode, preference);
      response = await send(mergePrompt(batch), 16000, `point-merge-${bookId}`, batchNumber);
    }
    for (const pair of validatePairs(batch, response)) {
      const match = proposal(pair.firstFactId, pair.secondFactId, pair.reason);
      const first = match.first.fact.entityId, second = match.second.fact.entityId;
      const key = JSON.stringify([first, second].sort());
      if (seen.has(key) || (ids.get(first) ?? first) === (ids.get(second) ?? second)) continue;
      seen.add(key);
      plan.suggestions.push({ number: plan.suggestions.length + 1, ...match });
    }
  }
  return plan;
}

export async function applyPointMerges(email: string, bookId: string, plan: MergePlan, selected: number[]) {
  return db.transaction(async tx => {
    const book = await ownedBook(tx, email, bookId);
    if (plan?.version !== 1 || plan.bookId !== bookId || plan.ownerId !== book.ownerId || !Array.isArray(plan.suggestions))
      throw new Error("This plan does not belong to the selected book and owner.");
    if (!selected.length || selected.some(n => !Number.isSafeInteger(n) || n < 1 || n > plan.suggestions.length))
      throw new Error("Select one or more valid suggestion numbers.");
    const proposal = directory(await readVisibleFacts(tx, bookId));
    const values = [...new Set(selected)].map(n => {
      const match = plan.suggestions[n - 1];
      const current = proposal(match?.first?.fact?.id, match?.second?.fact?.id, match?.reason);
      if (!isDeepStrictEqual(match, { number: n, ...current })) throw new Error(`Suggestion ${n} has changed. Generate a fresh plan.`);
      const [firstFactId, secondFactId] = [current.first.fact.id, current.second.fact.id].sort();
      return { bookId, firstFactId, secondFactId };
    });
    // Concurrent overlapping reviews acquire unique-index entries in the same order.
    values.sort((a, b) => a.firstFactId.localeCompare(b.firstFactId) || a.secondFactId.localeCompare(b.secondFactId));
    const inserted = await tx.insert(s.pointMerges).values(values).onConflictDoNothing().returning();
    return inserted.length;
  });
}
