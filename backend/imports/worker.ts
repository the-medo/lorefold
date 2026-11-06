import type { PoolClient } from "pg";
import { randomUUID, createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import * as s from "../db/schema.js";
import { extractBook, splitParts } from "./extract.js";
import { storage, type Storage } from "./storage.js";
import { importProvider } from "./provider.js";
import { IMPORT_VERSION, validateImport, type Candidate, type ImportRequest, type ImportAnalysis } from "./analysis.js";
import type { Chapter } from "../../scripts/book-benchmark/source.js";
import type { Evidence } from "../../scripts/book-benchmark/analysis.js";
import type { ProviderResult } from "../../scripts/book-benchmark/provider.js";
import type { KnowledgeReader } from "../knowledge.js";
import type { AnalysisPreference } from "../../shared/ai.js";
import { archiveFailure, failureMessages, RETRY_DELAYS_MS, type FailureCode } from "./retry.js";

type Job = typeof s.importJobs.$inferSelect;
type Part = typeof s.importParts.$inferSelect;
export type WorkerOptions = { signal?: AbortSignal; store?: Storage;
  connection?: PoolClient; bookIds?: string[];
  now?: () => Date;
  provider?: (ownerId: string, job: Job) => Promise<(request: ImportRequest) => Promise<ProviderResult>> };
const key = (bookId: string, chapter: number, part: number) => and(eq(s.importParts.bookId, bookId), eq(s.importParts.chapter, chapter), eq(s.importParts.part, part));
const partVersion = (chapter: number, part: number) => `${IMPORT_VERSION}:${chapter}:${String(part).padStart(6, "0")}`;
const stableId = (text: string) => createHash("sha256").update(text).digest("hex");
async function fence(tx: KnowledgeReader, bookId: string, token: string) {
  const [job] = await tx.select().from(s.importJobs).where(eq(s.importJobs.bookId, bookId)).for("update");
  if (!job || job.runToken !== token) throw new Error("Import ownership changed.");
  return job;
}
async function changeJob(bookId: string, token: string, values: Partial<typeof s.importJobs.$inferInsert>) {
  await db.transaction(async tx => { await fence(tx, bookId, token); await tx.update(s.importJobs).set({ ...values, updatedAt: new Date() }).where(eq(s.importJobs.bookId, bookId)); });
}
class ImportFailure extends Error {
  constructor(readonly code: FailureCode) { super(failureMessages[code]); }
}
async function failJob(bookId: string, token: string, code: FailureCode, part: Part | undefined, stopped: boolean, now: Date) {
  await db.transaction(async tx => {
    const job = await fence(tx, bookId, token);
    if (part) {
      const [saved] = await tx.select().from(s.importParts).where(key(bookId, part.chapter, part.part));
      if (saved && saved.status !== "complete") {
        // A persistence error must reuse a received response, never repeat a successful call.
        const discard = ["invalid_json", "validation_failed", "request_failed", "interrupted"].includes(code)
          || (saved.status === "running" && !saved.response);
        if (discard) {
          await archiveFailure(tx, saved, code);
          await tx.update(s.importParts).set({ status: "failed", error: code }).where(key(bookId, part.chapter, part.part));
        }
      }
    }
    const paused = stopped || job.pauseRequested;
    const delay = RETRY_DELAYS_MS[job.retryCount];
    const retry = !paused && delay !== undefined;
    const reason = `${part ? `Chapter ${part.chapter}: ` : ""}${failureMessages[code]}`;
    await tx.update(s.importJobs).set({ status: retry ? "queued" : "paused", retryable: true,
      retryCount: retry ? job.retryCount + 1 : job.retryCount,
      nextRetryAt: retry ? new Date(now.getTime() + delay) : null,
      error: `${reason} ${retry ? `Automatic retry ${job.retryCount + 1} of ${RETRY_DELAYS_MS.length} scheduled.`
        : paused ? "Analysis paused; resume when ready. Completed work is kept."
        : "Automatic retries are exhausted. Resume analysis to try again; completed work is kept."}`,
      updatedAt: new Date(),
    }).where(eq(s.importJobs.bookId, bookId));
  });
}
async function prepare(job: Job, token: string, store: Storage, signal?: AbortSignal) {
  const [resource] = await db.select().from(s.resources).where(eq(s.resources.id, job.resourceId));
  if (!resource || resource.bookId !== job.bookId) throw new Error("Source missing.");
  const chapters = await extractBook(await store.get(`uploads/${resource.storageKey}`, 25 * 1024 * 1024), resource.filename, signal);
  const rows: typeof s.chapters.$inferInsert[] = [], parts: typeof s.importParts.$inferInsert[] = [];
  for (const chapter of chapters) {
    const textKey = `books/${job.bookId}/${chapter.number}/text`;
    await store.put(textKey, Buffer.from(chapter.paragraphs.map(p => p.text).join("\n\n")));
    rows.push({ bookId: job.bookId, number: chapter.number, title: chapter.title, text: "", textKey, recap: "", developments: [] });
    for (const [index, part] of splitParts(chapter).entries()) {
      const sourceKey = `books/${job.bookId}/${chapter.number}/${index + 1}.json`;
      await store.put(sourceKey, Buffer.from(JSON.stringify({ ...part, source: job.bookId })));
      parts.push({ bookId: job.bookId, chapter: chapter.number, part: index * 2 + 1, sourceKey, phase: "analysis" });
      parts.push({ bookId: job.bookId, chapter: chapter.number, part: index * 2 + 2, sourceKey, phase: "identity" });
    }
  }
  if (parts.length > 4000) throw new Error("Too many analysis parts.");
  await db.transaction(async tx => {
    await fence(tx, job.bookId, token);
    for (const row of rows) await tx.insert(s.chapters).values(row).onConflictDoNothing();
    for (const part of parts) await tx.insert(s.importParts).values(part).onConflictDoNothing();
    await tx.update(s.importJobs).set({ status: "analyzing", totalParts: parts.length, retryCount: 0,
      nextRetryAt: null, error: null, updatedAt: new Date() }).where(eq(s.importJobs.bookId, job.bookId));
  });
}
async function candidates(bookId: string, chapter: Chapter, phase: "analysis" | "identity"): Promise<Candidate[]> {
  const [book] = await db.select().from(s.books).where(eq(s.books.id, bookId));
  if (!book?.universeId) return [];
  const rows = await db.select({ bookId: s.books.id, entityId: s.entities.id, kind: s.entities.kind,
    label: s.facts.value, chapter: s.facts.revealChapter, evidenceId: s.evidence.id, quote: s.evidence.quote })
    .from(s.books).innerJoin(s.entities, eq(s.entities.bookId, s.books.id))
    .innerJoin(s.facts, and(eq(s.facts.bookId, s.books.id), eq(s.facts.entityId, s.entities.id)))
    .innerJoin(s.evidence, and(eq(s.evidence.bookId, s.facts.bookId), eq(s.evidence.id, s.facts.evidenceId)))
    .where(and(eq(s.books.universeId, book.universeId), eq(s.books.ownerId, book.ownerId), phase === "analysis" ? eq(s.books.id, bookId) : ne(s.books.id, bookId), inArray(s.facts.kind, ["label", "alias"])))
    .orderBy(asc(s.books.createdAt), asc(s.facts.revealChapter), asc(s.facts.id));
  const text = chapter.paragraphs.map(p => p.text).join(" ").toLowerCase();
  const score = (c: typeof rows[number]) => (text.includes(c.label.toLowerCase()) ? 4 : 0) + (c.bookId === bookId ? 2 : 0);
  rows.sort((a,b) => score(b) - score(a));
  const result: Candidate[] = []; const seen = new Set<string>(); let size = 0;
  for (const row of rows) {
    const identity = `${row.bookId}:${row.entityId}`;
    if (seen.has(identity) || row.quote.length > 1200) continue;
    const c = { ...row, id: `c${result.length + 1}` }; const length = JSON.stringify(c).length;
    if (size + length > 48000 || result.length >= 100) break;
    size += length; seen.add(identity); result.push(c);
  }
  return result;
}
async function persist(part: Part, request: ImportRequest, result: ImportAnalysis, token: string) {
  const bookId = part.bookId, version = partVersion(part.chapter, part.part);
  await db.transaction(async tx => {
    await fence(tx, bookId, token);
    const proof = async (evidence: Evidence[]) => {
      let first = "";
      for (const e of evidence) {
        const id = stableId(`${bookId}:${e.chapter}:${e.paragraphId}:${e.quote}`);
        await tx.insert(s.evidence).values({ bookId, id, chapter: e.chapter, quote: e.quote }).onConflictDoNothing();
        first ||= id;
      }
      return first;
    };
    const ids = new Map<string, string>(); const used = new Set<string>();
    for (const e of result.analysis.entities) {
      const match = result.matches.find(m => m.entityId === e.id);
      const candidate = match && request.candidates.find(c => c.id === match.candidateId);
      const id = part.phase === "identity" ? request.entityIds![e.id] : candidate?.bookId === bookId ? candidate.entityId : stableId(`${version}:${e.id}`);
      if (used.has(id)) throw new Error("Multiple entities map to the same identity.");
      used.add(id); ids.set(e.id, id);
      if (part.phase === "analysis") {
        await tx.insert(s.entities).values({ bookId, id, kind: e.kind as import("../../shared/contracts.js").EntityKind }).onConflictDoNothing();
        await tx.insert(s.appearances).values({ bookId, entityId: id, chapter: part.chapter }).onConflictDoNothing();
        const claims = [{ kind: "label" as const, text: e.label, evidence: e.evidence }, ...e.aliases.map(c => ({ ...c, kind: "alias" as const })), ...e.facts.map(c => ({ ...c, kind: "description" as const }))];
        for (const [index, claim] of claims.entries()) await tx.insert(s.facts).values({ bookId, id: `${version}:${e.id}:${index}`, entityId: id,
          kind: claim.kind, value: claim.text, revealChapter: part.chapter, evidenceId: await proof(claim.evidence), extractionVersion: IMPORT_VERSION });
      }
      if (part.phase === "identity" && candidate && match && candidate.bookId !== bookId) {
        // Recheck both sides' owner/universe membership; never trust model IDs.
        const [other] = await tx.select().from(s.books).where(eq(s.books.id, candidate.bookId));
        const [own] = await tx.select().from(s.books).where(eq(s.books.id, bookId));
        if (!other || !own || other.ownerId !== own.ownerId || !own.universeId || other.universeId !== own.universeId) throw new Error("Identity scope changed.");
        await tx.insert(s.entityMatches).values({ id: `${bookId}:${version}:${e.id}`, bookId, entityId: id, chapter: part.chapter,
          evidenceId: await proof(match.evidence), otherBookId: candidate.bookId, otherEntityId: candidate.entityId,
          otherChapter: candidate.chapter, otherEvidenceId: candidate.evidenceId });
      }
    }
    if (part.phase === "analysis") for (const [index, r] of result.analysis.relationships.entries()) await tx.insert(s.relationships).values({
      bookId, id: `${version}:r${index}`, sourceId: ids.get(r.source)!, targetId: ids.get(r.target)!, label: r.text,
      revealChapter: part.chapter, evidenceId: await proof(r.evidence), extractionVersion: IMPORT_VERSION });
    const [chapter] = await tx.select().from(s.chapters).where(and(eq(s.chapters.bookId, bookId), eq(s.chapters.number, part.chapter)));
    if (part.phase === "analysis") for (const claim of result.analysis.recap) await proof(claim.evidence);
    const recapEvidence = [...chapter.recapEvidence, ...(part.phase === "identity" ? [] : result.analysis.recap.map(c => ({ text: c.text, evidence: c.evidence.map(e => ({ chapter: e.chapter, quote: e.quote })) })))];
    await tx.update(s.importParts).set({ status: "complete", error: null }).where(key(bookId, part.chapter, part.part));
    const remaining = await tx.select().from(s.importParts).where(and(eq(s.importParts.bookId, bookId), eq(s.importParts.chapter, part.chapter), ne(s.importParts.status, "complete")));
    await tx.update(s.chapters).set({ recap: recapEvidence.map(c => c.text).join("\n\n"), developments: recapEvidence.map(c => c.text), recapEvidence,
      analyzed: !remaining.length }).where(and(eq(s.chapters.bookId, bookId), eq(s.chapters.number, part.chapter)));
    await tx.update(s.importJobs).set({ completedParts: sql`${s.importJobs.completedParts} + 1`,
      retryCount: 0, nextRetryAt: null, error: null, updatedAt: new Date() }).where(eq(s.importJobs.bookId, bookId));
  });
}

/** The database advisory lock enforces one import across every worker process. */
export async function runNextImport(options: WorkerOptions = {}): Promise<boolean> {
  const now = options.now ?? (() => new Date());
  const connection = options.connection ?? await pool.connect(); const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
  const lost = () => controller.abort(); connection.on("error", lost);
  let locked = false;
  try {
    const result = await connection.query("select pg_try_advisory_lock(1280266821, 1) as locked");
    locked = result.rows[0].locked; if (!locked) return false;
    const [job] = await db.select().from(s.importJobs).where(and(inArray(s.importJobs.status, ["queued", "extracting", "analyzing"]),
      or(isNull(s.importJobs.nextRetryAt), lte(s.importJobs.nextRetryAt, now())),
      options.bookIds ? inArray(s.importJobs.bookId, options.bookIds) : undefined))
      .orderBy(asc(s.importJobs.createdAt)).limit(1);
    if (!job || signal.aborted) return false;
    const token = randomUUID();
    await db.update(s.importJobs).set({ runToken: token, status: job.totalParts ? "analyzing" : "extracting",
      nextRetryAt: null, updatedAt: new Date() }).where(eq(s.importJobs.bookId, job.bookId));
    let activePart: Part | undefined;
    try {
      const store = options.store ?? storage();
      if (!job.totalParts) {
        try { await prepare(job, token, store, signal); }
        catch { throw new ImportFailure("extraction_failed"); }
      }
      const [owner] = await db.select().from(s.books).where(eq(s.books.id, job.bookId));
      const parts = await db.select().from(s.importParts).where(and(eq(s.importParts.bookId, job.bookId), ne(s.importParts.status, "complete"))).orderBy(asc(s.importParts.chapter), asc(s.importParts.part));
      let provider: ((r: ImportRequest) => Promise<ProviderResult>) | undefined;
      for (const part of parts) {
        activePart = part;
        const [current] = await db.select().from(s.importJobs).where(eq(s.importJobs.bookId, job.bookId));
        if (signal.aborted || current.pauseRequested) { await changeJob(job.bookId, token, { status: "paused", retryable: true }); return true; }
        if (part.status === "running" && !part.response) {
          throw new ImportFailure("interrupted");
        }
        if (part.status === "failed") {
          await db.transaction(async tx => { await fence(tx, job.bookId, token);
            await archiveFailure(tx, part, part.error ?? "processing_failed");
            await tx.update(s.importParts).set({ status: "pending", response: null, error: null }).where(key(job.bookId, part.chapter, part.part)); });
          part.response = null;
        }
        const chapter: Chapter = JSON.parse((await store.get(part.sourceKey)).toString("utf8"));
        let request = part.request;
        if (!request) {
          request = { version: IMPORT_VERSION, chapter, candidates: await candidates(job.bookId, chapter, part.phase), phase: part.phase };
          if (part.phase === "identity") {
            const [previous] = await db.select().from(s.importParts).where(key(job.bookId, part.chapter, part.part - 1));
            if (previous.status !== "complete" || !previous.response || !previous.request) throw new Error("Missing extraction checkpoint.");
            const extraction = validateImport(previous.response, previous.request);
            request.analysis = extraction.analysis;
            request.entityIds = Object.fromEntries(extraction.analysis.entities.map(e => {
              const match = extraction.matches.find(m => m.entityId === e.id);
              const candidate = match && previous.request!.candidates.find(c => c.id === match.candidateId);
              return [e.id, candidate?.bookId === job.bookId ? candidate.entityId : stableId(`${partVersion(part.chapter, previous.part)}:${e.id}`)];
            }));
          }
        }
        if (request.version !== IMPORT_VERSION) throw new Error("Import version changed.");
        let response = part.response;
        if (!response) {
          try {
            if (part.phase !== "identity" || (request.candidates.length && request.analysis!.entities.length)) provider ??= options.provider ? await options.provider(owner.ownerId, job) : await importProvider(owner.ownerId, job.mode,
              { model: job.model, effort: job.effort } as AnalysisPreference, signal);
          } catch { throw new ImportFailure("connection_failed"); }
          await db.transaction(async tx => { await fence(tx, job.bookId, token);
            await tx.update(s.importParts).set({ status: "running", request, attempts: part.attempts + 1 }).where(key(job.bookId, part.chapter, part.part)); });
          try {
            signal.throwIfAborted(); response = part.phase === "identity" && (!request.candidates.length || !request.analysis!.entities.length)
              ? { text: '{"matches":[]}', usage: null, reportedModel: "no-matching-candidates", truncated: false }
              : await provider!(request);
          } catch {
            throw new ImportFailure("request_failed");
          }
          await db.transaction(async tx => { await fence(tx, job.bookId, token);
            await tx.update(s.importParts).set({ status: "received", response }).where(key(job.bookId, part.chapter, part.part));
            await tx.update(s.importJobs).set({ inputTokens: sql`${s.importJobs.inputTokens} + ${response!.usage?.inputTokens ?? 0}`,
              outputTokens: sql`${s.importJobs.outputTokens} + ${response!.usage?.outputTokens ?? 0}` }).where(eq(s.importJobs.bookId, job.bookId)); });
        }
        let analysis: ImportAnalysis;
        try { analysis = validateImport(response, request); }
        catch (error) { throw new ImportFailure(error instanceof SyntaxError ? "invalid_json" : "validation_failed"); }
        await persist(part, request, analysis, token);
      }
      await changeJob(job.bookId, token, { status: "complete", error: null, retryCount: 0, nextRetryAt: null });
    } catch (error) {
      // If the database is unavailable, the last durable checkpoint remains for the next worker run.
      await failJob(job.bookId, token, error instanceof ImportFailure ? error.code : "processing_failed",
        activePart, signal.aborted, now());
    }
    return true;
  } finally {
    if (locked) await connection.query("select pg_advisory_unlock(1280266821, 1)").catch(() => {});
    connection.off("error", lost); if (!options.connection) connection.release();
  }
}
