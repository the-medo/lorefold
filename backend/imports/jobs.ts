import { and, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db } from "../db/client.js";
import * as s from "../db/schema.js";
import { defaultAnalysisPreference } from "../../shared/ai.js";
import { importMode } from "./provider.js";
import type { KnowledgeReader } from "../knowledge.js";

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
      await tx.update(s.importJobs).set({ pauseRequested: true, ...(job.status === "queued" ? { status: "paused" as const } : {}), updatedAt: new Date() }).where(eq(s.importJobs.bookId, bookId));
      return;
    }
    if (!["failed", "paused"].includes(job.status)) throw new HTTPException(409, { message: "Analysis is already queued or running." });
    if (!job.retryable) throw new HTTPException(409, { message: "This part has used three attempts. Keep the completed chapters or upload a corrected source." });
    const [{ exhausted }] = await tx.select({ exhausted: sql<number>`count(*)`.mapWith(Number) }).from(s.importParts)
      .where(and(eq(s.importParts.bookId, bookId), eq(s.importParts.status, "failed"), sql`${s.importParts.attempts} >= 3`));
    if (exhausted) throw new HTTPException(409, { message: "This part failed three attempts. Keep the completed chapters and try a corrected source." });
    // Explicit user retry authorizes repeating only an unsuccessful/unknown call.
    await tx.update(s.importParts).set({ status: "pending", response: null, error: null })
      .where(and(eq(s.importParts.bookId, bookId), eq(s.importParts.status, "failed")));
    await tx.update(s.importJobs).set({ status: "queued", pauseRequested: false, error: null, runToken: null, updatedAt: new Date() }).where(eq(s.importJobs.bookId, bookId));
  });
}
