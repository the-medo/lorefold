import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { app } from "../backend/app.js";
import { db, pool } from "../backend/db/client.js";
import * as s from "../backend/db/schema.js";
import { seedSample } from "../backend/db/sample.js";
import { provisionUser } from "../backend/provision-user.js";
import { seedMapBook } from "./universe-map-fixture.js";
import type { UniverseWorkspace, Workspace } from "../shared/contracts.js";

if (!process.env.LOREFOLD_WORKTREE_ID) throw new Error("Use the worktree launcher.");
const origin = process.env.APP_ORIGIN!;
let ownerId: string, otherId: string, bookId: string, secondBookId: string, universeId: string, cookie: string;
const request = (path: string, init: RequestInit = {}, authenticated = true) => app.request(`${origin}/api${path}`, {
  ...init, headers: { origin, "content-type": "application/json", ...(authenticated ? { cookie } : {}), ...init.headers },
});
const progress = async (id: string, chapter: number) => {
  assert.equal((await request(`/books/${id}/progress`, { method: "PATCH", body: JSON.stringify({ completedChapter: chapter }) })).status, 200);
};
const workspace = async () => {
  const response = await request(`/universes/${universeId}?chapter=999`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json() as Promise<UniverseWorkspace>;
};
before(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
  const email = `map-${randomUUID()}@example.test`, password = randomUUID();
  ownerId = await provisionUser(email, password, "Map reader");
  otherId = await provisionUser(`map-other-${randomUUID()}@example.test`, password, "Other reader");
  bookId = await seedSample(ownerId);
  await seedSample(otherId);
  universeId = `sample-universe-${ownerId}`;
  secondBookId = await seedMapBook(ownerId, universeId);
  await seedMapBook(ownerId, universeId, 0);
  await seedMapBook(ownerId, null); // Owned but not in this universe.
  const differentUniverse = randomUUID();
  await db.insert(s.universes).values({ id: differentUniverse, ownerId, name: "Another world" });
  await seedMapBook(ownerId, differentUniverse);
  await db.insert(s.books).values({ id: randomUUID(), ownerId, universeId, title: "Pending book", author: "Test author", description: "" });
  await db.insert(s.resources).values({ id: randomUUID(), ownerId, universeId, kind: "document", title: "Pending notes", filename: "notes.txt", storageKey: randomUUID(), byteSize: 1 });
  const response = await request("/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email, password }) }, false);
  assert.equal(response.status, 200);
  cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
});
after(async () => {
  try {
    if (ownerId) await db.delete(s.user).where(eq(s.user.id, ownerId));
    if (otherId) await db.delete(s.user).where(eq(s.user.id, otherId));
  } finally { await pool.end(); }
});

test("universe knowledge requires authentication and universe ownership", async () => {
  assert.equal((await request(`/universes/${universeId}`, {}, false)).status, 401);
  assert.equal((await request(`/universes/sample-universe-${otherId}`)).status, 404);
  assert.equal((await request("/universes/missing")).status, 404);
});

test("each book uses its own cutoff and local identities, matching its story-so-far map", async () => {
  await progress(bookId, 1);
  const data = await workspace();
  assert.equal(data.books.length, 4);
  assert.equal(data.resources.length, 1);
  assert.deepEqual(new Set(data.graph.entities.map((node) => node.bookId)), new Set([bookId, secondBookId]));
  assert.equal(data.graph.entities.filter((node) => node.label === "Mara").length, 2);
  assert.equal(new Set(data.graph.entities.map((node) => node.id)).size, data.graph.entities.length);
  assert.equal(new Set(data.graph.relationships.map((edge) => edge.id)).size, data.graph.relationships.length);
  for (const id of [bookId, secondBookId]) {
    const individual: Workspace = await (await request(`/books/${id}/workspace?mode=story`)).json();
    const nodes = data.graph.entities.filter((node) => node.bookId === id);
    assert.deepEqual(nodes.map((node) => node.label), individual.graph.entities.map((node) => node.label));
    assert.deepEqual(nodes.map((node) => node.aliases), individual.graph.entities.map((node) => node.aliases));
    assert.deepEqual(nodes.flatMap((node) => node.facts.map((fact) => fact.value)), individual.graph.entities.flatMap((node) => node.facts.map((fact) => fact.value)));
    const edges = data.graph.relationships.filter((edge) => edge.bookId === id);
    assert.deepEqual(edges.map((edge) => edge.label), individual.graph.relationships.map((edge) => edge.label));
    const ids = new Set(nodes.map((node) => node.id));
    for (const edge of edges) {
      assert.ok(ids.has(edge.source) && ids.has(edge.target));
      assert.ok(edge.chapter <= individual.cutoff && edge.evidence.chapter <= individual.cutoff);
    }
    for (const fact of nodes.flatMap((node) => node.facts)) assert.ok(fact.chapter <= individual.cutoff && fact.evidence.chapter <= individual.cutoff);
  }
  const serialized = JSON.stringify(data.graph);
  assert.doesNotMatch(serialized, /Iona|Tidekeepers|twenty years/);
  assert.match(serialized, /Orin/);
});

test("rewinds remove later names, aliases, facts, evidence, and relationships independently", async () => {
  await progress(bookId, 3);
  assert.match(JSON.stringify((await workspace()).graph), /Tidekeepers/);
  await progress(bookId, 1);
  await progress(secondBookId, 1);
  const graph = (await workspace()).graph;
  assert.doesNotMatch(JSON.stringify(graph), /Iona|Tidekeepers|Orin|sower/);
  assert.ok(graph.entities.some((node) => node.label === "The gardener"));
  await progress(bookId, 0);
  await progress(secondBookId, 0);
  assert.deepEqual((await workspace()).graph, { entities: [], relationships: [] });
});
