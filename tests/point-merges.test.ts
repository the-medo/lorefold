import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "../backend/db/client.js";
import * as s from "../backend/db/schema.js";
import { getWorkspace } from "../backend/library.js";
import { universeWorkspace } from "../backend/universes.js";
import { readVisibleFacts } from "../backend/knowledge.js";
import { applyPointMerges, suggestPointMerges } from "../backend/point-merges.js";
import { mergeBatches, validatePairs, mockPointMerges } from "../backend/point-merge-analysis.js";
import { getMergeReview, mergeFromScan, queueMergeScan } from "../backend/point-merge-scans.js";
import { runNextImport } from "../backend/imports/worker.js";
import { seedMapBook } from "./universe-map-fixture.js";

if (!process.env.LOREFOLD_WORKTREE_ID) throw new Error("Use the worktree launcher.");
const ownerId = randomUUID(), email = `merge-${ownerId}@example.test`, universeId = randomUUID();
let bookId: string, otherBook: string;
before(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
  await db.insert(s.user).values({ id: ownerId, email, name: "Merge reader" });
  await db.insert(s.universes).values({ id: universeId, ownerId, name: "Merge test" });
  bookId = await seedMapBook(ownerId, universeId, 3);
  otherBook = await seedMapBook(ownerId, universeId);
  await db.insert(s.chapters).values([
    { bookId, number: 3, title: "A signature", text: "Orin Vale signed as Captain Orin.", recap: "", developments: [], analyzed: true },
    { bookId, number: 4, title: "Incomplete", text: "Unvalidated name.", recap: "", developments: [], analyzed: false },
  ]);
  await db.update(s.chapters).set({ text: "Mara meets the gardener. A traveler came to the orchard." })
    .where(and(eq(s.chapters.bookId, bookId), eq(s.chapters.number, 1)));
  await db.update(s.chapters).set({ text: "The gardener is Orin, also called the sower. The traveler called himself Captain Orin, the gardener." })
    .where(and(eq(s.chapters.bookId, bookId), eq(s.chapters.number, 2)));
  await db.insert(s.entities).values(["captain", "signer", "unfinished"].map(id => ({ bookId, id, kind: "character" as const })));
  await db.insert(s.evidence).values([
    { bookId, id: "arrival", chapter: 1, quote: "A traveler came to the orchard." },
    { bookId, id: "captain-name", chapter: 2, quote: "The traveler called himself Captain Orin, the gardener." },
    { bookId, id: "signature", chapter: 3, quote: "Orin Vale signed as Captain Orin." },
    { bookId, id: "partial", chapter: 4, quote: "Unvalidated name." },
  ]);
  await db.insert(s.facts).values([
    { bookId, id: "arrival", entityId: "captain", kind: "label", value: "A traveler", evidenceId: "arrival", revealChapter: 1 },
    { bookId, id: "captain-name", entityId: "captain", kind: "label", value: "Captain Orin", evidenceId: "captain-name", revealChapter: 2 },
    { bookId, id: "signature", entityId: "signer", kind: "label", value: "Orin Vale", evidenceId: "signature", revealChapter: 3 },
    { bookId, id: "partial", entityId: "unfinished", kind: "label", value: "Unvalidated name", evidenceId: "partial", revealChapter: 1 },
  ]);
  await db.insert(s.appearances).values({ bookId, entityId: "signer", chapter: 3 });
  await db.insert(s.relationships).values({ bookId, id: "reported-alias", sourceId: "captain", targetId: "e2", label: "is called", revealChapter: 2, evidenceId: "captain-name" });
  await db.insert(s.entityMatches).values({ id: randomUUID(), bookId, entityId: "signer", chapter: 3, evidenceId: "signature",
    otherBookId: otherBook, otherEntityId: "e2", otherChapter: 2, otherEvidenceId: "p2" });
});
after(async () => {
  try { await db.delete(s.user).where(eq(s.user.id, ownerId)); } finally { await pool.end(); }
});

test("AI batches cover nonadjacent points and validate both citations within their batch", async () => {
  const facts = await db.transaction(tx => readVisibleFacts(tx, bookId));
  assert.ok(!facts.some(f => f.entityId === "unfinished"));
  const batches = [...mergeBatches(facts, 1)];
  assert.equal(batches.length, 6); // Four named points, all six unordered pairs.
  const batch = batches.find(b => b.points[0].id === "captain" && b.compareWith?.[0].id === "e2" ||
    b.points[0].id === "e2" && b.compareWith?.[0].id === "captain")!;
  const result = mockPointMerges(batch);
  assert.equal(validatePairs(batch, result).length, 1);
  for (const [firstFactId, secondFactId] of [["captain-name", "missing"], ["captain-name", "signature"], ["arrival", "captain-name"]]) {
    assert.throws(() => validatePairs(batch, { ...result, text: JSON.stringify({ pairs: [{ firstFactId, secondFactId, reason: "test" }] }) }));
  }
  assert.throws(() => validatePairs(batch, { ...result, truncated: true }));
});

test("configured gateway receives book-local points, names, facts and evidence", async t => {
  t.mock.property(process, "env", { ...process.env, LOREFOLD_AI_MODE: "gateway", LOREFOLD_IMPORT_LIVE: "1",
    CLOUDFLARE_ACCOUNT_ID: "0".repeat(32), CLOUDFLARE_AI_GATEWAY_ID: "fixture", CLOUDFLARE_API_TOKEN: "synthetic" });
  let sent = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    assert.match(body.instructions, /untrusted book data/);
    assert.match(body.input, /The sower/);
    assert.match(body.input, /The gardener calls himself Orin/);
    assert.doesNotMatch(body.input, /Unvalidated name/);
    sent++;
    const text = JSON.stringify({ pairs: [{ firstFactId: "f3", secondFactId: "captain-name", reason: "The captain identifies himself as the gardener." }] });
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }] });
  });
  const plan = await suggestPointMerges(ownerId, bookId);
  assert.equal(sent, 1);
  assert.equal(plan.provider, "gateway");
  assert.equal(plan.suggestions[0].fromChapter, 2);
  assert.equal(plan.suggestions[0].second.fact.evidence.quote, "The traveler called himself Captain Orin, the gardener.");
});

test("a saved whole-book scan can be applied from an earlier chapter without exposing later evidence", async t => {
  t.mock.property(process, "env", { ...process.env, LOREFOLD_AI_MODE: "mock" });
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(1280266821, 1)");
    await Promise.all([queueMergeScan(ownerId, bookId, null), queueMergeScan(ownerId, bookId, null)]);
    const queued = (await getMergeReview(ownerId, bookId)).scan!;
    assert.equal(queued.status, "queued");
    // Recover a lost worker without automatically spending allowance again.
    await db.update(s.pointMergeScans).set({ status: "running" }).where(eq(s.pointMergeScans.bookId, bookId));
    const work = () => runNextImport({ connection: client, bookIds: [bookId] });
    await work();
    assert.equal((await getMergeReview(ownerId, bookId)).scan!.status, "failed");
    await queueMergeScan(ownerId, bookId, queued.id);
    await work();
    const review = (await getMergeReview(ownerId, bookId, 2)).scan!;
    assert.equal(review.suggestions.length, 1);
    assert.equal(review.suggestions[0].reason, undefined);
    assert.equal(review.later, 1);
    assert.doesNotMatch(JSON.stringify(review), /Orin Vale|signature/);
    await assert.rejects(mergeFromScan(ownerId, bookId, queued.id, [], true, 1), /changed/);
    await assert.rejects(mergeFromScan(ownerId, bookId, review.id, [], false, 1), /Select/);
    const hidden = (await getMergeReview(ownerId, bookId, 1)).scan!;
    assert.equal(hidden.suggestions.length, 0);
    assert.equal(hidden.later, 2);
    const before = (await getWorkspace(ownerId, bookId, 1, "story"))!.graph;
    const applyAll = () => mergeFromScan(ownerId, bookId, review.id, [], true, 1);
    assert.deepEqual(await Promise.all([applyAll(), applyAll()]), [2, 2]);
    assert.deepEqual((await getWorkspace(ownerId, bookId, 1, "story"))!.graph, before);
    assert.equal((await getMergeReview(ownerId, bookId)).scan!.status, "applied");
  } finally {
    await client.query("select pg_advisory_unlock(1280266821, 1)");
    client.release();
    await db.delete(s.pointMerges).where(eq(s.pointMerges.bookId, bookId));
  }
});

test("CLI suggests, reviews, and applies same-book duplicates across chapter and universe views", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lorefold-point-merge-"));
  const file = join(dir, "plan.json");
  const cli = (action: string, ...args: string[]) => execFileSync(process.execPath, ["--import", "tsx", "scripts/point-merge.ts", action,
    "--owner", email, "--book", bookId, "--plan", file, ...args], { encoding: "utf8", env: { ...process.env, LOREFOLD_AI_MODE: "mock" } });
  const graph = async (chapter: number, mode: "chapter" | "story" = "story") => (await getWorkspace(ownerId, bookId, chapter, mode))!.graph;
  try {
    assert.match(cli("suggest"), /2 suggestion\(s\) from mock/);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const plan: Awaited<ReturnType<typeof suggestPointMerges>> = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(plan.suggestions.map(m => m.fromChapter).sort(), [2, 3]);
    assert.deepEqual((await graph(3)).entities.map(e => e.id).sort(), ["captain", "e1", "e2", "signer"]);
    const early = await graph(1);
    assert.doesNotMatch(JSON.stringify(early), /Orin|Unvalidated/);

    await assert.rejects(applyPointMerges("missing@example.test", bookId, plan, [1]), /owner/);
    await assert.rejects(applyPointMerges(ownerId, otherBook, plan, [1]), /selected book/);
    const stale = structuredClone(plan);
    stale.suggestions[1].second.fact.evidence.quote = "Replaced evidence";
    await assert.rejects(applyPointMerges(ownerId, bookId, stale, [1, 2]), /changed/);
    assert.equal((await graph(3)).entities.length, 4);

    const earlier = plan.suggestions.find(m => m.fromChapter === 2)!.number;
    assert.match(cli("apply", "--accept", String(earlier)), /Applied 1 new/);
    assert.equal((await graph(3)).entities.length, 3);
    assert.match(cli("apply", "--accept", "1,2"), /Applied 1 new/);
    assert.match(cli("apply", "--accept", "1,2"), /Applied 0 new/);
    assert.deepEqual(await graph(1), early);
    assert.doesNotMatch(JSON.stringify(await graph(2)), /Orin Vale/);
    const complete = await graph(3);
    assert.equal(complete.entities.length, 2);
    const merged = complete.entities.find(e => e.label === "Orin Vale")!;
    assert.ok(merged.aliases.includes("Captain Orin") && merged.aliases.includes("Orin") && merged.aliases.includes("The sower"));
    assert.ok(merged.facts.some(f => f.evidence.id === "p2"));
    assert.deepEqual(complete.relationships.map(r => [r.source, r.target]), [["e1", merged.id], ["e1", merged.id]]);
    assert.deepEqual((await graph(3, "chapter")).entities, [merged]);
    const universe = await universeWorkspace(ownerId, universeId);
    assert.deepEqual(universe.graph.matches, [{ source: JSON.stringify([bookId, merged.id]), target: JSON.stringify([otherBook, "e2"]) }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
