import { test, expect } from "./fixtures.js";

test("Google login starts from the server with a fixed same-origin return path", async ({ page }) => {
  await page.route("**/api/auth/providers", (route) => route.fulfill({ json: { google: true } }));
  await page.route("**/api/auth/sign-in/social", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      provider: "google", callbackURL: "/", errorCallbackURL: "/sign-in", disableRedirect: true,
    });
    await route.fulfill({ json: { url: "https://accounts.google.com/o/oauth2/v2/auth?synthetic=true" } });
  });
  // Exercise browser navigation without making a live Google request.
  await page.route("https://accounts.google.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Synthetic Google sign-in</h1>" }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await page.screenshot({ path: "test-results/sign-in-google-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page).toHaveURL(/^https:\/\/accounts\.google\.com\//);
  await expect(page.getByRole("heading", { name: "Synthetic Google sign-in" })).toBeVisible();
});

test("OAuth cancellation and start failures leave accessible email fallback on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/auth/providers", (route) => route.fulfill({ json: { google: true } }));
  await page.route("**/api/auth/sign-in/social", (route) => route.fulfill({ status: 503, json: { error: "Synthetic provider failure" } }));
  await page.goto("/sign-in?error=access_denied&error_description=Untrusted-provider-text");
  await expect(page.getByRole("alert")).toContainText("Google sign-in was cancelled");
  await expect(page.getByText("Untrusted-provider-text")).toHaveCount(0);
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page.getByRole("alert")).toContainText("Google sign-in could not be started");
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Open my space" })).toBeEnabled();
  await expect(page.getByLabel("Email address")).toBeVisible();
  await page.screenshot({ path: "test-results/sign-in-google-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("email remains available when Google is disabled or provider discovery fails", async ({ page }) => {
  for (const failed of [false, true]) {
    await page.route("**/api/auth/providers", (route) => route.fulfill({
      status: failed ? 503 : 200, json: failed ? { error: "Unavailable" } : { google: false },
    }));
    const discovery = page.waitForResponse("**/api/auth/providers");
    await page.goto("/");
    await discovery;
    await expect(page.getByRole("button", { name: "Open my space" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Continue with Google" })).toHaveCount(0);
    await page.unroute("**/api/auth/providers");
  }
});

test("OAuth failures give a safe explanation without rendering provider messages", async ({ page }) => {
  for (const [code, message] of [
    ["signup_disabled", "same email as your Lorefold invitation"],
    ["google_email_unverified", "verified email address"],
    ["unknown-provider-error", "could not be completed"],
  ]) {
    await page.goto(`/sign-in?error=${code}&error_description=Untrusted-provider-text`);
    await expect(page.getByRole("alert")).toContainText(message);
    await expect(page.getByText("Untrusted-provider-text")).toHaveCount(0);
  }
});
