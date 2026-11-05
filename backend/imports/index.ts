import { setTimeout } from "node:timers/promises";
import { pool } from "../db/client.js";
import { runNextImport } from "./worker.js";
if (process.env.IMPORT_CONCURRENCY && process.env.IMPORT_CONCURRENCY !== "1") throw new Error("Import concurrency must be one.");
const controller = new AbortController();
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());
try {
  while (!controller.signal.aborted) {
    try { if (await runNextImport({ signal: controller.signal })) continue; }
    catch { console.error("Import worker unavailable; retrying database connection."); }
    await setTimeout(2000, undefined, { signal: controller.signal }).catch(() => {});
  }
} finally { await pool.end(); }
