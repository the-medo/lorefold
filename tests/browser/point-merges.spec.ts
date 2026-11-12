import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { test, expect } from "./fixtures.js";
import { auth } from "../../backend/auth.js";
import { provisionUser } from "../../backend/provision-user.js";
import { db } from "../../backend/db/client.js";
import * as s from "../../backend/db/schema.js";
import { seedMapBook } from "../universe-map-fixture.js";

test("analyze an entire book, reopen its saved suggestions, and apply a merge to the map", async ({ page, context }) => {
  const email = `points-${randomUUID()}@example.test`, password = randomUUID();
  const ownerId = await provisionUser(email, password, "Merge reader");
  try {
    const bookId = await seedMapBook(ownerId, null, 1);
    const quote = "The gardener signs his full name, Orin Vale.";
    await db.update(s.chapters).set({ text: "The gardener is Orin, also called the sower. " + quote })
      .where(and(eq(s.chapters.bookId, bookId), eq(s.chapters.number, 2)));
    await db.insert(s.entities).values({ bookId, id: "e3", kind: "character" });
    await db.insert(s.evidence).values({ bookId, id: "signature", chapter: 2, quote });
    await db.insert(s.facts).values({ bookId, id: "signature", entityId: "e3", kind: "label", value: "Orin Vale", revealChapter: 2, evidenceId: "signature" });
    const session = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    await context.addCookies(session.headers.getSetCookie().map(header => {
      const value = header.split(";")[0], i = value.indexOf("=");
      return { name: value.slice(0, i), value: value.slice(i + 1), url: process.env.APP_ORIGIN! };
    }));
    await page.goto(`/books/${bookId}`);
    await page.getByRole("button", { name: "Merge points", exact: true }).click();
    await page.getByRole("button", { name: "Analyze all points" }).click();
    await expect(page.getByText("Suggested merges", { exact: true })).toBeVisible({ timeout: 20000 });
    await expect(page.getByLabel("Include 1 merge from later chapters")).toBeChecked();
    const endpoint = `/api/books/${bookId}/point-merges`;
    const response = await page.request.get(endpoint + "?chapter=9999");
    expect(response.ok()).toBeTruthy();
    expect(await response.text()).not.toMatch(/Orin|signature|deterministic-mock|source-backed/);
    await page.getByLabel("Include 1 merge from later chapters").uncheck();
    await expect(page.getByRole("button", { name: "Apply 0 merges" })).toBeDisabled();

    await page.getByRole("button", { name: "Back to book" }).click();
    await page.getByLabel("I’ve finished").selectOption("2");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page).toHaveURL(/chapter=2/);
    await page.getByRole("button", { name: "Merge points", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByText("Supporting passages").click();
    await expect(page.getByText(quote, { exact: false })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const before = await (await page.request.get(`/api/books/${bookId}/workspace`)).json();
    expect(before.graph.entities).toHaveLength(3);
    await page.getByRole("button", { name: "Apply 1 merge" }).click();
    await expect(page.getByRole("status")).toHaveText("1 merge applied to the map.");
    await page.getByRole("button", { name: "Back to book" }).click();
    await page.getByRole("tab", { name: "Story map" }).click();
    await expect(page.getByLabel("Map entities").getByRole("button")).toHaveCount(2);
  } finally { await db.delete(s.user).where(eq(s.user.id, ownerId)); }
});
