import { test, expect } from "./fixtures.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../backend/db/client.js";
import { user } from "../../backend/db/schema.js";
import { provisionUser } from "../../backend/provision-user.js";
import { auth } from "../../backend/auth.js";
import type { AISettings } from "../../shared/ai.js";

const email = `ai-browser-${randomUUID()}@example.test`, password = randomUUID();
let id: string;
let sessionCookies: { name: string; value: string; url: string }[];
test.beforeAll(async () => {
  id = await provisionUser(email, password, "AI reader");
  // Exercise settings with a real Better Auth session. Login UI is covered by
  // the reading/sign-in specs; avoid exhausting the preview's shared IP limit.
  const response = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  expect(response.status).toBe(200);
  sessionCookies = response.headers.getSetCookie().map(header => {
    const cookie = header.split(";")[0], separator = cookie.indexOf("=");
    return { name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: process.env.APP_ORIGIN! };
  });
});
test.beforeEach(async ({ context }) => { await context.addCookies(sessionCookies); });
test.afterAll(async () => { if (id) await db.delete(user).where(eq(user.id, id)); });

test("account AI preference persists through reload on the private browser origin", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "User settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings navigation" }).getByRole("button", { name: "AI & connections" }).click();
  await expect(page).toHaveURL(/\/settings\/ai$/);
  await expect(page.getByLabel("Analysis model")).toHaveValue("gpt-6-astra");
  await expect(page.getByLabel("Reasoning effort")).toHaveValue("high");
  await expect(page.getByText("Not connected", { exact: true })).toBeVisible();
  await expect(page.getByText(/analysis from the app is not available yet/)).toBeVisible();
  await page.getByLabel("Analysis model").selectOption("gpt-6.1-sol");
  await page.getByLabel("Reasoning effort").selectOption("xhigh");
  await page.getByRole("button", { name: "Save default model" }).click();
  await expect(page.getByRole("status")).toHaveText("Default model saved.");
  await page.reload();
  await expect(page.getByLabel("Analysis model")).toHaveValue("gpt-6.1-sol");
  await expect(page.getByLabel("Reasoning effort")).toHaveValue("xhigh");
  const saved = await page.request.get("/api/settings/ai");
  expect((await saved.json()).preference).toEqual({ model: "gpt-6.1-sol", effort: "xhigh" });
  await page.screenshot({ path: "test-results/ai-settings-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/ai-settings-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("connection UI guides the callback, reports completion, and supports disconnect and retry", async ({ page }) => {
  const state: AISettings = { preference: { model: "gpt-6-astra", effort: "high" }, chatgpt: {
    enabled: true, connected: false, planEnabled: false, email: null, registered: false, pending: false,
  } };
  let progress = "pending", disconnects = 0;
  await page.route("**/api/settings/ai", route => route.fulfill({ json: state }));
  await page.route("**/api/connections/chatgpt", async route => {
    if (route.request().method() === "DELETE") {
      disconnects++; state.chatgpt.connected = false; state.chatgpt.planEnabled = false;
      await route.fulfill({ json: { revoked: false } });
    } else await route.fulfill({ json: { authorizationUrl: "https://auth.openai.com/api/accounts/authorize?synthetic=true", expiresAt: new Date(Date.now() + 1200000).toISOString(), tunnelCommand: "ssh -N -L 127.0.0.1:15190:127.0.0.1:15190 reader@private.example" } });
  });
  await page.route("**/api/connections/chatgpt/attempt", route => route.fulfill({ json: { state: progress } }));
  await page.goto("/settings/ai");
  await page.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await expect(page.getByRole("heading", { name: "Finish connecting" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue with ChatGPT" })).toHaveAttribute("href", /^https:\/\/auth\.openai\.com\//);
  await expect(page.getByText(/ssh -N -L/)).toBeVisible();
  state.chatgpt = { ...state.chatgpt, connected: true, planEnabled: true, email: "reader@example.test", registered: true };
  progress = "complete";
  await expect(page.getByText("Connected · plan access enabled", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Disconnect ChatGPT" }).click();
  await expect(page.getByRole("status")).toContainText("revocation could not be confirmed");
  await expect(page.getByText("Not connected", { exact: true })).toBeVisible();
  expect(disconnects).toBe(1);
  progress = "failed";
  await page.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await expect(page.getByRole("alert")).toContainText("could not be verified");
  await expect(page.getByRole("button", { name: "Continue with ChatGPT" })).toBeEnabled();
});
