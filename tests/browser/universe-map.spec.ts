import { test, expect } from "./fixtures.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../backend/db/client.js";
import * as s from "../../backend/db/schema.js";
import { provisionUser } from "../../backend/provision-user.js";
import { seedSample } from "../../backend/db/sample.js";
import { seedMapBook } from "../universe-map-fixture.js";

const email = `map-browser-${randomUUID()}@example.test`, password = randomUUID();
let userId: string, bookId: string, secondBookId: string;
test.beforeAll(async () => {
  userId = await provisionUser(email, password, "Universe reader");
  bookId = await seedSample(userId);
  const universeId = `sample-universe-${userId}`;
  secondBookId = await seedMapBook(userId, universeId);
  await db.update(s.progress).set({ completedChapter: 1 }).where(eq(s.progress.bookId, bookId));
  const pendingBookId = randomUUID();
  await db.insert(s.books).values({ id: pendingBookId, ownerId: userId, universeId, title: "A pending story", author: "Test author", description: "" });
  await db.insert(s.resources).values([
    { id: randomUUID(), ownerId: userId, universeId, bookId: pendingBookId, kind: "book", title: "A pending story", filename: "story.txt", storageKey: randomUUID(), byteSize: 1 },
    { id: randomUUID(), ownerId: userId, universeId, kind: "document", title: "Field notes", filename: "notes.txt", storageKey: randomUUID(), byteSize: 1 },
  ]);
});
test.afterAll(async () => {
  if (userId) await db.delete(s.user).where(eq(s.user.id, userId));
});

test("universe map respects progress, source selections, evidence, reloads, and mobile access", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect((await page.request.get("/api/health")).ok()).toBe(true);
  await page.goto("/");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Open my space" }).click();
  await page.getByRole("button", { name: /Bellweather/ }).click();
  const map = page.getByRole("region", { name: "Universe map", exact: true });
  const entities = page.getByLabel("Universe map entities", { exact: true });
  const first = map.getByRole("checkbox", { name: "Include The Lantern at Bellweather", exact: true });
  const second = map.getByRole("checkbox", { name: "Include The Wandering Orchard", exact: true });
  const documentSource = map.getByRole("checkbox", { name: "Include Field notes", exact: true });
  await expect(map.getByText("Through chapter 1 of 3")).toBeVisible();
  await expect(map.getByText("Through chapter 2 of 2")).toBeVisible();
  await expect(map.getByText("Uploaded · awaiting extraction")).toBeVisible();
  await expect(documentSource).toBeChecked();
  await expect(entities.getByRole("button")).toHaveCount(7);
  await expect(entities.getByRole("button", { name: /^Mara / })).toHaveCount(2);
  await expect(map).not.toContainText("Iona");
  await expect(map).not.toContainText("Tidekeepers");
  const canvas = map.getByRole("img", { name: "3D story relationship map" });
  await expect(canvas).toBeVisible();
  await entities.getByRole("button", { name: "Orin The Wandering Orchard", exact: true }).click();
  const details = map.getByLabel("Entity details");
  await expect(details).toContainText("From The Wandering Orchard");
  await details.getByText("The Wandering Orchard · Chapter 2", { exact: true }).first().click();
  await expect(details.locator("blockquote").first()).toHaveText("The gardener is Orin, also called the sower.");
  await second.uncheck();
  await expect(details).toHaveCount(0);
  await expect(entities.getByRole("button")).toHaveCount(5);
  await expect(map).not.toContainText("Orin");
  await documentSource.uncheck();
  await page.reload();
  await expect(second).not.toBeChecked();
  await expect(documentSource).not.toBeChecked();
  await expect(first).toBeChecked();
  await expect(entities.getByRole("button")).toHaveCount(5);
  await second.check();
  await expect(entities.getByRole("button")).toHaveCount(7);
  await map.getByRole("button", { name: "Locations", exact: true }).click();
  await expect(entities.getByRole("button")).toHaveCount(2);
  await map.getByRole("button", { name: "All", exact: true }).click();
  await page.getByLabel("Search universe map").fill("Orin");
  await expect(entities.getByRole("button")).toHaveCount(1);
  await page.getByLabel("Search universe map").fill("no match");
  await expect(map.getByText("No matches. Try another search or entity type.")).toBeVisible();
  await page.getByLabel("Search universe map").fill("");
  await map.getByRole("button", { name: "Deselect all", exact: true }).click();
  await expect(entities.getByRole("button")).toHaveCount(0);
  await expect(map.getByText(/No sources selected/)).toBeVisible();
  await documentSource.check();
  await expect(map.getByText(/No knowledge to map yet/)).toBeVisible();
  await map.getByRole("button", { name: "Select all", exact: true }).click();
  await expect(entities.getByRole("button")).toHaveCount(7);
  await map.screenshot({ path: "test-results/universe-map-desktop.png" });

  // A progress write in another tab must refresh the universe's authorized snapshot.
  const otherTab = await page.context().newPage();
  await otherTab.goto("/");
  expect((await otherTab.request.patch(`/api/books/${secondBookId}/progress`, {
    headers: { origin: process.env.APP_ORIGIN! }, data: { completedChapter: 1 },
  })).ok()).toBe(true);
  await otherTab.close();
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(map.getByText("Through chapter 1 of 2")).toBeVisible();
  await expect(map).not.toContainText("Orin");
  await expect(map).not.toContainText("sower");
  const workspace = await (await page.request.get(`/api/books/${bookId}/workspace`)).json();
  expect(workspace.book.completedChapter).toBe(1);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(canvas).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await map.screenshot({ path: "test-results/universe-map-mobile.png" });
  // The accessible list and source filters also work without WebGL.
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: Parameters<typeof original>) {
      if (String(args[0]).startsWith("webgl")) return null;
      return original.apply(this, args);
    } as typeof original;
  });
  await page.reload();
  await expect(map.getByText(/The 3D map needs WebGL/)).toBeVisible();
  await entities.getByRole("button", { name: "The keeper The Lantern at Bellweather", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(details.getByRole("heading", { name: "The keeper", exact: true })).toBeVisible();
  await first.uncheck();
  await expect(details).toHaveCount(0);
  await expect(entities.getByRole("button")).toHaveCount(2);
  expect(errors).toEqual([]);
});
