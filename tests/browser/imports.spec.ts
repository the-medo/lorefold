import { test, expect } from "./fixtures.js";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../backend/db/client.js";
import * as s from "../../backend/db/schema.js";
import { auth } from "../../backend/auth.js";
import { provisionUser } from "../../backend/provision-user.js";
import { importFixture } from "../import-fixture.js";
let userId: string;
let cookies: { name: string; value: string; url: string }[];
test.beforeAll(async () => {
  const email = `import-browser-${randomUUID()}@example.test`, password = randomUUID();
  userId = await provisionUser(email, password, "Import reader");
  const response = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  cookies = response.headers.getSetCookie().map(header => { const value = header.split(";")[0], i = value.indexOf("="); return { name: value.slice(0,i), value: value.slice(i+1), url: process.env.APP_ORIGIN! }; });
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
