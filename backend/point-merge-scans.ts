import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db } from "./db/client.js";
import * as s from "./db/schema.js";
import { importMode } from "./imports/provider.js";
import { readVisibleFacts, type KnowledgeReader } from "./knowledge.js";
import { applyReviewedPoints, requireMergeBook, suggestPointMerges, type MergePlan } from "./point-merges.js";
import { defaultAnalysisPreference } from "../shared/ai.js";
import type { MergeSuggestion, PointMergeReview } from "../shared/point-merges.js";

const scans = s.pointMergeScans;

export function queueMergeScan(ownerId: string, bookId: string, previousId: string | null) {
  return db.transaction(async tx => {
    await requireMergeBook(tx, ownerId, bookId);
    const [saved] = await tx.select({ model: s.userAiPreferences.model, effort: s.userAiPreferences.effort })
      .from(s.userAiPreferences).where(eq(s.userAiPreferences.userId, ownerId));
    const next = { bookId, id: randomUUID(), status: "queued" as const, mode: importMode(),
      preference: saved ?? defaultAnalysisPreference, queuedAt: new Date(), applied: 0, plan: null, error: null };
    const insert = tx.insert(scans).values(next);
    if (previousId === null) await insert.onConflictDoNothing();
    else await insert.onConflictDoUpdate({ target: scans.bookId, set: next,
      setWhere: and(eq(scans.id, previousId), notInArray(scans.status, ["queued", "running"])) });
  });
}

// Called only while holding the worker's session advisory lock. A lost request
// can consume model allowance, so interrupted scans can be restarted explicitly.
export async function runNextMergeScan(signal: AbortSignal, bookIds?: string[]) {
  const [job] = await db.select({ scan: scans, ownerId: s.books.ownerId }).from(scans)
    .innerJoin(s.books, eq(s.books.id, scans.bookId))
    .where(and(inArray(scans.status, ["queued", "running"]), bookIds ? inArray(scans.bookId, bookIds) : undefined))
    .orderBy(asc(scans.queuedAt)).limit(1);
  if (!job) return false;
  const { scan, ownerId } = job;
  const current = and(eq(scans.bookId, scan.bookId), eq(scans.id, scan.id), eq(scans.status, "running"));
  if (scan.status === "running") {
    await db.update(scans).set({ status: "failed", error: "Analysis was interrupted. Run it again to get suggestions." }).where(current);
    return true;
  }
  const claimed = await db.update(scans).set({ status: "running" })
    .where(and(eq(scans.bookId, scan.bookId), eq(scans.id, scan.id), eq(scans.status, "queued")))
    .returning({ id: scans.id });
  if (!claimed.length) return true;
  try {
    const plan = await suggestPointMerges(ownerId, scan.bookId, scan.mode, scan.preference, signal);
    await db.update(scans).set({ status: "ready", plan }).where(current);
  } catch {
    await db.update(scans).set({ status: "failed",
      error: "Analysis could not finish. Check your AI connection and usage limits, then try again." }).where(current);
  }
  return true;
}

async function reviewSuggestions(tx: KnowledgeReader, ownerId: string, bookId: string, plan: MergePlan, chapter?: number) {
  if (!plan.suggestions.length) return [];
  const [progress] = await tx.select({ chapter: s.progress.completedChapter }).from(s.progress)
    .where(and(eq(s.progress.bookId, bookId), eq(s.progress.userId, ownerId)));
  const cutoff = Math.min(chapter ?? Infinity, progress?.chapter ?? 0);
  const facts = await readVisibleFacts(tx, bookId, cutoff);
  const names = new Map(facts.filter(f => f.factKind === "label").map(f => [f.entityId, f.value]));
  const byId = new Map(facts.map(f => [f.id, f]));
  const suggestions: MergeSuggestion[] = [];
  for (const pair of plan.suggestions) {
    const first = byId.get(pair.first.fact.id), second = byId.get(pair.second.fact.id);
    if (!first || !second || pair.fromChapter > cutoff) continue;
    const firstName = names.get(first.entityId), secondName = names.get(second.entityId);
    if (!firstName || !secondName) continue;
    suggestions.push({ number: pair.number,
      first: { name: firstName, chapter: first.evidence.chapter, quote: first.evidence.quote },
      second: { name: secondName, chapter: second.evidence.chapter, quote: second.evidence.quote },
      // The free-text reason can reference any point the model saw across the book.
      reason: cutoff >= (plan.throughChapter ?? Infinity) ? pair.reason : undefined });
  }
  return suggestions;
}

export function getMergeReview(ownerId: string, bookId: string, chapter?: number): Promise<PointMergeReview> {
  return db.transaction(async tx => {
    const { title: bookTitle } = await requireMergeBook(tx, ownerId, bookId);
    const [row] = await tx.select().from(scans).where(eq(scans.bookId, bookId));
    const nextMode = importMode();
    if (!row) return { bookTitle, nextMode, scan: null };
    const suggestions = row.plan ? await reviewSuggestions(tx, ownerId, bookId, row.plan, chapter) : [];
    return { bookTitle, nextMode, scan: { id: row.id, status: row.status, mode: row.mode, error: row.error, applied: row.applied,
      suggestions, later: (row.plan?.suggestions.length ?? 0) - suggestions.length } };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export function mergeFromScan(ownerId: string, bookId: string, id: string, skip: number[], includeLater: boolean, chapter?: number) {
  return db.transaction(async tx => {
    await requireMergeBook(tx, ownerId, bookId);
    const [scan] = await tx.select().from(scans).where(eq(scans.bookId, bookId)).for("update");
    if (!scan || scan.id !== id) throw new HTTPException(409, { message: "The analysis has changed. Reopen the review." });
    if (scan.status === "applied") return scan.applied;
    if (scan.status !== "ready" || !scan.plan) throw new HTTPException(409, { message: "Analysis is not ready yet." });
    const candidates = includeLater ? scan.plan.suggestions : await reviewSuggestions(tx, ownerId, bookId, scan.plan, chapter);
    const excluded = new Set(skip);
    const selected = candidates.map(p => p.number).filter(n => !excluded.has(n));
    if (!selected.length) throw new HTTPException(400, { message: "Select a suggested merge." });
    const applied = await applyReviewedPoints(tx, ownerId, bookId, scan.plan, selected);
    await tx.update(scans).set({ status: "applied", applied, plan: null }).where(eq(scans.bookId, bookId));
    return applied;
  });
}
