import * as s from "../db/schema.js";
import type { KnowledgeReader } from "../knowledge.js";

export const RETRY_DELAYS_MS = [2_000, 10_000, 30_000] as const;
export const failureMessages = {
  extraction_failed: "Source extraction failed. Check the file format and storage.",
  connection_failed: "Analysis could not connect. Check your connection and model access.",
  request_failed: "The model request failed. Check connection, model access and usage limits.",
  invalid_json: "The model returned invalid JSON.",
  validation_failed: "The model returned invalid notes or unsupported citations.",
  interrupted: "The previous model request was interrupted and may have consumed usage.",
  processing_failed: "Processing stopped. Check worker storage and database access.",
} as const;
export type FailureCode = keyof typeof failureMessages;

export async function archiveFailure(tx: KnowledgeReader, part: typeof s.importParts.$inferSelect, error: string) {
  if (!part.attempts) return;
  await tx.insert(s.importFailures).values({ bookId: part.bookId, chapter: part.chapter,
    part: part.part, attempt: part.attempts, error, response: part.response }).onConflictDoNothing();
}
