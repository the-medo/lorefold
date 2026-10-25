import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { mockAnalysis, parseAnalysis, prompt, PROMPT_VERSION } from "./analysis.js";
import { MODELS, PRICE_DATE, type Model } from "./models.js";
import { contextFor, hash, type Chapter } from "./source.js";
import { costUSD, reservation, type Provider, type ProviderResult } from "./provider.js";

export type Manifest = {
  version: 1; id: string; createdAt: string; mode: "mock" | "live";
  promptVersion: string; priceDate: string; models: Model[]; chapters: Chapter[];
  sourceHash: string; maxOutput: number; contextChars: number; budgetUSD: number;
  gateway: { accountId: string; gatewayId: string } | null;
};
export type Entry = {
  model: string; chapter: number; status: "in-flight" | "complete" | "failed";
  reservedUSD: number; chargedEstimateUSD: number | null;
  startedAtMs: number; durationMs: number | null; result?: ProviderResult;
  analysis?: ReturnType<typeof parseAnalysis>; error?: string;
};
export function manifest(options: Pick<Manifest, "mode" | "models" | "chapters" | "maxOutput" | "contextChars" | "budgetUSD" | "gateway">): Manifest {
  return { version: 1, id: randomUUID(), createdAt: new Date().toISOString(), promptVersion: PROMPT_VERSION,
    priceDate: PRICE_DATE, sourceHash: hash(JSON.stringify(options.chapters)), ...options };
}
export function plan(run: Manifest) {
  return run.chapters.flatMap((chapter, position) => {
    const context = contextFor(run.chapters, position, run.contextChars);
    const p = prompt(context);
    return run.models.map(model => {
      const call = { model, prompt: p, maxOutput: run.maxOutput, runId: run.id, chapter: chapter.number };
      return { call, context, reservation: reservation(call), promptHash: hash(JSON.stringify(p)) };
    });
  });
}

async function atomicJSON(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  const parent = await open(dirname(path), "r");
  try { await parent.sync(); } finally { await parent.close(); }
}

export async function readManifest(directory: string): Promise<Manifest> {
  const value = JSON.parse(await readFile(join(directory, "run.json"), "utf8")) as Manifest;
  if (value.version !== 1 || !["mock", "live"].includes(value.mode) || value.promptVersion !== PROMPT_VERSION || value.priceDate !== PRICE_DATE || hash(JSON.stringify(value.chapters)) !== value.sourceHash ||
      !Array.isArray(value.models) || !value.models.length || new Set(value.models.map(m => m.key)).size !== value.models.length ||
      value.models.some(m => JSON.stringify(m) !== JSON.stringify(MODELS.find(known => known.key === m.key))) ||
      !Number.isFinite(value.budgetUSD) || value.budgetUSD <= 0 || value.budgetUSD > 20 ||
      !Number.isInteger(value.maxOutput) || value.maxOutput < 128 || value.maxOutput > 32768 ||
      !Number.isInteger(value.contextChars) || value.contextChars < 0 || value.contextChars > 100000)
    throw new Error("Run is incompatible or its source has changed; refusing to resume.");
  return value;
}

export async function createRun(root: string, run: Manifest): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = join(root, run.id);
  await mkdir(directory, { mode: 0o700 });
  await atomicJSON(join(directory, "run.json"), run);
  return directory;
}

function filename(model: string, chapter: number) { return `${model}-chapter-${chapter}.json`; }
async function readEntry(directory: string, model: string, chapter: number): Promise<Entry | null> {
  try {
    const entry = JSON.parse(await readFile(join(directory, filename(model, chapter)), "utf8")) as Entry;
    if (entry.model !== model || entry.chapter !== chapter || !["in-flight", "complete", "failed"].includes(entry.status) || !Number.isFinite(entry.reservedUSD) || entry.reservedUSD < 0 ||
        (entry.chargedEstimateUSD !== null && (!Number.isFinite(entry.chargedEstimateUSD) || entry.chargedEstimateUSD < 0)) ||
        !Number.isFinite(entry.startedAtMs) || entry.startedAtMs <= 0)
      throw new Error("Invalid checkpoint");
    return entry;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Unreadable checkpoint; refusing to risk repeating a billed request.");
  }
}
export const accounted = (entry: Entry) => entry.chargedEstimateUSD ?? entry.reservedUSD;

export async function runBenchmark(directory: string, run: Manifest, provider?: Provider, options: {
  intervalMs?: number; signal?: AbortSignal; progress?: (text: string) => void;
} = {}) {
  const items = plan(run);
  if (run.mode === "live" && !provider) throw new Error("Live provider is required.");
  const lockPath = join(directory, ".lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch { throw new Error("Run is locked. After a hard crash, confirm its process has stopped before deleting .lock."); }
  await lock.writeFile(String(process.pid));
  const entries: Entry[] = [];
  let lastCall = 0;
  try {
    // Read every old reservation before dispatch, including later chapters/models.
    const saved = new Map<string, Entry>();
    for (const item of items) {
      const old = await readEntry(directory, item.call.model.key, item.call.chapter);
      if (old) saved.set(filename(old.model, old.chapter), old);
    }
    let spent = [...saved.values()].reduce((n, e) => n + accounted(e), 0);
    lastCall = Math.max(0, ...[...saved.values()].map(e => e.startedAtMs));
    for (const item of items) {
      const { call, context } = item;
      const name = filename(call.model.key, call.chapter);
      const old = saved.get(name);
      if (old) { entries.push(old); continue; }
      if (options.signal?.aborted) break;
      const reservedUSD = run.mode === "live" ? item.reservation.costUSD : 0;
      if (spent + reservedUSD > run.budgetUSD) {
        options.progress?.("Budget reservation exhausted; remaining requests were not sent."); break;
      }
      if (run.mode === "live") {
        const wait = Math.max(0, lastCall + (options.intervalMs ?? 6100) - Date.now());
        if (wait) {
          try { await delay(wait, undefined, { signal: options.signal }); }
          catch { break; }
        }
      }
      const entry: Entry = { model: call.model.key, chapter: call.chapter, status: "in-flight",
        reservedUSD, chargedEstimateUSD: null, startedAtMs: Date.now(), durationMs: null };
      // Persist the reservation BEFORE a request. A lost response is never silently retried.
      await atomicJSON(join(directory, name), entry);
      const start = Date.now(); lastCall = start;
      try {
        const result = run.mode === "mock" ? { text: JSON.stringify(mockAnalysis(context)), usage: null, reportedModel: "deterministic-mock", truncated: false } : await provider!(call);
        entry.result = result;
        entry.chargedEstimateUSD = run.mode === "mock" ? 0 : result.usage ? costUSD(call.model, result.usage) : null;
        entry.analysis = parseAnalysis(result.text, context);
        if (result.truncated) { entry.analysis.validation.valid = false; entry.analysis.validation.issues.push("Provider did not finish normally (possibly output limit)."); }
        entry.status = "complete";
      } catch (error) {
        entry.status = "failed";
        // Provider errors are sanitized at the transport boundary; never persist arbitrary exceptions.
        entry.error = error instanceof Error && /^(Gateway|Provider) /.test(error.message) ? error.message : "Provider call failed; billing is unknown. No automatic retry.";
      }
      entry.durationMs = Date.now() - start;
      await atomicJSON(join(directory, name), entry);
      entries.push(entry); spent += accounted(entry);
      options.progress?.(`${call.model.key}, chapter ${call.chapter}: ${entry.status}${entry.analysis ? entry.analysis.validation.valid ? " (evidence references valid)" : " (validation failed)" : ""}`);
    }
    // Include old reservations even if a newly hit budget/interrupt ended traversal early.
    for (const old of saved.values()) if (!entries.some(e => e.model === old.model && e.chapter === old.chapter)) entries.push(old);
    const report = {
      mode: run.mode, runId: run.id, sourceHash: run.sourceHash, priceDate: run.priceDate,
      expectedCalls: items.length, recordedCalls: entries.length,
      estimatedCostUSD: entries.reduce((n, e) => n + (e.chargedEstimateUSD ?? 0), 0),
      unknownCostReservationsUSD: entries.filter(e => e.chargedEstimateUSD === null).reduce((n, e) => n + e.reservedUSD, 0),
      budgetUSD: run.budgetUSD,
      humanReviewRequired: true,
      entries,
    };
    await atomicJSON(join(directory, "report.json"), report);
    const lines = ["# Book model benchmark", "", `Mode: **${run.mode}**. ${run.mode === "mock" ? "Deterministic plumbing test only; no model quality or measured token usage." : "Costs use reported token usage at uncached standard rates; not an invoice."}`, "",
      `Calls recorded: ${entries.length}/${items.length}. Estimated cost: $${report.estimatedCostUSD.toFixed(4)}. Unknown-cost reservations: $${report.unknownCostReservationsUSD.toFixed(4)}.`, "",
      "| Model | Chapter | Status | Valid references | Matched quotes | Input / output tokens | Seconds | Cost / reservation USD |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...entries.map(e => `| ${e.model} | ${e.chapter} | ${e.status} | ${e.analysis?.validation.valid ?? "—"} | ${e.analysis ? `${e.analysis.validation.matchedCitations}/${e.analysis.validation.citations}` : "—"} | ${e.result?.usage ? `${e.result.usage.inputTokens}/${e.result.usage.outputTokens}` : "unknown"} | ${e.durationMs === null ? "—" : (e.durationMs / 1000).toFixed(1)} | ${e.chargedEstimateUSD === null ? "reserved " : ""}${accounted(e).toFixed(4)} |`), "",
      "## Review before selecting a model", "",
      "Quote matching does not prove a claim follows from its evidence, detect every spoiler from model memory, or measure completeness. Inspect each private response JSON against run.json. Compare recap accuracy, missed entities, alias timing, relationship support, and unsupported lore. Do not rank models by entity count alone.", "",
      "No generated knowledge is imported into the application. Failed/in-flight calls are not retried on resume. Unknown usage retains its reservation. Gateway spend limits and local reservations are best-effort controls, not guaranteed billing caps.", ""];
    await writeFile(join(directory, "report.md"), lines.join("\n"), { mode: 0o600 });
    const complete = entries.length === items.length && entries.every(e => e.status === "complete" && e.analysis?.validation.valid && (run.mode === "mock" || e.result?.usage != null));
    return { report, complete };
  } finally { await lock.close(); await rm(lockPath); }
}
