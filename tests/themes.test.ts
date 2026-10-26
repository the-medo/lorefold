import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { app } from "../backend/app.js";
import { db, pool } from "../backend/db/client.js";
import * as s from "../backend/db/schema.js";
import { provisionUser } from "../backend/provision-user.js";
import { seedSample } from "../backend/db/sample.js";
import { defaultTheme, midnightTheme, resolveTheme, type ThemeConfig, type ThemeLibrary, type SavedTheme } from "../shared/themes.js";

if (!process.env.LOREFOLD_WORKTREE_ID) throw new Error("Use the worktree launcher.");
const origin = process.env.APP_ORIGIN!;
let owner: string, other: string, cookie: string, otherCookie: string;
const request = (path: string, init: RequestInit = {}, session: string | null = cookie) => app.request(`${origin}/api${path}`, {
  ...init, headers: { origin, ...(session ? { cookie: session } : {}), ...init.headers },
});
const json = (body: unknown, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function create(config: ThemeConfig = midnightTheme) {
  const response = await request("/themes", json({ name: "  My saved theme  ", config }));
  assert.equal(response.status, 201);
  return (await response.json() as { theme: SavedTheme }).theme;
}
async function library(query = "", session = cookie): Promise<ThemeLibrary> {
  const response = await request(`/themes${query}`, {}, session);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
}
before(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
  await migrate(db, { migrationsFolder: "./migrations" });
  for (const second of [false, true]) {
    const email = `themes-${randomUUID()}@example.test`, password = randomUUID();
    const id = await provisionUser(email, password, "Theme reader");
    if (second) other = id; else owner = id;
    await seedSample(id);
    const response = await request("/auth/sign-in/email", json({ email, password }), null);
    assert.equal(response.status, 200);
    const session = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    if (second) otherCookie = session; else cookie = session;
  }
});
after(async () => {
  try {
    if (owner) await db.delete(s.user).where(eq(s.user.id, owner));
    if (other) await db.delete(s.user).where(eq(s.user.id, other));
  } finally { await pool.end(); }
});

test("theme routes require authentication and same-origin writes", async () => {
  for (const [path, init] of [
    ["/themes", {}], ["/themes", json({ name: "Test", config: defaultTheme })],
    ["/themes/missing", json({ name: "Test", config: defaultTheme }, "PUT")],
    ["/themes/missing", { method: "DELETE" }],
    ["/preferences/theme", json({ themeId: null }, "PUT")],
    [`/universes/sample-universe-${owner}/theme`, json({ themeId: null }, "PUT")],
  ] as [string, RequestInit][]) assert.equal((await request(path, init, null)).status, 401);
  for (const path of ["/themes", "/preferences/theme", `/universes/sample-universe-${owner}/theme`]) {
    assert.equal((await request(path, { ...json({ themeId: null }, path === "/themes" ? "POST" : "PUT"), headers: { origin: "https://foreign.example" } })).status, 403);
  }
  assert.deepEqual(await library(), { themes: [], defaultThemeId: null, universeThemes: [], contextUniverseId: null });
});

test("themes reject CSS injection, unknown versions/fonts, malformed data, and out-of-range sizes", async () => {
  const invalid: unknown[] = [null, [], { ...defaultTheme, version: 2 }, { ...defaultTheme, css: "body{display:none}" },
    { ...defaultTheme, colors: { ...defaultTheme.colors, accent: "url(https://example.test/track)" } },
    { ...defaultTheme, colors: { ...defaultTheme.colors, text: "#123456; display:none" } },
    { ...defaultTheme, colors: { ...defaultTheme.colors, unknown: "#ffffff" } },
    { ...defaultTheme, typography: { ...defaultTheme.typography, body: "constructor" } },
    { ...defaultTheme, typography: { ...defaultTheme.typography, heading: "url(font.woff)" } },
    { ...defaultTheme, typography: { ...defaultTheme.typography, size: 100 } },
    { ...defaultTheme, typography: { ...defaultTheme.typography, readingSize: 0 } },
    { ...defaultTheme, typography: { ...defaultTheme.typography, readingLineHeight: "1.8" } },
    { ...defaultTheme, radius: -1 }, { ...defaultTheme, spacing: 5 }, { ...defaultTheme, mode: "auto" },
  ];
  for (const config of invalid) assert.equal((await request("/themes", json({ name: "Invalid", config }))).status, 400);
  for (const body of [null, [], {}, { name: " ", config: defaultTheme }, { name: "x".repeat(81), config: defaultTheme }, { name: "Test", config: defaultTheme, ownerId: other }])
    assert.equal((await request("/themes", json(body))).status, 400);
  assert.equal((await request("/themes", json({ name: "x".repeat(17000) }))).status, 413);
  assert.equal((await request("/themes", { method: "POST", body: "{" })).status, 400);
  for (const themeId of [false, 1, "", {}, "x".repeat(201)]) assert.equal((await request("/preferences/theme", json({ themeId }, "PUT"))).status, 400);
  assert.equal((await request("/preferences/theme", json({}, "PUT"))).status, 400);
});

test("theme CRUD is persisted and private, including assignments and book/universe context", async () => {
  const theme = await create();
  assert.equal(theme.name, "My saved theme");
  assert.deepEqual(theme.config, midnightTheme);
  assert.deepEqual((await db.select().from(s.themes).where(eq(s.themes.id, theme.id)))[0].config, midnightTheme);
  assert.equal((await library("", otherCookie)).themes.length, 0);
  assert.equal((await request(`/themes/${theme.id}`, json({ name: "Stolen", config: defaultTheme }, "PUT"), otherCookie)).status, 404);
  assert.equal((await request(`/themes/${theme.id}`, { method: "DELETE" }, otherCookie)).status, 404);
  assert.equal((await request("/preferences/theme", json({ themeId: theme.id }, "PUT"), otherCookie)).status, 404);
  assert.equal((await request(`/universes/sample-universe-${other}/theme`, json({ themeId: theme.id }, "PUT"))).status, 404);
  assert.equal((await request(`/universes/sample-universe-${other}/theme`, json({ themeId: null }, "PUT"))).status, 404);
  assert.equal((await request(`/themes?bookId=sample-${other}`)).status, 404);
  assert.equal((await request(`/themes?universeId=sample-universe-${other}`)).status, 404);
  assert.equal((await request("/themes?bookId=missing&universeId=missing")).status, 400);
  await assert.rejects(db.insert(s.userThemePreferences).values({ userId: other, themeId: theme.id }));
  await assert.rejects(db.insert(s.universeThemePreferences).values({ universeId: `sample-universe-${other}`, ownerId: owner, themeId: theme.id }));
  await assert.rejects(db.insert(s.universeThemePreferences).values({ universeId: `sample-universe-${other}`, ownerId: other, themeId: theme.id }));
  const updated = await request(`/themes/${theme.id}`, json({ name: "Renamed", config: defaultTheme }, "PUT"));
  assert.equal(updated.status, 200);
  assert.equal((await library()).themes.find((t) => t.id === theme.id)?.name, "Renamed");
  assert.equal((await request(`/themes/${theme.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await request(`/themes/${theme.id}`, { method: "DELETE" })).status, 404);
});

test("universe overrides inherit into books; resets and deletion fall back without changing reading data", async () => {
  const main = await create(), universe = await create(defaultTheme);
  const universePath = `/universes/sample-universe-${owner}/theme`;
  const bookQuery = `?bookId=sample-${owner}`;
  const workspacePath = `/books/sample-${owner}/workspace`;
  const before = await (await request(workspacePath)).json();
  assert.equal((await request("/preferences/theme", json({ themeId: main.id }, "PUT"))).status, 200);
  assert.deepEqual(resolveTheme(await library(bookQuery)), midnightTheme);
  assert.equal((await request(universePath, json({ themeId: universe.id }, "PUT"))).status, 200);
  assert.deepEqual(resolveTheme(await library()), midnightTheme);
  assert.deepEqual(resolveTheme(await library(bookQuery)), defaultTheme);
  assert.deepEqual(resolveTheme(await library(`?universeId=sample-universe-${owner}`)), defaultTheme);
  const edited = { ...defaultTheme, radius: 0, colors: { ...defaultTheme.colors, accent: "#ff6600" } };
  assert.equal((await request(`/themes/${universe.id}`, json({ name: "Updated", config: edited }, "PUT"))).status, 200);
  assert.deepEqual(resolveTheme(await library(bookQuery)), edited);
  assert.equal((await request(universePath, json({ themeId: null }, "PUT"))).status, 200);
  assert.deepEqual(resolveTheme(await library(bookQuery)), midnightTheme);
  await request(universePath, json({ themeId: universe.id }, "PUT"));
  assert.equal((await request(`/themes/${universe.id}`, { method: "DELETE" })).status, 200);
  assert.deepEqual((await library()).universeThemes, []);
  assert.deepEqual(resolveTheme(await library(bookQuery)), midnightTheme);
  await request(universePath, json({ themeId: main.id }, "PUT"));
  assert.equal((await request(`/themes/${main.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await library()).defaultThemeId, null);
  assert.deepEqual((await library()).universeThemes, []);
  assert.deepEqual(resolveTheme(await library(bookQuery)), defaultTheme);
  assert.deepEqual(await (await request(workspacePath)).json(), before);
  const remaining = await create();
  await request("/preferences/theme", json({ themeId: remaining.id }, "PUT"));
  await request("/preferences/theme", json({ themeId: null }, "PUT"));
  assert.ok((await library()).themes.some((t) => t.id === remaining.id));
});

test("concurrent deletion and assignment cannot leave dangling theme selections", async () => {
  const theme = await create();
  const [assignment, deletion] = await Promise.all([
    request("/preferences/theme", json({ themeId: theme.id }, "PUT")),
    request(`/themes/${theme.id}`, { method: "DELETE" }),
  ]);
  assert.ok([200, 404].includes(assignment.status));
  assert.equal(deletion.status, 200);
  assert.equal((await library()).defaultThemeId, null);
});
