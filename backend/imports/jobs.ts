import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db } from "../db/client.js";
import * as s from "../db/schema.js";
import { defaultAnalysisPreference } from "../../shared/ai.js";
import { importMode } from "./provider.js";
import type { KnowledgeReader } from "../knowledge.js";
import { archiveFailure } from "./retry.js";

export async function enqueueImport(tx: KnowledgeReader, ownerId: string, bookId: string, resourceId: string) {
  const [preference] = await tx.select().from(s.userAiPreferences).where(eq(s.userAiPreferences.userId, ownerId));
  await tx.insert(s.importJobs).values({ bookId, resourceId, mode: importMode(),
    model: preference?.model ?? defaultAnalysisPreference.model, effort: preference?.effort ?? defaultAnalysisPreference.effort });
}
export async function controlImport(ownerId: string, bookId: string, action: "pause" | "resume") {
  return db.transaction(async tx => {
    const [book] = await tx.select().from(s.books).where(and(eq(s.books.id, bookId), eq(s.books.ownerId, ownerId)));
    if (!book) throw new HTTPException(404, { message: "Book not found." });
    let [job] = await tx.select().from(s.importJobs).where(eq(s.importJobs.bookId, bookId)).for("update");
    if (!job) {
      if (action !== "resume") throw new HTTPException(409, { message: "There is no import to pause." });
      const [resource] = await tx.select().from(s.resources).where(eq(s.resources.bookId, bookId));
      if (!resource) throw new HTTPException(409, { message: "Upload a source file first." });
      await enqueueImport(tx, ownerId, bookId, resource.id); return;
    }
    if (job.status === "complete") throw new HTTPException(409, { message: "This book is already analyzed." });
    if (action === "pause") {
      await tx.update(s.importJobs).set({ pauseRequested: true, ...(job.status === "queued" ? { status: "paused" as const, nextRetryAt: null } : {}), updatedAt: new Date() }).where(eq(s.importJobs.bookId, bookId));
      return;
    }
    if (!["failed", "paused"].includes(job.status)) throw new HTTPException(409, { message: "Analysis is already queued or running." });
    const failed = await tx.select().from(s.importParts)
      .where(and(eq(s.importParts.bookId, bookId), eq(s.importParts.status, "failed")));
    for (const part of failed) await archiveFailure(tx, part, part.error ?? "processing_failed");
    // A new retry allowance never erases lifetime attempts or replays completed parts.
    // This also recovers jobs exhausted under the previous permanent three-attempt cap.
    await tx.update(s.importParts).set({ status: "pending", response: null, error: null })
      .where(and(eq(s.importParts.bookId, bookId), eq(s.importParts.status, "failed")));
    await tx.update(s.importJobs).set({ status: "queued", pauseRequested: false, error: null,
      retryable: true, retryCount: 0, nextRetryAt: null, runToken: null, updatedAt: new Date() }).where(eq(s.importJobs.bookId, bookId));
  });
}
