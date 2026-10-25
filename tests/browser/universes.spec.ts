import { test, expect } from "./fixtures.js";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../backend/db/client.js";
import { books, resources, user } from "../../backend/db/schema.js";
import { provisionUser } from "../../backend/provision-user.js";
import { seedSample } from "../../backend/db/sample.js";

const email = `universe-browser-${randomUUID()}@example.test`;
const password = randomUUID();
let userId: string;
test.beforeAll(async () => {
  userId = await provisionUser(email, password, "World builder");
  await seedSample(userId);
  await db.insert(books).values({ id: randomUUID(), ownerId: userId, title: "An unfiled story", author: "A test author", description: "" });
});
test.afterAll(async () => {
  if (userId) {
      const uploads = await db.select({ key: resources.storageKey }).from(resources).where(eq(resources.ownerId, userId));
      for (const file of uploads) await rm(join(process.env.LOREFOLD_LOCAL_STORAGE_DIR!, "uploads", file.key), { force: true });
      await db.delete(user).where(eq(user.id, userId));
  }
});

test("universes are the first page; create, upload, download, and retain books in My library", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Open my space" }).click();
  await expect(page.getByRole("heading", { name: /^Your universes/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Bellweather/ })).toContainText("1 book");
  await page.getByRole("button", { name: "Create universe", exact: true }).click();
  await page.getByLabel("Universe name").fill("The Silver Orchard");
  await page.getByLabel("Description").fill("An invented world of wandering orchards and moonlit paths.");
  await page.getByRole("dialog").getByRole("button", { name: "Create universe", exact: true }).click();
  await expect(page.getByRole("heading", { name: "The Silver Orchard", exact: true })).toBeVisible();
  const universeURL = page.url();
  await expect(page.getByText("The first story starts here.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "The Silver Orchard", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add from My library" }).click();
  await page.getByRole("button", { name: "Add book", exact: true }).click();
  await expect(page.getByRole("heading", { name: "An unfiled story" })).toBeVisible();
  await page.getByRole("button", { name: "Upload resource", exact: true }).click();
  await page.getByLabel("File to upload").setInputFiles({ name: "moonlit-path.txt", mimeType: "text/plain", buffer: Buffer.from("The orchard walked toward the moon. An original synthetic test story.") });
  await page.getByLabel("Title", { exact: true }).fill("The Moonlit Path");
  await page.getByLabel("Author").fill("A Lorefold test author");
  await page.getByRole("dialog").getByRole("button", { name: "Upload resource", exact: true }).click();
  await expect(page.getByRole("heading", { name: "The Moonlit Path", exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Resource uploaded");

  await page.getByRole("button", { name: "Upload resource", exact: true }).click();
  await page.getByLabel("Resource type").selectOption("document");
  await page.getByLabel("File to upload").setInputFiles({ name: "orchard-notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Orchard notes\nThe trees move at night.") });
  await page.getByLabel("Title", { exact: true }).fill("Orchard field notes");
  await page.getByRole("dialog").getByRole("button", { name: "Upload resource", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Orchard field notes" })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download Orchard field notes" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("orchard-notes.md");
  expect(await download.failure()).toBeNull();
  await page.screenshot({ path: "test-results/universe-workspace.png", fullPage: true });

  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "My library", exact: true }).click();
  await expect(page.getByRole("heading", { name: "The Lantern at Bellweather" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "The Moonlit Path", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Orchard field notes" })).toHaveCount(0);
  await page.getByRole("button", { name: "Open The Moonlit Path", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your book is saved." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download original" })).toBeVisible();
  await page.getByRole("button", { name: "Back to universe" }).click();
  await expect(page).toHaveURL(universeURL);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Orchard field notes" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/universe-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Universes", exact: true }).first().click();
  await expect(page.getByRole("button", { name: /The Silver Orchard/ })).toContainText("2 books");
  await page.screenshot({ path: "test-results/universes-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "test-results/universes.png", fullPage: true });
  await page.getByLabel("Search universes").fill("unmatched universe");
  await expect(page.getByRole("heading", { name: "No universes found." })).toBeVisible();
  await page.getByLabel("Search universes").fill("");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
  expect(errors).toEqual([]);
});
