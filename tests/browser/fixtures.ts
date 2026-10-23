import { test as base, expect } from "@playwright/test";
import { pool } from "../../backend/db/client.js";

// Playwright reuses a worker across spec files. Close its shared database pool
// only after all of those specs have cleaned up their own users and uploads.
export const test = base.extend<{}, { database: void }>({
  database: [async ({}, use) => {
    try { await use(); } finally { await pool.end(); }
  }, { scope: "worker", auto: true }],
});
export { expect };
