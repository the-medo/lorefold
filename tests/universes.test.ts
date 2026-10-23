import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { app } from "../backend/app.js";
import { db, pool } from "../backend/db/client.js";
import * as s from "../backend/db/schema.js";
import { seedSample } from "../backend/db/sample.js";
import { provisionUser } from "../backend/provision-user.js";
import { MAX_UPLOAD_SIZE } from "../backend/universes.js";
import type { Book, Resource, Universe, UniverseWorkspace } from "../shared/contracts.js";

if (!process.env.LOREFOLD_WORKTREE_ID || !process.env.LOREFOLD_LOCAL_STORAGE_DIR) throw new Error("Use the worktree launcher.");
const origin = process.env.APP_ORIGIN!;
const password = randomUUID();
const files: string[] = [];
let ownerId: string, otherId: string, cookie: string, otherCookie: string, universeId: string;
const unassignedBook = randomUUID();
const request = (path: string, init: RequestInit = {}, session: string | null = cookie) => app.request(`${origin}/api${path}`, {
  ...init, headers: { origin, ...(session ? { cookie: session } : {}), ...init.headers },
});
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
function upload(filename: string, content: string | Blob, kind = "book", title = "The Silver Orchard") {
  const form = new FormData();
  form.set("kind", kind); form.set("title", title); form.set("author", "Test author");
  form.set("file", new File([content], filename));
  return { method: "POST", body: form };
}
before(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
  for (const other of [false, true]) {
    const email = `universe-${randomUUID()}@example.test`;
    const id = await provisionUser(email, password, "Universe reader");
    await seedSample(id);
    const response = await request("/auth/sign-in/email", json({ email, password }), null);
    assert.equal(response.status, 200);
    const session = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    if (other) { otherId = id; otherCookie = session; } else { ownerId = id; cookie = session; }
  }
  await db.insert(s.books).values({ id: unassignedBook, ownerId, title: "An unfiled story", author: "Test author", description: "" });
});
after(async () => {
  try {
    for (const file of files) await rm(join(process.env.LOREFOLD_LOCAL_STORAGE_DIR!, "uploads", file), { force: true });
    if (ownerId) await db.delete(s.user).where(eq(s.user.id, ownerId));
    if (otherId) await db.delete(s.user).where(eq(s.user.id, otherId));
  } finally { await pool.end(); }
});

test("universes are private, validated, persisted, and include the seeded world", async () => {
  assert.equal((await request("/universes", {}, null)).status, 401);
  assert.equal((await request("/universes", json({ name: "   " }))).status, 400);
  assert.equal((await request("/universes", json({ name: "a".repeat(121) }))).status, 400);
  assert.equal((await request("/universes", json(null))).status, 400);
  const invalidOrigin = json({ name: "Blocked" });
  assert.equal((await request("/universes", { ...invalidOrigin, headers: { ...invalidOrigin.headers, origin: "https://foreign.example" } })).status, 403);
  const response = await request("/universes", json({ name: "  Star Wars  ", description: "A galaxy of stories." }));
  assert.equal(response.status, 201);
  const { universe }: { universe: Universe } = await response.json();
  universeId = universe.id;
  assert.equal(universe.name, "Star Wars");
  const listed: { universes: Universe[] } = await (await request("/universes")).json();
  assert.equal(listed.universes.length, 2);
  assert.equal(listed.universes.find((u) => u.name === "Bellweather")?.bookCount, 1);
  assert.equal((await request(`/universes/${universeId}`, {}, otherCookie)).status, 404);
  assert.equal((await request(`/universes/sample-universe-${otherId}`)).status, 404);
  assert.equal((await request(`/universes/${universeId}`)).headers.get("cache-control"), "no-store");
});

test("existing books can be added without leaking or moving another universe's books", async () => {
  assert.equal((await request(`/universes/${universeId}/books`, json({ bookId: `sample-${otherId}` }))).status, 404);
  assert.equal((await request(`/universes/${universeId}/books`, json({ bookId: `sample-${ownerId}` }))).status, 409);
  assert.equal((await request(`/universes/${universeId}/books`, json({ bookId: unassignedBook }))).status, 200);
  assert.equal((await request(`/universes/${universeId}/books`, json({ bookId: unassignedBook }))).status, 200);
  const data: UniverseWorkspace = await (await request(`/universes/${universeId}`)).json();
  assert.deepEqual(data.books.map((book) => book.id), [unassignedBook]);
  assert.equal(data.universe.bookCount, 1);
  const library: { books: Book[] } = await (await request("/books")).json();
  assert.equal(library.books.length, 2);
  await assert.rejects(db.update(s.books).set({ universeId: `sample-universe-${otherId}` }).where(eq(s.books.id, unassignedBook)));
});

test("real book uploads appear in both collections and have private original downloads", async () => {
  const content = "An original synthetic story.\n".repeat(1200);
  const response = await request(`/universes/${universeId}/resources`, upload("story.txt", content));
  assert.equal(response.status, 201, await response.clone().text());
  const { resource }: { resource: Resource } = await response.json();
  files.push(resource.id);
  assert.equal(resource.kind, "book"); assert.ok(resource.bookId);
  assert.equal("storageKey" in resource, false);
  const workspace = await (await request(`/books/${resource.bookId}/workspace`)).json();
  assert.equal(workspace.book.universeId, universeId);
  assert.equal(workspace.book.totalChapters, 0);
  assert.deepEqual(workspace.graph, { entities: [], relationships: [] });
  const library: { books: Book[] } = await (await request("/books")).json();
  assert.ok(library.books.some((book) => book.id === resource.bookId));
  const download = await request(`/resources/${resource.id}/download`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition")!, /^attachment/);
  assert.equal(download.headers.get("content-type"), "application/octet-stream");
  assert.equal(download.headers.get("cache-control"), "no-store");
  assert.equal(await download.text(), content);
  assert.equal((await stat(join(process.env.LOREFOLD_LOCAL_STORAGE_DIR!, "uploads", resource.id))).mode & 0o777, 0o600);
  assert.equal((await request(`/resources/${resource.id}/download`, {}, null)).status, 401);
  assert.equal((await request(`/resources/${resource.id}/download`, {}, otherCookie)).status, 404);
});

test("reference documents stay out of the library and sanitize filenames", async () => {
  const response = await request(`/universes/${universeId}/resources`, upload("../notes.md", "# Fictional star map\nA small synthetic guide.", "document", "A star map"));
  assert.equal(response.status, 201);
  const { resource }: { resource: Resource } = await response.json(); files.push(resource.id);
  assert.equal(resource.bookId, null); assert.equal(resource.filename, "notes.md");
  const data: UniverseWorkspace = await (await request(`/universes/${universeId}`)).json();
  assert.equal(data.universe.resourceCount, 1); assert.equal(data.universe.bookCount, 2);
  assert.equal(data.resources.length, 2);
  const library: { books: Book[] } = await (await request("/books")).json();
  assert.equal(library.books.some((book) => book.title === "A star map"), false);
});

test("uploads reject other owners, unsupported files, malformed bodies, and oversized requests", async () => {
  const endpoint = `/universes/${universeId}/resources`;
  assert.equal((await request(endpoint, upload("story.txt", "text"), null)).status, 401);
  assert.equal((await request(endpoint, upload("story.txt", "text"), otherCookie)).status, 404);
  for (const [filename, content] of [["empty.txt", ""], ["page.html", "<script>alert(1)</script>"], ["fake.pdf", "not PDF"], ["fake.epub", "not ZIP"], ["binary.txt", "a\0b"]]) {
    assert.equal((await request(endpoint, upload(filename, content))).status, 400, filename);
  }
  assert.equal((await request(endpoint, upload("book.txt", "text", "unknown"))).status, 400);
  assert.equal((await request(endpoint, upload("book.txt", "text", "book", "x".repeat(201)))).status, 400);
  assert.equal((await request(endpoint, json({ file: "not multipart" }))).status, 400);
  assert.equal((await request(endpoint, { method: "POST", body: "too big", headers: { "content-length": String(MAX_UPLOAD_SIZE + 64 * 1024 + 1) } })).status, 413);
  const response = await request(endpoint, upload("oversized.txt", new Blob([new Uint8Array(MAX_UPLOAD_SIZE + 1)])));
  assert.equal(response.status, 413);
  assert.equal((await (await request(`/universes/${universeId}`)).json()).resources.length, 2);
});
