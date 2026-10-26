import { test, expect } from "./fixtures.js";
import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../backend/db/client.js";
import { user } from "../../backend/db/schema.js";
import { provisionUser } from "../../backend/provision-user.js";
import { seedSample } from "../../backend/db/sample.js";
import { midnightTheme, type ThemeLibrary } from "../../shared/themes.js";
import { themeFontPairings, themeFonts } from "../../shared/theme-fonts.js";

const email = `theme-browser-${randomUUID()}@example.test`, password = randomUUID();
let userId: string;
test.beforeAll(async () => {
  userId = await provisionUser(email, password, "Theme reader");
  await seedSample(userId);
});
test.afterAll(async () => { if (userId) await db.delete(user).where(eq(user.id, userId)); });
async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Open my space" }).click();
  await expect(page.getByRole("heading", { name: /^Your universes/ })).toBeVisible();
}
async function nav(page: Page, name: string) {
  if (name === "Themes") {
    await page.getByRole("button", { name: "User settings", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings navigation" }).getByRole("button", { name: "Themes", exact: true }).click();
    return;
  }
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name, exact: true }).click();
}
async function css(page: Page, property: string) {
  return page.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), property);
}
async function selectedFonts(page: Page) {
  return {
    body: await page.getByLabel("Interface font", { exact: true }).inputValue(),
    heading: await page.getByLabel("Heading font", { exact: true }).inputValue(),
    reading: await page.getByLabel("Reading font", { exact: true }).inputValue(),
  };
}
async function save(page: Page) {
  await page.getByRole("button", { name: "Save theme", exact: true }).click();
  await expect(page.getByText("Theme saved. Select it for the main page or inside a universe.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save theme", exact: true })).toBeDisabled();
}
async function setRange(page: Page, name: string, steps: number) {
  const range = page.getByRole("slider", { name, exact: true });
  await range.focus(); await range.press("Home");
  for (let i = 0; i < steps; i++) await range.press("ArrowRight");
}

async function checkFontCatalog(page: Page, fontRequests: string[]) {
  for (const label of ["Interface font", "Heading font", "Reading font"]) {
    const picker = page.getByLabel(label, { exact: true });
    await expect(picker.locator("option")).toHaveCount(Object.keys(themeFonts).length);
    expect(await picker.locator("option").count()).toBeGreaterThanOrEqual(20);
    await expect(picker.locator("optgroup")).toHaveCount(4);
  }
  const families = Object.values(themeFonts).filter((font) => "source" in font).map((font) => font.family.split('"')[1]);
  const initiallyLoaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...new Set([...document.fonts].filter((font) => font.status === "loaded").map((font) => font.family.replaceAll('"', "")))];
  });
  expect(initiallyLoaded.length).toBeLessThan(families.length);
  // Explicitly exercise every packaged family, including italics, bold, and
  // extended Latin. An empty result would silently leave a fallback font in use.
  for (const family of families) for (const style of ["400", "700", "italic 400", "italic 700"]) {
    const loaded = await page.evaluate(async ({ family, style }) => {
      const faces = await document.fonts.load(`${style} 20px "${family}"`, "The archive’s hidden worlds. Příběh ľudí – Łódź.");
      return faces.length > 0 && faces.every((face) => face.status === "loaded");
    }, { family, style });
    expect(loaded, `${family} ${style}`).toBe(true);
  }
  expect(fontRequests.length).toBeGreaterThan(0);
  for (const url of fontRequests) expect(new URL(url).origin).toBe(new URL(page.url()).origin);

}

test("saved themes preview live, persist, inherit into books, and fall back after deletion", async ({ page }) => {
  const errors: string[] = [];
  const fontRequests: string[] = [];
  page.on("request", (request) => { if (request.resourceType() === "font") fontRequests.push(request.url()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(page);
  await nav(page, "Themes");
  await checkFontCatalog(page, fontRequests);
  await page.getByLabel("Theme name", { exact: true }).fill("Midnight tide");
  await page.getByRole("button", { name: "Midnight", exact: true }).click();
  const preview = page.getByLabel("Live theme preview");
  await expect(preview.locator(".theme-surface")).toHaveCSS("background-color", "rgb(23, 25, 34)");
  expect(await css(page, "--background")).toBe("#f6f5f1");
  const chosen = { body: "sourceSans", heading: "fraunces", reading: "ibmPlexMono" } as const;
  await page.getByLabel("Interface font", { exact: true }).selectOption(chosen.body);
  await page.getByLabel("Heading font", { exact: true }).selectOption(chosen.heading);
  await page.getByLabel("Reading font", { exact: true }).selectOption(chosen.reading);
  await setRange(page, "Interface text size", 4);
  await setRange(page, "Reading text size", 8);
  await setRange(page, "Rounded corners", 0);
  await setRange(page, "Interface spacing", 8);
  await expect(preview.locator(".theme-surface")).toHaveCSS("font-size", "16px");
  await expect(preview.locator(".theme-preview-card")).toHaveCSS("padding-top", "26.4px");
  await expect(preview.locator(".theme-reading")).toHaveCSS("font-size", "24px");
  await expect(preview.locator(".theme-preview-card")).toHaveCSS("border-radius", "0px");
  await expect(preview.locator(".theme-preview-content > .muted")).toHaveCSS("font-family", themeFonts.sourceSans.family);
  await expect(preview.locator("h2")).toHaveCSS("font-family", themeFonts.fraunces.family);
  await expect(preview.locator(".theme-reading")).toHaveCSS("font-family", themeFonts.ibmPlexMono.family);
  // A palette edit updates the GPU scene in place: no reset of camera or selection.
  const canvas = preview.getByRole("img", { name: "3D story relationship map" });
  await expect(canvas).toBeVisible();
  await preview.getByRole("button", { name: "Inspect Mira", exact: true }).click();
  await expect(preview.getByRole("button", { name: "Inspect Mira", exact: true })).toHaveAttribute("aria-pressed", "true");
  await canvas.evaluate((element) => element.setAttribute("data-theme-test", "same-canvas"));
  const labelPosition = () => preview.getByRole("button", { name: "Inspect Mira", exact: true }).evaluate((element) => [element.style.left, element.style.top]);
  const position = await labelPosition();
  const before = await canvas.screenshot();
  await page.getByLabel("Characters", { exact: true }).fill("#ff4400");
  await expect(canvas).toHaveAttribute("data-theme-test", "same-canvas");
  await expect.poll(labelPosition).toEqual(position);
  expect((await canvas.screenshot()).equals(before)).toBe(false);
  await page.getByRole("heading", { name: "Your themes", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/themes-editor-desktop.png", fullPage: true });
  await save(page);
  await page.getByLabel("Main page & library", { exact: true }).selectOption({ label: "Midnight tide" });
  await expect.poll(() => css(page, "--background")).toBe("#171922");
  await page.reload();
  await expect.poll(() => css(page, "--background")).toBe("#171922");
  await expect(page.getByLabel("Main page & library", { exact: true })).not.toHaveValue("");
  await page.getByLabel("Saved themes", { exact: true }).selectOption({ label: "Midnight tide" });
  expect(await selectedFonts(page)).toEqual(chosen);
  for (const role of ["body", "heading", "reading"] as const) expect(await css(page, `--font-${role}`)).toBe(themeFonts[chosen[role]].family);
  await page.getByRole("group", { name: "Typography", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/theme-fonts-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("group", { name: "Typography", exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/theme-fonts-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1080 });
  await expect(page.getByRole("slider", { name: "Rounded corners", exact: true })).toHaveValue("0");

  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByLabel("Theme name", { exact: true }).fill("Coral harbor");
  await page.getByLabel("Accent", { exact: true }).fill("#c34650");
  await save(page);
  await page.getByRole("button", { name: "Duplicate as new", exact: true }).click();
  await expect(page.getByLabel("Theme name", { exact: true })).toHaveValue("Coral harbor copy");
  await save(page);
  const themes = await page.request.get("/api/themes");
  const saved: ThemeLibrary = await themes.json();
  expect(saved.themes).toHaveLength(3);
  expect(saved.themes.find((theme) => theme.name === "Midnight tide")?.config.typography).toMatchObject(chosen);
  expect(new Set(saved.themes.map((theme) => theme.id)).size).toBe(3);

  await nav(page, "Universes");
  await page.getByRole("button", { name: /Bellweather/ }).click();
  await page.getByLabel("Universe theme", { exact: true }).selectOption({ label: "Coral harbor" });
  await expect.poll(() => css(page, "--accent")).toBe("#c34650");
  await page.reload();
  await expect.poll(() => css(page, "--accent")).toBe("#c34650");
  await page.getByRole("button", { name: "Open The Lantern at Bellweather", exact: true }).click();
  await expect(page.getByLabel("I’ve finished")).toBeVisible();
  await expect.poll(() => css(page, "--accent")).toBe("#c34650");
  await page.getByLabel("I’ve finished").selectOption("1");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "A light in the fog" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Iona");
  await nav(page, "My library");
  await expect.poll(() => css(page, "--background")).toBe("#171922");

  // Saved edits update each assignment, and deletion safely removes only the assignment.
  await nav(page, "Themes");
  await page.getByLabel("Saved themes", { exact: true }).selectOption({ label: "Coral harbor" });
  await page.getByLabel("Accent", { exact: true }).fill("#a83355");
  await save(page);
  await nav(page, "Universes");
  await page.getByRole("button", { name: /Bellweather/ }).click();
  await expect.poll(() => css(page, "--accent")).toBe("#a83355");
  await nav(page, "Themes");
  await page.getByLabel("Saved themes", { exact: true }).selectOption({ label: "Coral harbor" });
  await page.getByRole("button", { name: "Delete theme", exact: true }).click();
  await page.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(page.getByText("Theme deleted. Its assignments now use their default.", { exact: true })).toBeVisible();
  await nav(page, "Universes");
  await page.getByRole("button", { name: /Bellweather/ }).click();
  await expect(page.getByLabel("Universe theme", { exact: true })).toHaveValue("");
  await expect.poll(() => css(page, "--background")).toBe("#171922");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/themes-universe-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Welcome to Lorefold." })).toBeVisible();
  expect(await css(page, "--background")).toBe("#f6f5f1");
  expect(errors).toEqual([]);
});

test("mobile editor keeps failed saves and unsaved changes, and default deletion restores the original", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const created = await page.request.post("/api/themes", { headers: { origin: process.env.APP_ORIGIN! }, data: { name: "Mobile midnight", config: midnightTheme } });
  expect(created.ok()).toBe(true);
  const { theme } = await created.json();
  expect((await page.request.put("/api/preferences/theme", { headers: { origin: process.env.APP_ORIGIN! }, data: { themeId: theme.id } })).ok()).toBe(true);
  await page.reload();
  await nav(page, "Themes");
  await page.getByLabel("Theme name", { exact: true }).fill("Mobile draft");
  await page.getByLabel("Accent", { exact: true }).fill("#cc5500");
  await page.route("**/api/themes", (route) => route.fulfill({ status: 503, json: { error: "Saving is temporarily unavailable." } }));
  await page.getByRole("button", { name: "Save theme", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Saving is temporarily unavailable.");
  await expect(page.getByLabel("Theme name", { exact: true })).toHaveValue("Mobile draft");
  await page.unroute("**/api/themes");
  page.once("dialog", (dialog) => dialog.dismiss());
  await nav(page, "Universes");
  await expect(page).toHaveURL(/\/settings\/themes$/);
  await page.getByRole("button", { name: "Revert changes", exact: true }).click();
  await expect(page.getByLabel("Theme name", { exact: true })).toHaveValue("My theme");
  await page.getByLabel("Saved themes", { exact: true }).selectOption({ label: "Mobile midnight" });
  await page.getByRole("button", { name: "View preview", exact: true }).click();
  await page.screenshot({ path: "test-results/themes-editor-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Delete theme", exact: true }).click();
  await page.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect.poll(() => css(page, "--background")).toBe("#f6f5f1");
  await expect(page.getByLabel("Main page & library", { exact: true })).toHaveValue("");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your themes", exact: true })).toBeVisible();
  expect(await css(page, "--background")).toBe("#f6f5f1");
});

test("user settings owns themes, preserves bookmarks, and guards unsaved navigation", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Themes" })).toHaveCount(0);
  await page.getByRole("button", { name: "User settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { name: "User settings", exact: true })).toBeVisible();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Customize your themes" }).click();
  await expect(page).toHaveURL(/\/settings\/themes$/);
  await page.getByLabel("Theme name", { exact: true }).fill("Unfinished settings draft");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("navigation", { name: "Settings navigation" }).getByRole("button", { name: "Account", exact: true }).click();
  await expect(page.getByLabel("Theme name", { exact: true })).toHaveValue("Unfinished settings draft");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("navigation", { name: "Settings navigation" }).getByRole("button", { name: "Account", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Your themes", exact: true })).toBeVisible();
  await page.goto("/themes");
  await expect(page).toHaveURL(/\/settings\/themes$/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your themes", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "User settings", exact: true }).click();
  await page.screenshot({ path: "test-results/user-settings-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.goto("/settings/themes");
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your themes", exact: true })).toHaveCount(0);
});

test("generator prefills light and dark drafts, protects edits, and saves reusable themes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1080 });
  await signIn(page);
  await nav(page, "Themes");
  const generator = page.getByRole("form", { name: "Theme generator", exact: true });
  const preview = page.getByLabel("Live theme preview").locator(".theme-surface");
  const originalBackground = await css(page, "--background");
  const count = (await (await page.request.get("/api/themes")).json()).themes.length;
  await generator.getByRole("radio", { name: "Dark", exact: true }).check();
  await generator.getByLabel("Base color", { exact: true }).fill("#ffcc00");
  await generator.getByLabel("Style", { exact: true }).selectOption("terminal");
  await expect(page.getByLabel("Control appearance", { exact: true })).toHaveValue("light");
  await generator.getByRole("button", { name: "Generate theme", exact: true }).click();
  await expect(page.getByLabel("Control appearance", { exact: true })).toHaveValue("dark");
  let previousFonts = await selectedFonts(page);
  expect(themeFontPairings.terminal.map(({ fonts }) => fonts)).toContainEqual(previousFonts);
  const spacing = Number(await page.getByRole("slider", { name: "Interface spacing", exact: true }).inputValue());
  expect(spacing).toBeGreaterThanOrEqual(.85);
  expect(spacing).toBeLessThanOrEqual(1);
  await expect(preview).toHaveCSS("color-scheme", "dark");
  const draftPalette = () => page.locator('.theme-editor-form input[id^="theme-"]').evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
  let previousPalette = await draftPalette();
  let previousRadius = await page.getByRole("slider", { name: "Rounded corners", exact: true }).inputValue();
  for (let i = 0; i < 3; i++) {
    // Playwright dismisses unexpected dialogs: this also proves that cycling
    // generated drafts does not require confirming a discard every time.
    await generator.getByRole("button", { name: "Generate theme", exact: true }).click();
    const nextPalette = await draftPalette();
    expect(nextPalette).not.toEqual(previousPalette);
    const nextRadius = await page.getByRole("slider", { name: "Rounded corners", exact: true }).inputValue();
    expect(nextRadius).not.toBe(previousRadius);
    const nextFonts = await selectedFonts(page);
    for (const role of ["body", "heading", "reading"] as const) expect(nextFonts[role]).not.toBe(previousFonts[role]);
    expect(themeFontPairings.terminal.map(({ fonts }) => fonts)).toContainEqual(nextFonts);
    previousFonts = nextFonts;
    previousPalette = nextPalette; previousRadius = nextRadius;
  }
  await expect(generator.getByLabel("Base color", { exact: true })).toHaveValue("#ffcc00");
  await expect(generator.getByRole("radio", { name: "Dark", exact: true })).toBeChecked();
  await expect(generator.getByLabel("Style", { exact: true })).toHaveValue("terminal");
  expect(await selectedFonts(page)).toEqual(previousFonts);
  const darkBackground = await page.getByLabel("Page background", { exact: true }).inputValue();
  expect(await css(page, "--background")).toBe(originalBackground);
  expect((await (await page.request.get("/api/themes")).json()).themes).toHaveLength(count);
  await generator.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/theme-generator-desktop.png" });
  await page.getByLabel("Theme name", { exact: true }).fill("Generated midnight");
  await save(page);
  await page.getByLabel("Main page & library", { exact: true }).selectOption({ label: "Generated midnight" });
  await expect.poll(() => css(page, "--background")).toBe(darkBackground);
  await page.reload();
  await page.getByLabel("Saved themes", { exact: true }).selectOption({ label: "Generated midnight" });
  await expect(page.getByLabel("Control appearance", { exact: true })).toHaveValue("dark");
  await expect(generator.getByRole("radio", { name: "Dark", exact: true })).toBeChecked();
  expect(await selectedFonts(page)).toEqual(previousFonts);
  await expect(generator.getByLabel("Style", { exact: true })).toHaveValue("terminal");

  await generator.getByRole("radio", { name: "Light", exact: true }).check();
  await generator.getByLabel("Style", { exact: true }).selectOption("modern");
  await generator.getByRole("button", { name: "Generate theme", exact: true }).click();
  await expect(preview).toHaveCSS("color-scheme", "light");
  expect(themeFontPairings.modern.map(({ fonts }) => fonts)).toContainEqual(await selectedFonts(page));
  const lightBackground = await page.getByLabel("Page background", { exact: true }).inputValue();
  expect(lightBackground).not.toBe(darkBackground);
  expect(await css(page, "--background")).toBe(darkBackground);
  await page.getByRole("button", { name: "Duplicate as new", exact: true }).click();
  await page.getByLabel("Theme name", { exact: true }).fill("Generated daylight");
  await save(page);
  const saved: ThemeLibrary = await (await page.request.get("/api/themes")).json();
  expect(saved.themes.find((theme) => theme.name === "Generated midnight")?.config.mode).toBe("dark");
  expect(saved.themes.find((theme) => theme.name === "Generated daylight")?.config.mode).toBe("light");
  await page.reload();
  await page.getByLabel("Saved themes", { exact: true }).selectOption({ label: "Generated daylight" });
  await expect(page.getByLabel("Page background", { exact: true })).toHaveValue(lightBackground);
  await expect(generator.getByLabel("Style", { exact: true })).toHaveValue("modern");

  await page.getByLabel("Accent", { exact: true }).fill("#123456");
  await generator.getByLabel("Base color", { exact: true }).fill("#2f6688");
  page.once("dialog", (dialog) => dialog.dismiss());
  await generator.getByRole("button", { name: "Generate theme", exact: true }).click();
  await expect(page.getByLabel("Accent", { exact: true })).toHaveValue("#123456");
  page.once("dialog", (dialog) => dialog.accept());
  await generator.getByRole("button", { name: "Generate theme", exact: true }).click();
  await expect(page.getByLabel("Accent", { exact: true })).not.toHaveValue("#123456");
  await page.getByRole("button", { name: "Revert changes", exact: true }).click();
  await expect(page.getByLabel("Page background", { exact: true })).toHaveValue(lightBackground);
  await generator.getByLabel("Base color", { exact: true }).fill("#oops");
  await expect(generator.getByRole("button", { name: "Generate theme", exact: true })).toBeDisabled();
  await generator.getByLabel("Base color", { exact: true }).fill("#228866");
  await page.setViewportSize({ width: 390, height: 844 });
  await generator.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/theme-generator-mobile.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
