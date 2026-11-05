import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { app } from "../backend/app.js";
import { auth } from "../backend/auth.js";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { db, pool } from "../backend/db/client.js";
import * as s from "../backend/db/schema.js";
import { provisionUser } from "../backend/provision-user.js";
import { uploadResource, createUniverse, universeWorkspace } from "../backend/universes.js";
import { getWorkspace, listBooks, saveProgress } from "../backend/library.js";
import { runNextImport as runWorker, type WorkerOptions } from "../backend/imports/worker.js";
import { controlImport } from "../backend/imports/jobs.js";
import { extractBook, splitParts } from "../backend/imports/extract.js";
import { mockImport, validateImport, IMPORT_VERSION, type ImportRequest } from "../backend/imports/analysis.js";
import { storage } from "../backend/imports/storage.js";
import { combineUniverseGraph } from "../shared/universe-graph.js";
import { syntheticChapters } from "../scripts/book-benchmark/analysis.js";
import type { Resource } from "../shared/contracts.js";

if (!process.env.LOREFOLD_WORKTREE_ID) throw new Error("Use the isolated launcher.");
let owner: string, other: string, universe: string;
const uploaded: Resource[] = [];
let workerConnection: import("pg").PoolClient;
const runNextImport = (options: WorkerOptions = {}) => runWorker({ ...options, connection: workerConnection, bookIds: uploaded.map(r => r.bookId!) });
const source = "Chapter 1\n\nAda carries the brass key to Rowan at the observatory.\n\nChapter 2\n\nRowan opens the observatory dome with Ada.\n\nChapter 3\n\nAda learns Rowan is Leon, her missing brother.";
async function upload(text = source, user = owner, world = universe) {
  const form = new FormData(); form.set("kind", "book"); form.set("title", "Synthetic import");
  form.set("file", new File([text], "story.txt"));
  const resource = await uploadResource(user, world, form); uploaded.push(resource); return resource.bookId!;
}
const job = async (id: string) => (await db.select().from(s.importJobs).where(eq(s.importJobs.bookId, id)))[0];
before(async () => {
  process.env.LOREFOLD_AI_MODE = "mock";
  workerConnection = await pool.connect();
  // Protect this test's fixtures from a preview worker; never claim user imports.
  await workerConnection.query("select pg_advisory_lock(1280266821, 1)");
  owner = await provisionUser(`import-${randomUUID()}@example.test`, randomUUID(), "Import reader");
  other = await provisionUser(`import-${randomUUID()}@example.test`, randomUUID(), "Other reader");
  universe = (await createUniverse(owner, { name: "Test universe" })).id;
});
after(async () => {
  for (const r of uploaded) {
    await rm(join(process.env.LOREFOLD_LOCAL_STORAGE_DIR!, "uploads", r.id), { force: true });
    await rm(join(process.env.LOREFOLD_LOCAL_STORAGE_DIR!, "books", r.bookId!), { recursive: true, force: true });
  }
  for (const id of [owner, other]) if (id) await db.delete(s.user).where(eq(s.user.id, id));
  if (workerConnection) { await workerConnection.query("select pg_advisory_unlock(1280266821, 1)"); workerConnection.release(); }
  await pool.end();
});

test("uploaded book traverses all chapters, persists source and evidence, and respects rewinds", async () => {
  const book = await upload();
  assert.equal((await job(book)).status, "queued");
  await runNextImport();
  assert.equal((await job(book)).status, "complete");
  const listing = (await listBooks(owner)).find(b => b.id === book)!;
  assert.equal(listing.totalChapters, 3); assert.equal(listing.analyzedChapters, 3); assert.equal(listing.completedChapter, 0);
  assert.equal((await getWorkspace(owner, book, 999, "story"))!.graph.entities.length, 0);
  await saveProgress(owner, book, 3);
  const last = (await getWorkspace(owner, book, 3, "story"))!;
  assert.match(last.chapter!.text, /missing brother/); assert.match(last.chapter!.recap, /Leon/);
  assert.ok(last.chapter!.recapEvidence!.length);
  const early = (await getWorkspace(owner, book, 1, "story"))!;
  assert.equal(JSON.stringify(early).includes("Leon"), false);
  assert.ok(early.graph.entities.some(e => e.label === "Ada"));
  assert.ok(early.graph.relationships.length);
  assert.equal(await getWorkspace(other, book, 3, "story"), null);
  assert.equal(await runNextImport(), false);
  const [chapter] = await db.select().from(s.chapters).where(and(eq(s.chapters.bookId, book), eq(s.chapters.number, 1)));
  assert.equal(chapter.text, ""); assert.ok(chapter.textKey);
});

test("failed provider call pauses without replaying completed chapters; explicit resume finishes", async () => {
  const book = await upload(); let calls: number[] = [];
  const provider = async () => async (request: ImportRequest) => { if (request.phase !== "identity") calls.push(request.chapter.number); if (request.chapter.number === 2) throw new Error("sensitive provider text"); return mockImport(request); };
  await runNextImport({ provider });
  assert.deepEqual(calls, [1, 2]); assert.equal((await job(book)).status, "paused");
  assert.equal((await job(book)).error!.includes("sensitive"), false);
  assert.equal(await runNextImport({ provider }), false);
  await assert.rejects(controlImport(other, book, "resume"));
  await controlImport(owner, book, "resume"); calls = [];
  await runNextImport({ provider: async () => async r => { if (r.phase !== "identity") calls.push(r.chapter.number); return mockImport(r); } });
  assert.deepEqual(calls, [2, 3]); assert.equal((await job(book)).completedParts, 6);
});

test("one worker owns inference and a pause request saves the current part before stopping", async () => {
  const book = await upload(); let started!: () => void, finish!: () => void;
  const entered = new Promise<void>(r => { started = r; }), released = new Promise<void>(r => { finish = r; });
  const running = runNextImport({ provider: async () => async r => { started(); await released; return mockImport(r); } });
  await entered;
  assert.equal(await runWorker({ bookIds: [book] }), false);
  await controlImport(owner, book, "pause"); finish(); await running;
  assert.equal((await job(book)).status, "paused"); assert.equal((await job(book)).completedParts, 1);
  await controlImport(owner, book, "resume"); await runNextImport(); assert.equal((await job(book)).status, "complete");
});

test("restart reuses a received response but pauses an in-flight call with unknown billing", async () => {
  const book = await upload(); await controlImport(owner, book, "pause");
  await controlImport(owner, book, "resume");
  await runNextImport({ provider: async () => { throw new Error("no connection"); } });
  const [part] = await db.select().from(s.importParts).where(eq(s.importParts.bookId, book));
  const chapter = JSON.parse((await storage().get(part.sourceKey)).toString());
  const request: ImportRequest = { version: IMPORT_VERSION, chapter, candidates: [] };
  await db.update(s.importParts).set({ status: "received", attempts: 1, request, response: mockImport(request) }).where(and(eq(s.importParts.bookId, book), eq(s.importParts.chapter, 1), eq(s.importParts.part, 1)));
  await db.update(s.importJobs).set({ status: "analyzing" }).where(eq(s.importJobs.bookId, book));
  const calls: number[] = [];
  await runNextImport({ provider: async () => async r => { if (r.phase !== "identity") calls.push(r.chapter.number); return mockImport(r); } });
  assert.deepEqual(calls, [2, 3]);
  const interrupted = await upload();
  await runNextImport({ provider: async () => { throw new Error("no connection"); } });
  await db.update(s.importParts).set({ status: "running", attempts: 1 }).where(and(eq(s.importParts.bookId, interrupted), eq(s.importParts.chapter, 1), eq(s.importParts.part, 1)));
  await db.update(s.importJobs).set({ status: "analyzing" }).where(eq(s.importJobs.bookId, interrupted));
  let invoked = false;
  await runNextImport({ provider: async () => async r => { invoked = true; return mockImport(r); } });
  assert.equal(invoked, false); assert.equal((await job(interrupted)).status, "paused");
  await controlImport(owner, interrupted, "resume"); await runNextImport();
});

test("invalid evidence never publishes a chapter; retry counts are bounded", async () => {
  const book = await upload("Chapter 1\n\nAda carries a brass key to Rowan.");
  const provider = async () => async (r: ImportRequest) => {
    const response = mockImport(r), parsed = JSON.parse(response.text); parsed.analysis.recap[0].evidence[0].quote = "Invented evidence";
    return { ...response, text: JSON.stringify(parsed) };
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await controlImport(owner, book, "resume");
    await runNextImport({ provider }); assert.equal((await job(book)).status, "failed");
  }
  await saveProgress(owner, book, 1);
  const view = (await getWorkspace(owner, book, 1, "story"))!;
  assert.equal(view.chapter, null); assert.equal(view.graph.entities.length, 0);
  await assert.rejects(controlImport(owner, book, "resume"), /three attempts/);
});

test("cross-book candidates are universe/owner scoped and matches are gated at both source cutoffs", async () => {
  const world = (await createUniverse(owner, { name: "Shared world" })).id;
  const first = await upload("Chapter 1\n\nA quiet beginning.\n\nChapter 2\n\nAda carries the brass key to Rowan at the observatory.", owner, world);
  await runNextImport();
  const second = await upload("Chapter 1\n\nAda carries the brass key to Rowan at the observatory.", owner, world);
  let seen: ImportRequest | undefined;
  await runNextImport({ provider: async () => async r => { seen = r; return mockImport(r); } });
  assert.ok(seen!.candidates.length); assert.ok(seen!.candidates.every(c => c.bookId === first));
  await saveProgress(owner, first, 1); await saveProgress(owner, second, 1);
  let view = await universeWorkspace(owner, world);
  assert.equal(view.graph.matches?.length, 0);
  await saveProgress(owner, first, 2); view = await universeWorkspace(owner, world);
  assert.ok(view.graph.matches!.length >= 2);
  const graph = combineUniverseGraph(view.graph);
  assert.equal(graph.entities.filter(e => e.label === "Ada").length, 1);
  const ada = graph.entities.find(e => e.label === "Ada")!;
  assert.deepEqual(new Set(ada.bookIds), new Set([first, second]));
  const filtered = combineUniverseGraph(view.graph, [`book:${first}`]);
  assert.ok(filtered.entities.every(e => e.bookIds.length === 1 && e.bookIds[0] === second));
  await saveProgress(owner, first, 0); assert.equal((await universeWorkspace(owner, world)).graph.matches!.length, 0);
  const foreignWorld = (await createUniverse(other, { name: "Foreign world" })).id;
  await upload("Chapter 1\n\nAda carries the brass key to Rowan at the observatory.", other, foreignWorld);
  await runNextImport({ provider: async () => async r => { assert.deepEqual(r.candidates, []); return mockImport(r); } });
});

test("long chapters retain every character across bounded parts; malformed sources and traversal fail closed", async () => {
  const text = "Ada 🚀 ".repeat(12000);
  const chapters = await extractBook(Buffer.from(text), "large.txt");
  const parts = splitParts(chapters[0]);
  assert.ok(parts.length > 2); assert.equal(parts.flatMap(c => c.paragraphs.map(p => p.text)).join(""), text.trim());
  assert.ok(parts.every(c => c.paragraphs.reduce((n,p) => n + p.text.length, 0) <= 24000));
  await assert.rejects(extractBook(Buffer.from([255, 255]), "invalid.txt"));
  await assert.rejects(extractBook(Buffer.from("PKbad"), "bad.epub"));
  await assert.rejects(storage().get("../foreign"));
  assert.throws(() => storage({ NODE_ENV: "production", LOREFOLD_STORAGE_MODE: "local" }));
});

test("identity validator rejects arbitrary targets, unsupported names and mismatched kinds", () => {
  const request: ImportRequest = { version: IMPORT_VERSION, chapter: syntheticChapters()[0], candidates: [] };
  for (const kind of ["target", "name", "quote"] as const) {
    const result = mockImport(request), parsed = JSON.parse(result.text);
    if (kind === "target") parsed.matches = [{ entityId: parsed.analysis.entities[0].id, candidateId: "foreign-id", evidence: parsed.analysis.entities[0].evidence }];
    if (kind === "name") parsed.analysis.entities[0].label = "Hidden future name";
    if (kind === "quote") parsed.analysis.entities[0].evidence[0].quote = "False quote";
    assert.throws(() => validateImport({ ...result, text: JSON.stringify(parsed) }, request));
  }
});

test("identity pass cannot change notes and extraction never sees other books' evidence", async () => {
  const book = await upload("Chapter 1\n\nAda carries the brass key to Rowan at the observatory.");
  await runNextImport({ provider: async () => async request => {
    if (request.phase !== "identity") assert.ok(request.candidates.every(c => c.bookId === book));
    else {
      assert.ok(request.candidates.every(c => c.bookId !== book));
      const bad = { ...mockImport(request), text: JSON.stringify({ matches: [], analysis: { recap: "Future spoilers" } }) };
      assert.throws(() => validateImport(bad, request), /only return matches/);
    }
    return mockImport(request);
  } });
  assert.equal((await job(book)).status, "complete");
});

test("partially processed long chapters publish no graph or recap", async () => {
  const book = await upload("Chapter 1\n\n" + "Ada carries a brass key to Rowan. ".repeat(1800));
  let calls = 0;
  await runNextImport({ provider: async () => async r => {
    if (r.phase !== "identity" && ++calls === 2) throw new Error("interrupted later part");
    return mockImport(r);
  } });
  assert.equal((await job(book)).status, "paused");
  await saveProgress(owner, book, 1);
  const workspace = (await getWorkspace(owner, book, 1, "story"))!;
  assert.equal(workspace.chapter, null); assert.deepEqual(workspace.graph, { entities: [], relationships: [] });
});


test("import actions authenticate ownership and reject foreign origins and extra fields", async () => {
  const email = `import-control-${randomUUID()}@example.test`, password = randomUUID();
  const id = await provisionUser(email, password, "Control reader");
  try {
    const signed = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    const cookie = signed.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
    const origin = process.env.APP_ORIGIN!;
    const book = await upload("Chapter 1\n\nAda carries a brass key.");
    const call = (headers: Record<string,string>, body: unknown = { action: "pause" }) => app.request(`${origin}/api/books/${book}/import`, {
      method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    assert.equal((await call({})).status, 401);
    assert.equal((await call({ cookie })).status, 404);
    assert.equal((await call({ cookie, origin: "https://foreign.example" })).status, 403);
    assert.equal((await call({ cookie }, { action: "resume", ownerId: owner })).status, 400);
    await runNextImport();
  } finally { await db.delete(s.user).where(eq(s.user.id, id)); }
});
