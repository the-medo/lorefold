import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { app } from "../backend/app.js";
import { db, pool } from "../backend/db/client.js";
import { user } from "../backend/db/schema.js";
import { seedSample } from "../backend/db/sample.js";
import { provisionUser } from "../backend/provision-user.js";
import type { Workspace } from "../shared/contracts.js";

if (!process.env.LOREFOLD_WORKTREE_ID)
  throw new Error("Tests require the isolated worktree run environment.");
const origin = process.env.APP_ORIGIN!;
const email = `api-${randomUUID()}@example.test`;
const password = randomUUID();
let ownerId: string,
  otherId: string,
  bookId: string,
  otherBookId: string,
  cookie: string;
const request = (path: string, init: RequestInit = {}, authenticated = true) =>
  app.request(`${origin}/api${path}`, {
    ...init,
    headers: {
      origin,
      "content-type": "application/json",
      ...(authenticated && cookie ? { cookie } : {}),
      ...init.headers,
    },
  });
const setProgress = (
  completedChapter: unknown,
  id = bookId,
  headers?: HeadersInit,
) =>
  request(`/books/${id}/progress`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ completedChapter }),
  });
const workspace = async (chapter?: number, mode = "story") => {
  const response = await request(
    `/books/${bookId}/workspace?mode=${mode}${chapter === undefined ? "" : `&chapter=${chapter}`}`,
  );
  assert.equal(response.status, 200);
  return response.json() as Promise<Workspace>;
};

before(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
  await migrate(db, { migrationsFolder: "./migrations" });
  ownerId = await provisionUser(email, password, "API reader");
  otherId = await provisionUser(
    `other-${randomUUID()}@example.test`,
    password,
    "Other reader",
  );
  bookId = await seedSample(ownerId);
  otherBookId = await seedSample(otherId);
  const signedIn = await request(
    "/auth/sign-in/email",
    { method: "POST", body: JSON.stringify({ email, password }) },
    false,
  );
  assert.equal(signedIn.status, 200, await signedIn.clone().text());
  cookie = signedIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  assert.ok(cookie.includes(process.env.AUTH_COOKIE_PREFIX!));
  assert.match(signedIn.headers.get("set-cookie")!, /HttpOnly/i);
});
after(async () => {
  try {
    if (ownerId) await db.delete(user).where(eq(user.id, ownerId));
    if (otherId) await db.delete(user).where(eq(user.id, otherId));
  } finally {
    await pool.end();
  }
});

test("private APIs require authentication and public signup is disabled", async () => {
  assert.equal((await request("/books", {}, false)).status, 401);
  assert.equal(
    (await request(`/books/${bookId}/workspace`, {}, false)).status,
    401,
  );
  assert.equal(
    (
      await request(
        `/books/${bookId}/progress`,
        { method: "PATCH", body: '{"completedChapter":3}' },
        false,
      )
    ).status,
    401,
  );
  const signup = await request(
    "/auth/sign-up/email",
    {
      method: "POST",
      body: JSON.stringify({
        name: "Uninvited",
        email: "uninvited@example.test",
        password,
      }),
    },
    false,
  );
  assert.ok(signup.status >= 400);
  assert.equal(
    (
      await db
        .select()
        .from(user)
        .where(eq(user.email, "uninvited@example.test"))
    ).length,
    0,
  );
  const wrong = await request(
    "/auth/sign-in/email",
    {
      method: "POST",
      body: JSON.stringify({ email, password: "wrong-password" }),
    },
    false,
  );
  assert.equal(wrong.status, 401);
});

test("library ownership is checked for reads and progress writes", async () => {
  const response = await request("/books");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const { books } = await response.json();
  assert.deepEqual(
    books.map((b: { id: string }) => b.id),
    [bookId],
  );
  assert.equal(books[0].analyzedChapters, 3);
  assert.equal(books[0].completedChapter, 0);
  assert.equal((await request(`/books/${otherBookId}/workspace`)).status, 404);
  assert.equal((await setProgress(3, otherBookId)).status, 404);
});

test("unread books contain no recaps, source text, chapter titles, or knowledge", async () => {
  const data = await workspace(3);
  assert.equal(data.cutoff, 0);
  assert.equal(data.chapter, null);
  assert.deepEqual(data.graph, { entities: [], relationships: [] });
  assert.ok(data.chapters.every((c) => c.title === null));
  assert.doesNotMatch(JSON.stringify(data), /Iona|Tidekeepers|grey coat/);
});

test("chapter 1 clamps forged later requests and hides later identity and allegiance", async () => {
  assert.equal((await setProgress(1)).status, 200);
  for (const mode of ["chapter", "story"]) {
    const data = await workspace(999, mode);
    assert.equal(data.cutoff, 1);
    assert.equal(
      data.graph.entities.find((e) => e.id === "e2")?.label,
      "The keeper",
    );
    assert.doesNotMatch(JSON.stringify(data), /Iona|Tidekeepers|twenty years/);
    assert.ok(
      data.graph.entities.every((e) =>
        e.facts.every((f) => f.chapter <= 1 && f.evidence.chapter <= 1),
      ),
    );
    assert.ok(
      data.graph.relationships.every(
        (e) => e.chapter <= 1 && e.evidence.chapter <= 1,
      ),
    );
    assert.equal(data.chapters[1].title, null);
  }
});

test("chapter 2 reveals the name; graph scopes and browsing preserve saved progress", async () => {
  await setProgress(2);
  const story = await workspace(2);
  assert.equal(story.graph.entities.find((e) => e.id === "e2")?.label, "Iona");
  assert.deepEqual(story.graph.entities.find((e) => e.id === "e2")?.aliases, [
    "The keeper",
  ]);
  assert.doesNotMatch(JSON.stringify(story), /Tidekeepers/);
  const chapter = await workspace(2, "chapter");
  assert.ok(story.graph.entities.some((e) => e.id === "e3"));
  assert.ok(!chapter.graph.entities.some((e) => e.id === "e3"));
  assert.ok(chapter.graph.relationships.every((r) => r.evidence.chapter === 2));
  const earlier = await workspace(1);
  assert.equal(earlier.book.completedChapter, 2);
  assert.doesNotMatch(JSON.stringify(earlier), /Iona|Tidekeepers/);
  assert.equal((await workspace()).cutoff, 2);
});

test("chapter 3 reveals allegiance, and rewinding removes it from every payload", async () => {
  await setProgress(3);
  const finished = await workspace();
  assert.match(JSON.stringify(finished), /Tidekeepers/);
  assert.ok(finished.graph.relationships.some((e) => e.label === "belongs to"));
  await setProgress(1);
  const rewound = await workspace(3);
  assert.equal(rewound.book.completedChapter, 1);
  assert.doesNotMatch(JSON.stringify(rewound), /Iona|Tidekeepers|belongs to/);
});

test("seeding is repeatable and preserves saved progress", async () => {
  const beforeSeed = await workspace();
  await seedSample(ownerId);
  await seedSample(ownerId);
  assert.deepEqual(await workspace(), beforeSeed);
  assert.equal((await (await request("/books")).json()).books.length, 1);
});

test("invalid progress, malformed input, and cross-origin mutations are rejected", async () => {
  for (const value of [-1, 4, 1.5, "2", null, {}, 1e20])
    assert.equal((await setProgress(value)).status, 400);
  for (const query of [
    "chapter=-1",
    "chapter=1.5",
    "chapter=no",
    "mode=unknown",
  ]) {
    assert.equal(
      (await request(`/books/${bookId}/workspace?${query}`)).status,
      400,
    );
  }
  assert.equal(
    (
      await request(`/books/${bookId}/progress`, {
        method: "PATCH",
        body: "null",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/books/${bookId}/progress`, {
        method: "PATCH",
        body: "{broken",
      })
    ).status,
    400,
  );
  assert.equal(
    (await setProgress(3, bookId, { origin: "https://foreign.example" }))
      .status,
    403,
  );
  assert.equal((await setProgress(3, bookId, { origin: "" })).status, 403);
  assert.equal((await workspace()).book.completedChapter, 1);
});

test("signing out invalidates the session", async () => {
  assert.equal(
    (await request("/auth/sign-out", { method: "POST", body: "{}" })).status,
    200,
  );
  assert.equal((await request("/books")).status, 401);
});
