import { test, expect } from "./fixtures.js";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, pool } from "../../backend/db/client.js";
import * as s from "../../backend/db/schema.js";
import { auth } from "../../backend/auth.js";
import { provisionUser } from "../../backend/provision-user.js";
import { importFixture } from "../import-fixture.js";
import { createUniverse, uploadResource } from "../../backend/universes.js";
import { runNextImport } from "../../backend/imports/worker.js";
import { mockImport } from "../../backend/imports/analysis.js";
let userId: string;
let cookies: { name: string; value: string; url: string }[];
test.beforeAll(async () => {
  const email = `import-browser-${randomUUID()}@example.test`, password = randomUUID();
  userId = await provisionUser(email, password, "Import reader");
  const response = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  cookies = response.headers.getSetCookie().map(header => { const value = header.split(";")[0], i = value.indexOf("="); return { name: value.slice(0,i), value: value.slice(i+1), url: process.env.APP_ORIGIN! }; });
});

test("47 source titles stay visible in compact scrollable chapter lists before reading", async ({ page, context }) => {
  const bookId = randomUUID();
  await db.insert(s.books).values({ id: bookId, ownerId: userId, title: "Forty-seven passages", author: "Synthetic author", description: "" });
  await db.insert(s.chapters).values(Array.from({ length: 47 }, (_, i) => ({
    bookId, number: i + 1, title: `Passage ${i + 1}: ${i === 46 ? "The final lantern" : "A road through the valley"}`,
    text: "Private unread source.", recap: "Private unread recap.", developments: [], analyzed: false,
  })));
  await context.addCookies(cookies);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/books/${bookId}`);
  const list = page.getByRole("navigation", { name: "Book chapters" });
  await expect(list.getByRole("button")).toHaveCount(47);
  await expect(list.getByRole("button").first()).toContainText("Passage 1: A road through the valley");
  await expect(list.getByRole("button").first()).toContainText("Waiting to unfold");
  await expect(list.getByRole("button").first()).toBeDisabled();
  await expect(page.locator("body")).not.toContainText("Private unread");
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    expect(await list.evaluate(node => node.scrollHeight > node.clientHeight && node.clientHeight <= 420)).toBe(true);
    expect((await list.getByRole("button").first().boundingBox())!.height).toBeLessThanOrEqual(48);
    await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(list.getByRole("button").last()).toBeInViewport();
    await expect(list.getByRole("button").last()).toContainText("The final lantern");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/chapters-${viewport.width}.png`, fullPage: true });
  }
  await page.getByLabel("I’ve finished").selectOption("47");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(list.getByRole("button").last()).toHaveAttribute("aria-current", "page");
  await expect(list.getByRole("button").last()).toBeInViewport();
  await page.reload();
  await expect(page.getByLabel("I’ve finished")).toHaveValue("47");
  await expect(list.getByRole("button").last()).toBeInViewport();
  await expect(page.locator("body")).not.toContainText("Private unread");
});

test("a legacy exhausted import can resume from the book page", async ({ page, context }) => {
  const connection = await pool.connect();
  let bookId: string;
  try {
    await connection.query("select pg_advisory_lock(1280266821, 1)");
    const universe = await createUniverse(userId, { name: "Recovery fixture" });
    const form = new FormData(); form.set("kind", "book"); form.set("title", "A resumable story");
    form.set("file", new File(["Chapter 1\n\nAda carries a brass key to Rowan."], "resume.txt"));
    const resource = await uploadResource(userId, universe.id, form); bookId = resource.bookId!;
    await runNextImport({ connection, bookIds: [bookId], provider: async () => async request => ({ ...mockImport(request), text: "invalid JSON" }) });
    await db.update(s.importParts).set({ attempts: 3 }).where(eq(s.importParts.bookId, bookId));
    await db.update(s.importJobs).set({ status: "failed", retryable: false, nextRetryAt: null }).where(eq(s.importJobs.bookId, bookId));
  } finally {
    await connection.query("select pg_advisory_unlock(1280266821, 1)"); connection.release();
  }
  await context.addCookies(cookies);
  await page.goto(`/books/${bookId}`);
  await page.getByRole("button", { name: "Resume analysis", exact: true }).click();
  await expect(page.getByRole("region", { name: "Book analysis" })).toContainText("Analysis complete", { timeout: 20000 });
  const parts = await db.select().from(s.importParts).where(eq(s.importParts.bookId, bookId));
  expect(parts.find(part => part.phase === "analysis")!.attempts).toBe(4);
  await expect(page.getByLabel("I’ve finished")).toHaveValue("0");
});
test.afterAll(async () => {
  const resources = await db.select().from(s.resources).where(eq(s.resources.ownerId, userId));
  await db.delete(s.user).where(eq(s.user.id, userId));
  for (const resource of resources) {
    await rm(join(process.env.LOREFOLD_LOCAL_STORAGE_DIR!, "uploads", resource.storageKey), { force: true });
    if (resource.bookId) await rm(join(process.env.LOREFOLD_LOCAL_STORAGE_DIR!, "books", resource.bookId), { recursive: true, force: true });
  }
});
test("EPUB upload analyzes every chapter and joins shared characters without leaking unread names", async ({ page, context }) => {
  await context.addCookies(cookies);
  await page.goto("/");
  await page.getByRole("button", { name: "Create universe", exact: true }).click();
  await page.getByLabel("Universe name").fill("Observatory stories");
  await page.getByRole("dialog").getByRole("button", { name: "Create universe", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Observatory stories", exact: true })).toBeVisible();
  const url = page.url();
  for (const title of ["The Brass Key", "Return to the Observatory"]) {
    await page.getByRole("button", { name: "Upload resource", exact: true }).click();
    await page.getByLabel("File to upload").setInputFiles({ name: "story.epub", mimeType: "application/epub+zip", buffer: importFixture() });
    await page.getByLabel("Title", { exact: true }).fill(title);
    await page.getByRole("dialog").getByRole("button", { name: "Upload resource", exact: true }).click();
    await page.getByRole("button", { name: `Open ${title}`, exact: true }).click();
    await expect(page.getByRole("region", { name: "Book analysis" })).toContainText("Analysis complete", { timeout: 20000 });
    await expect(page.getByRole("region", { name: "Book analysis" })).toContainText("2/2 chapters");
    await expect(page.getByRole("region", { name: "Book analysis" })).toContainText("Mock analysis");
    await page.getByLabel("I’ve finished").selectOption("1");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("tabpanel", { name: "Recap" })).toContainText("Ada carries");
    await expect(page.getByRole("tabpanel", { name: "Recap" })).not.toContainText("Leon");
    await page.getByRole("tab", { name: "Story map" }).click();
    await expect(page.getByRole("img", { name: "3D story relationship map" })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("I’ve finished")).toHaveValue("1");
    await page.goto(url);
  }
  const entities = page.getByLabel("Universe map entities", { exact: true });
  await expect(entities.getByRole("button", { name: /^Ada / })).toHaveCount(1);
  await expect(entities).not.toContainText("Leon");
  await entities.getByRole("button", { name: /^Ada / }).click();
  await expect(page.getByLabel("Entity details")).toContainText("The Brass Key");
  await expect(page.getByLabel("Entity details")).toContainText("Return to the Observatory");
  await page.getByRole("checkbox", { name: "Include The Brass Key", exact: true }).uncheck();
  await expect(entities.getByRole("button", { name: /^Ada / })).toHaveCount(1);
  await expect(entities).not.toContainText("The Brass Key");
  await page.screenshot({ path: "test-results/import-map-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/import-map-mobile.png", fullPage: true });
});
