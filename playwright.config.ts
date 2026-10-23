import { defineConfig } from "@playwright/test";

if (!process.env.LOREFOLD_WORKTREE_ID || !process.env.APP_ORIGIN)
  throw new Error("Run browser tests through the worktree launcher.");
export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  use: {
    baseURL: process.env.APP_ORIGIN,
    trace: "retain-on-failure",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
      args: ["--enable-unsafe-swiftshader"],
    },
  },
  webServer: {
    command: "node scripts/dev.mjs",
    url: process.env.APP_ORIGIN,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 7_000 },
  },
});
