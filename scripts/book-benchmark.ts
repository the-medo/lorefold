import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { syntheticChapters } from "./book-benchmark/analysis.js";
import { MODELS, selectModels } from "./book-benchmark/models.js";
import { credentials, liveProvider } from "./book-benchmark/provider.js";
import { createRun, manifest, plan, readManifest, runBenchmark, type Manifest } from "./book-benchmark/runner.js";
import { numbers, readEpub, selectChapters } from "./book-benchmark/source.js";

const HELP = `Usage: npm run benchmark:book -- [options]

Default: three original synthetic chapters, all six models, deterministic mock, no network.
  --epub PATH           Read a private EPUB (never copied into Git)
  --list                List spine sections and word counts; no analysis
  --chapters 1,2,3      Select exact "Chapter N" navigation labels (default)
  --sections 5,6,7      Select whole XHTML sections explicitly instead
  --models gpt,claude,glm,deepseek,oss,gemma
  --plan                Show requests and conservative cost reservations; no network
  --live                Send billable requests; requires explicit development config
  --budget-usd 2        Local reservation budget, USD (default 2; maximum 20)
  --max-output 8192     Per-call output limit, including reasoning where supported
  --context-chars 16000 Earlier selected source text allowance (whole paragraphs)
  --resume RUN_ID       Resume only unsent calls; use --live again for a live run
  --help                Show this help

Live config: LOREFOLD_BENCHMARK_LIVE=1, CLOUDFLARE_ACCOUNT_ID,
CLOUDFLARE_AI_GATEWAY_ID, CLOUDFLARE_API_TOKEN (server-side environment only).
Use scripts/worktree-dev/lorefold-worktree-dev run -- npm run benchmark:book -- ...
Private checkpoints/reports: .lorefold/benchmarks/<run-id>/
See docs/book-benchmark.md for limits, credential setup and manual quality review.`;

function integer(value: string, name: string, min: number, max: number) {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return number;
}

async function main() {
  const { values } = parseArgs({ options: {
    epub: { type: "string" }, list: { type: "boolean" }, chapters: { type: "string" }, sections: { type: "string" },
    models: { type: "string" }, plan: { type: "boolean" }, live: { type: "boolean" },
    "budget-usd": { type: "string" }, "max-output": { type: "string" }, "context-chars": { type: "string" },
    resume: { type: "string" }, help: { type: "boolean" },
  }, strict: true, allowPositionals: false });
  if (values.help) { console.log(HELP); return; }
  const root = fileURLToPath(new URL("../.lorefold/benchmarks/", import.meta.url));
  let run: Manifest, directory: string;
  let config;
  if (values.resume) {
    if (!/^[a-f0-9-]{36}$/.test(values.resume) || Object.keys(values).some(k => !["resume", "live"].includes(k)))
      throw new Error("Resume accepts a run UUID and optionally --live; its saved settings are immutable.");
    directory = join(root, values.resume);
    run = await readManifest(directory);
    if ((run.mode === "live") !== Boolean(values.live)) throw new Error("Resume mode must match the saved run; live runs require --live again.");
    if (values.live) {
      config = credentials(process.env);
      if (run.gateway?.accountId !== config.accountId || run.gateway?.gatewayId !== config.gatewayId)
        throw new Error("Resume must use the same Cloudflare account and gateway.");
    }
  } else {
    if (values.chapters && values.sections) throw new Error("Choose either --chapters or --sections.");
    if (values.list && (values.live || values.plan)) throw new Error("Use --list by itself; it never calls a model.");
    const sections = values.epub ? readEpub(values.epub) : syntheticChapters();
    if (values.list) {
      console.table(sections.map(s => ({ section: s.index, title: s.title,
        words: s.paragraphs.reduce((n, p) => n + p.text.split(/\s+/u).length, 0),
        selectable: !s.fragmented })));
      return;
    }
    const chapters = selectChapters(sections, numbers(values.sections ?? values.chapters ?? "1,2,3"), Boolean(values.sections));
    const budgetUSD = Number(values["budget-usd"] ?? "2");
    if (!Number.isFinite(budgetUSD) || budgetUSD <= 0 || budgetUSD > 20) throw new Error("Budget must be greater than zero and at most $20.");
    const mode = values.live ? "live" : "mock";
    if (values.live && !values.plan) config = credentials(process.env);
    run = manifest({ mode, chapters, models: selectModels(values.models ?? MODELS.map(m => m.key).join(",")),
      maxOutput: integer(values["max-output"] ?? "8192", "max-output", 128, 32768),
      contextChars: integer(values["context-chars"] ?? "16000", "context-chars", 0, 100000), budgetUSD,
      gateway: config ? { accountId: config.accountId, gatewayId: config.gatewayId } : null });
    const requests = plan(run);
    const reserved = requests.reduce((n, r) => n + r.reservation.costUSD, 0);
    console.log(`${requests.length} requests; conservative live reservation $${reserved.toFixed(4)}; budget $${budgetUSD.toFixed(2)}.`);
    console.log("Reservation uses UTF-8 bytes + overhead as an input-token proxy and maximum output; actual usage may differ.");
    if (values.plan) {
      console.table(requests.map(r => ({ model: r.call.model.key, chapter: r.call.chapter,
        inputTokenProxy: r.reservation.inputTokens, maxOutput: run.maxOutput, reservedUSD: r.reservation.costUSD.toFixed(4) })));
      return;
    }
    if (mode === "live" && reserved > budgetUSD) throw new Error("Planned reservations exceed budget. Reduce models/chapters/output or explicitly choose a larger budget after inspecting --plan.");
    directory = await createRun(root, run);
  }
  console.log(`Run: ${run.id} (${run.mode}); reports: ${directory}`);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const result = await runBenchmark(directory, run, config ? liveProvider(config, fetch, controller.signal) : undefined,
      { signal: controller.signal, progress: text => console.log(text) });
    console.log(`Report: ${join(directory, "report.md")}`);
    if (!result.complete || controller.signal.aborted) process.exitCode = 2;
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Benchmark failed.");
  process.exitCode = 1;
});
