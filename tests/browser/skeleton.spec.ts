import { test, expect } from "./fixtures.js";
import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../backend/db/client.js";
import { user } from "../../backend/db/schema.js";
import { provisionUser } from "../../backend/provision-user.js";
import { seedSample } from "../../backend/db/sample.js";

const email = `browser-${randomUUID()}@example.test`;
const password = randomUUID();
let userId: string;
test.beforeAll(async () => {
  userId = await provisionUser(email, password, "Alex");
  await seedSample(userId);
});
test.afterAll(async () => {
  if (userId) await db.delete(user).where(eq(user.id, userId));
});

async function openMap(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Open my space" }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "My library", exact: true }).click();
  await page.getByRole("button", { name: "Open The Lantern at Bellweather", exact: true }).click();
  await expect(page.getByLabel("I’ve finished")).toBeVisible();
  if (await page.getByLabel("I’ve finished").inputValue() !== "1") {
    await page.getByLabel("I’ve finished").selectOption("1");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("heading", { name: "A light in the fog" })).toBeVisible();
  }
  await page.getByRole("tab", { name: "Story map" }).click();
}

test("private reader can explore, rewind, reload, search, and sign out on desktop and mobile", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome to Lorefold." }),
  ).toBeVisible();
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Open my space" }).click();
  await expect(page.getByRole("heading", { name: /^Your universes/ })).toBeVisible();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "My library", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /^Your books/ }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/library.png", fullPage: true });
  await page.getByRole("button", { name: "Open book", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Begin at the beginning." }),
  ).toBeVisible();
  await page.getByLabel("I’ve finished").selectOption("1");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A light in the fog" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Chapter 2 Waiting/ }),
  ).toBeDisabled();
  await page.screenshot({ path: "test-results/recap.png", fullPage: true });
  await page.getByRole("tab", { name: "Story map" }).click();
  await expect(page.locator(".graph-canvas canvas").first()).toBeVisible();
  await expect(
    page.getByText("The 3D map needs WebGL.", { exact: false }),
  ).toHaveCount(0);
  const graphCanvas = page.getByRole("img", { name: "3D story relationship map" });
  const bounds = (await graphCanvas.boundingBox())!;
  const maraLabel = page.getByRole("button", { name: "Inspect Mara", exact: true });
  await expect(maraLabel).toBeVisible();
  const nodePosition = () => maraLabel.evaluate((label) => ({
    x: parseFloat(label.style.left), y: parseFloat(label.style.top),
  }));
  const initial = await nodePosition();
  await page.mouse.move(bounds.x + 70, bounds.y + 70);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 170, bounds.y + 130, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => Math.hypot((await nodePosition()).x - initial.x, (await nodePosition()).y - initial.y)).toBeGreaterThan(5);
  // Dragging the scene must not accidentally open an entity.
  await expect(page.getByLabel("Entity details")).toHaveCount(0);
  await page.getByRole("button", { name: "Reset map view" }).click();
  await expect.poll(async () => Math.hypot((await nodePosition()).x - initial.x, (await nodePosition()).y - initial.y)).toBeLessThan(1);
  const distanceFromCenter = async () => {
    const p = await nodePosition();
    return Math.hypot(p.x - bounds.width / 2, p.y - bounds.height / 2);
  };
  const beforeZoom = await distanceFromCenter();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect.poll(distanceFromCenter).toBeGreaterThan(beforeZoom + 2);
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await expect.poll(async () => Math.abs(await distanceFromCenter() - beforeZoom)).toBeLessThan(1);
  // A real context loss must recover without duplicating the canvas or losing access to entities.
  expect(await graphCanvas.evaluate((canvas) => {
    const extension = (canvas as HTMLCanvasElement).getContext("webgl2")?.getExtension("WEBGL_lose_context");
    if (!extension) return false;
    (canvas as HTMLCanvasElement & { lossExtension: WEBGL_lose_context }).lossExtension = extension;
    extension.loseContext();
    return true;
  })).toBe(true);
  await expect(page.getByText("The 3D map needs WebGL.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mara", exact: true })).toBeVisible();
  await graphCanvas.evaluate((canvas) => (canvas as HTMLCanvasElement & { lossExtension: WEBGL_lose_context }).lossExtension.restoreContext());
  await expect(page.getByText("The 3D map needs WebGL.", { exact: false })).toHaveCount(0);
  await expect(graphCanvas).toHaveCount(1);
  await expect(maraLabel).toBeVisible();
  // Pick the sphere itself using its projected center, not the HTML label/list.
  await graphCanvas.click({ position: await nodePosition() });
  await expect(
    page.getByRole("heading", { name: "Mara", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close details" }).click();
  await page.getByRole("button", { name: "The keeper", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "The keeper", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Entity details")
    .getByText("Source · Chapter 1", { exact: true })
    .first()
    .click();
  await expect(
    page.getByLabel("Entity details").locator("blockquote").first(),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Iona");
  await expect(page.locator("body")).not.toContainText("Tidekeepers");
  await expect(page.getByRole("button", { name: "Inspect The keeper", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: "test-results/graph.png", fullPage: true });
  await page.getByRole("button", { name: "Expand map", exact: true }).click();
  await expect(page.getByRole("button", { name: "Exit fullscreen map" })).toBeVisible();
  await page.getByRole("button", { name: "View The keeper details" }).click();
  await expect(page.getByRole("button", { name: "Expand map", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close details" }).click();
  await page.getByLabel("I’ve finished").selectOption("3");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Iona", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search story map").fill("Tidekeepers");
  await expect(
    page.getByRole("button", { name: "Tidekeepers", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Mara", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Search story map").fill("no such entity");
  await expect(page.getByText("No matches. Try another search or filter.")).toBeVisible();
  await expect(page.locator(".graph-canvas canvas")).toHaveCount(0);
  await page.getByLabel("Search story map").fill("");
  await page.getByRole("button", { name: "This chapter", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Bellweather Harbor", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Story so far", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Bellweather Harbor", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Chapter 1 A light", exact: false })
    .click();
  await expect(page.getByLabel("I’ve finished")).toHaveValue("3");
  await expect(
    page.getByRole("button", { name: "The keeper", exact: true }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Iona");
  await page.getByLabel("I’ve finished").selectOption("1");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByLabel("I’ve finished")).toHaveValue("1");
  await page.reload();
  await expect(page.getByLabel("I’ve finished")).toHaveValue("1");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "Story map" }).click();
  await page.getByRole("button", { name: "The keeper", exact: true }).click();
  await expect(page.getByLabel("Entity details")).toBeVisible();
  await page.getByRole("button", { name: "Close details" }).click();
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Your library", exact: true }).click();
  await expect(page.getByText("Chapter 1 of 3 completed")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome to Lorefold." }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});


test("entity evidence stays accessible without WebGL", async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") return null;
      return Reflect.apply(getContext, this, [type, ...args]);
    } as typeof getContext;
  });
  await openMap(page);
  await expect(page.getByText("The 3D map needs WebGL.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Zoom in", exact: true })).toBeDisabled();
  await page.getByLabel("Search story map").fill("no such entity");
  await expect(page.getByText("No matches. Try another search or filter.")).toBeVisible();
  await expect(page.getByText("The 3D map needs WebGL.", { exact: false })).toHaveCount(0);
  await page.getByLabel("Search story map").fill("");
  await page.getByRole("button", { name: "The keeper", exact: true }).click();
  await expect(page.getByRole("heading", { name: "The keeper", exact: true })).toBeVisible();
  await page.getByLabel("Entity details").getByText("Source · Chapter 1", { exact: true }).first().click();
  await expect(page.getByLabel("Entity details").locator("blockquote").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Iona");
});


test("a failed 3D module download leaves the book and entity list usable", async ({ page }) => {
  await page.route(/\/(src\/Graph\.tsx|assets\/Graph-[^/]+\.js)/, (route) => route.abort());
  await openMap(page);
  await expect(page.getByText("The 3D map couldn’t load.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Mara", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Mara", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload page", exact: true })).toBeVisible();
});

test("touch orbit and pinch zoom work with reduced motion on mobile", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openMap(page);
  const canvas = page.getByRole("img", { name: "3D story relationship map" });
  await canvas.scrollIntoViewIfNeeded();
  const bounds = (await canvas.boundingBox())!;
  const label = page.getByRole("button", { name: "Inspect Mara", exact: true });
  await expect(label).toBeVisible();
  const position = () => label.evaluate((node) => ({ x: parseFloat(node.style.left), y: parseFloat(node.style.top) }));
  const initial = await position();
  const cdp = await context.newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", points: { x: number; y: number; id: number }[]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  const x = bounds.x + 45, y = bounds.y + 75;
  await touch("touchStart", [{ x, y, id: 0 }]);
  for (let i = 1; i <= 8; i++) await touch("touchMove", [{ x: x + i * 10, y: y + i * 5, id: 0 }]);
  await touch("touchEnd", []);
  await expect.poll(async () => Math.hypot((await position()).x - initial.x, (await position()).y - initial.y)).toBeGreaterThan(5);
  await expect(page.getByLabel("Entity details")).toHaveCount(0);
  await page.getByRole("button", { name: "Reset map view" }).click();
  await expect.poll(async () => Math.hypot((await position()).x - initial.x, (await position()).y - initial.y)).toBeLessThan(1);
  const distance = async () => { const p = await position(); return Math.hypot(p.x - bounds.width / 2, p.y - bounds.height / 2); };
  const before = await distance();
  const center = bounds.x + bounds.width / 2;
  await touch("touchStart", [{ x: center - 40, y, id: 0 }, { x: center + 40, y, id: 1 }]);
  for (let i = 1; i <= 6; i++) await touch("touchMove", [{ x: center - 40 - i * 5, y, id: 0 }, { x: center + 40 + i * 5, y, id: 1 }]);
  await touch("touchEnd", []);
  await expect.poll(distance).toBeGreaterThan(before + 2);
  await expect(page.getByLabel("Entity details")).toHaveCount(0);
  await page.getByRole("button", { name: "Reset map view" }).click();
  await label.click();
  await expect(page.getByRole("heading", { name: "Mara", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close details" }).click();
  await page.screenshot({ path: "test-results/map-mobile.png", fullPage: true });
  await cdp.detach();
});
