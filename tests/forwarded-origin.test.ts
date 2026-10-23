import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

if (!process.env.LOREFOLD_WORKTREE_ID)
  throw new Error("Tests require the isolated worktree run environment.");
const browserOrigin = "http://localhost:60204";
process.env.LOREFOLD_DEV_BROWSER_ORIGIN = browserOrigin;
// Configure the forwarded origin before auth is instantiated.
const { app } = await import("../backend/app.js");
const { db, pool } = await import("../backend/db/client.js");
const { user } = await import("../backend/db/schema.js");
const { provisionUser } = await import("../backend/provision-user.js");
const { seedSample } = await import("../backend/db/sample.js");
let id: string | undefined;
after(async () => {
  try {
    if (id) await db.delete(user).where(eq(user.id, id));
  } finally {
    await pool.end();
  }
});

test("forwarded browser can sign in, save progress, and sign out while other origins stay blocked", async () => {
  const email = `forwarded-${randomUUID()}@example.test`;
  const password = randomUUID();
  id = await provisionUser(email, password, "Forwarded reader");
  const bookId = await seedSample(id);
  const request = (
    path: string,
    origin: string,
    init: RequestInit = {},
    cookie = "",
  ) =>
    app.request(`${browserOrigin}/api${path}`, {
      ...init,
      headers: {
        origin,
        cookie,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
    });
  for (const rejected of [
    "http://localhost:60205",
    "https://foreign.example",
  ]) {
    const response = await request("/auth/sign-in/email", rejected, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    assert.equal(response.status, 403);
  }
  const login = await request("/auth/sign-in/email", browserOrigin, {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  assert.ok(cookie);
  assert.equal(
    (await request("/books", browserOrigin, {}, cookie)).status,
    200,
  );
  const update = {
    method: "PATCH",
    body: JSON.stringify({ completedChapter: 1 }),
  };
  assert.equal(
    (await request(`/books/${bookId}/progress`, browserOrigin, update, cookie))
      .status,
    200,
  );
  for (const rejected of [
    "http://localhost:60205",
    "https://foreign.example",
    "",
  ]) {
    assert.equal(
      (await request(`/books/${bookId}/progress`, rejected, update, cookie))
        .status,
      403,
    );
  }
  const workspace = await request(
    `/books/${bookId}/workspace`,
    browserOrigin,
    {},
    cookie,
  );
  assert.equal((await workspace.json()).book.completedChapter, 1);
  assert.equal(
    (
      await request(
        "/auth/sign-out",
        browserOrigin,
        { method: "POST", body: "{}" },
        cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (await request("/books", browserOrigin, {}, cookie)).status,
    401,
  );
});
