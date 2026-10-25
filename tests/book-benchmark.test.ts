import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mockAnalysis, parseAnalysis, prompt, syntheticChapters, validateAnalysis } from "../scripts/book-benchmark/analysis.js";
import { MODELS, selectModels } from "../scripts/book-benchmark/models.js";
import { credentials, costUSD, liveProvider, parseResponse, requestBody, reservation, type ProviderResult } from "../scripts/book-benchmark/provider.js";
import { createRun, manifest, plan, readManifest, runBenchmark } from "../scripts/book-benchmark/runner.js";
import { contextFor, numbers, selectChapters } from "../scripts/book-benchmark/source.js";

const chapters = syntheticChapters();
const call = (model = MODELS[0]) => ({ model, prompt: prompt(chapters.slice(0, 1)), maxOutput: 8192, runId: "test", chapter: 1 });
const config = { accountId: "a".repeat(32), gatewayId: "test-dev", token: "private-test-token" };
const response = (): ProviderResult => ({ text: JSON.stringify(mockAnalysis(chapters.slice(0, 1))), usage: { inputTokens: 100, outputTokens: 200, reasoningTokens: 80, cacheWriteTokens: 0 }, reportedModel: "test", truncated: false });

test("selection is explicit, ordered, unambiguous, and excludes extras", () => {
  const sections = [{ ...chapters[0], title: "Copyright", navigationTitle: "Copyright", index: 1 }, ...chapters.map(c => ({ ...c, index: c.index + 1 })), { ...chapters[0], title: "Bonus story", navigationTitle: null, index: 5 }];
  assert.deepEqual(selectChapters(sections, [1, 2, 3]).map(c => c.index), [2, 3, 4]);
  assert.throws(() => selectChapters([...sections, { ...chapters[0], index: 6 }], [1]), /ambiguous/);
  assert.throws(() => selectChapters(sections, [3, 1]), /reading order/);
  assert.throws(() => selectChapters([{ ...chapters[0], fragmented: true }], [1]), /fragment/);
  assert.equal(selectChapters(sections, [5], true)[0].title, "Bonus story");
  assert.equal(selectChapters([...sections, { ...chapters[0], navigationTitle: null, index: 6 }], [1]).length, 1);
  for (const invalid of ["1,1", "0", "-1", "1.5", "", "1,no", "1,2,", "1e3"]) assert.throws(() => numbers(invalid));
  assert.throws(() => selectModels("gpt,gpt")); assert.throws(() => selectModels("unknown"));
});

test("prompts never contain later text and context remains whole, bounded paragraphs", () => {
  const first = prompt(contextFor(chapters, 0, 16000));
  assert.equal(first.user.includes("missing brother"), false);
  assert.equal(first.user.includes("Leon"), false);
  const second = contextFor(chapters, 1, 50);
  assert.equal(second.length, 2);
  assert.equal(second[0].paragraphs.length, 1);
  assert.equal(second[0].paragraphs[0].id, "s1p2");
  assert.deepEqual(contextFor(chapters, 2, 0), [chapters[2]]);
  assert.match(first.system, /untrusted data/);
});

test("validator rejects fake evidence, future reveals, ungrounded aliases and dangling edges", () => {
  const context = chapters.slice(0, 1);
  const valid = mockAnalysis(context);
  assert.equal(validateAnalysis(valid, context).valid, true);
  for (const mutate of [
    (a: typeof valid) => { a.recap[0].evidence[0].quote = "Words that are not in the book"; },
    (a: typeof valid) => { a.recap[0].evidence[0].chapter = 3; },
    (a: typeof valid) => { a.recap[0].revealChapter = 3; },
    (a: typeof valid) => { a.recap[0].evidence = []; },
    (a: typeof valid) => { a.relationships = [{ source: "missing", target: "also-missing", ...a.recap[0] }]; },
    (a: typeof valid) => { a.entities = [{ id: "e1", kind: "character", label: "Rowan", revealChapter: 1, evidence: a.recap[0].evidence,
      facts: [], aliases: [{ text: "Leon", revealChapter: 1, evidence: [{ chapter: 3, paragraphId: "s3p1", quote: chapters[2].paragraphs[0].text }] }] }]; },
  ]) {
    const changed = structuredClone(valid); mutate(changed);
    assert.equal(validateAnalysis(changed, context).valid, false);
  }
  assert.equal(validateAnalysis({ ...valid, extra: "ignored instructions" }, context).valid, false);
  assert.equal(parseAnalysis("```json\n{}\n```", context).validation.valid, false);
  // Mechanical matching cannot determine entailment: explicitly preserve manual review.
  const unsupported = structuredClone(valid); unsupported.recap[0].text = "Rowan is secretly Leon.";
  assert.equal(validateAnalysis(unsupported, context).semanticReview, "required");
});

test("provider shapes and usage account for reasoning once and reject truncation", () => {
  assert.equal(requestBody(call()).max_output_tokens, 8192);
  assert.deepEqual(requestBody(call()).reasoning, { effort: "low" });
  assert.equal(requestBody(call(MODELS[1])).max_tokens, 8192);
  assert.equal(requestBody(call(MODELS[2])).reasoning_effort, "low");
  const gpt = parseResponse("responses", { status: "completed", output: [{ type: "reasoning", summary: [] }, { type: "message", content: [{ type: "output_text", text: "{}" }] }], usage: { input_tokens: 100, output_tokens: 200, output_tokens_details: { reasoning_tokens: 150 } } });
  assert.equal(gpt.text, "{}"); assert.equal(gpt.usage!.outputTokens, 200);
  assert.equal(gpt.usage!.reasoningTokens, 150); assert.equal(costUSD(MODELS[0], gpt.usage!), .0022);
  const claude = parseResponse("messages", { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "{}" }], usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 40 } });
  assert.equal(claude.usage!.inputTokens, 60); assert.equal(claude.text, "{}");
  assert.equal(costUSD(MODELS[1], claude.usage!), .000535);
  const chat = parseResponse("chat/completions", { success: true, result: { choices: [{ message: { content: "{}", reasoning_content: "thinking" }, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 20 } } });
  assert.equal(chat.truncated, true); assert.equal(chat.usage!.outputTokens, 20);
  assert.equal(parseResponse("responses", { status: "incomplete", usage: { input_tokens: 5, output_tokens: 8192 } }).truncated, true);
  assert.equal(parseResponse("messages", { content: [] }).usage, null);
  assert.throws(() => parseResponse("responses", { success: false, errors: [] }));
  assert.throws(() => reservation({ ...call(), prompt: { system: "x", user: "x".repeat(300000) } }), /context/);
});

test("live mode needs opt-in and private credentials; transport uses the chosen gateway without retries", async () => {
  assert.throws(() => credentials({}), /LOREFOLD_BENCHMARK_LIVE/);
  assert.throws(() => credentials({ LOREFOLD_BENCHMARK_LIVE: "1" }), /CLOUDFLARE/);
  assert.throws(() => credentials({ LOREFOLD_BENCHMARK_LIVE: "1", NODE_ENV: "production" }));
  let calls = 0;
  const provider = liveProvider(config, async (url, init) => {
    calls++;
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/v1/responses`);
    const h = new Headers(init?.headers);
    assert.equal(h.get("cf-aig-gateway-id"), config.gatewayId);
    assert.equal(h.get("cf-aig-collect-log"), "false");
    assert.equal(h.get("cf-aig-skip-cache"), "true");
    assert.equal(h.get("cf-aig-max-attempts"), "1");
    assert.equal(init?.redirect, "error");
    return new Response("secret echo: private-test-token", { status: 401 });
  });
  await assert.rejects(provider(call()), error => error instanceof Error && error.message.includes("HTTP 401") && !error.message.includes(config.token));
  assert.equal(calls, 1);
  await assert.rejects(liveProvider(config, async () => new Response("not json"))(call()), /invalid/);
});

test("mock runs make no network requests, save private reports, and resume without replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "lorefold-benchmark-"));
  try {
    const run = manifest({ mode: "mock", models: MODELS, chapters, maxOutput: 8192, contextChars: 16000, budgetUSD: 2, gateway: null });
    const directory = await createRun(root, run);
    const result = await runBenchmark(directory, run, async () => { throw new Error("Must not call network"); });
    assert.equal(result.complete, true); assert.equal(result.report.entries.length, 18);
    assert.equal(result.report.estimatedCostUSD, 0);
    assert.equal((await stat(join(directory, "run.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.match(await readFile(join(directory, "report.md"), "utf8"), /plumbing test only/);
    const resumed = await runBenchmark(directory, await readManifest(directory));
    assert.deepEqual(resumed.report.entries, result.report.entries);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("budget stops calls before dispatch; unknown billing and in-flight checkpoints are retained", async () => {
  const root = await mkdtemp(join(tmpdir(), "lorefold-benchmark-"));
  try {
    const run = manifest({ mode: "live", models: MODELS.slice(0, 2), chapters: chapters.slice(0, 1), maxOutput: 8192, contextChars: 0, budgetUSD: .00001, gateway: { accountId: config.accountId, gatewayId: config.gatewayId } });
    let calls = 0;
    const provider = async () => { calls++; return response(); };
    const directory = await createRun(root, run);
    assert.equal((await runBenchmark(directory, run, provider, { intervalMs: 0 })).complete, false);
    assert.equal(calls, 0);
    const pending = { model: "gpt", chapter: 1, status: "in-flight", reservedUSD: .1, chargedEstimateUSD: null, startedAtMs: Date.now(), durationMs: null };
    await writeFile(join(directory, "gpt-chapter-1.json"), JSON.stringify(pending));
    run.budgetUSD = 2;
    const done = await runBenchmark(directory, run, provider, { intervalMs: 0 });
    assert.equal(calls, 1); assert.equal(done.report.unknownCostReservationsUSD, .1);
    assert.equal(done.report.entries[0].status, "in-flight"); assert.equal(done.complete, false);
    await runBenchmark(directory, run, provider, { intervalMs: 0 }); assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI plan stays offline and live mode fails before dispatch without opt-in", () => {
  const env = { ...process.env };
  delete env.LOREFOLD_BENCHMARK_LIVE;
  delete env.CLOUDFLARE_API_TOKEN;
  const invoke = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/book-benchmark.ts", ...args], { env, encoding: "utf8" });
  const planned = invoke(["--plan", "--live", "--models", "gpt", "--chapters", "1"]);
  assert.equal(planned.status, 0); assert.match(planned.stdout, /1 requests/);
  const live = invoke(["--live", "--models", "gpt"]);
  assert.equal(live.status, 1); assert.match(live.stderr, /LOREFOLD_BENCHMARK_LIVE/);
  assert.equal(invoke(["--api-token", "forbidden-secret-argument"]).status, 1);
});

test("failure, truncation and missing usage remain visible, checkpointed and charged conservatively", async () => {
  const root = await mkdtemp(join(tmpdir(), "lorefold-benchmark-"));
  try {
    const run = manifest({ mode: "live", models: MODELS.slice(0, 3), chapters: chapters.slice(0, 1), maxOutput: 8192, contextChars: 0, budgetUSD: 2, gateway: null });
    const directory = await createRun(root, run);
    let calls = 0;
    const result = await runBenchmark(directory, run, async () => {
      calls++;
      if (calls === 1) throw new Error("secret arbitrary exception");
      return { ...response(), truncated: calls === 2, usage: calls === 3 ? null : response().usage };
    }, { intervalMs: 0 });
    assert.equal(result.complete, false);
    assert.equal(result.report.entries[0].status, "failed");
    assert.equal(JSON.stringify(result.report).includes("secret arbitrary"), false);
    assert.equal(result.report.entries[1].analysis!.validation.valid, false);
    assert.equal(result.report.entries[2].chargedEstimateUSD, null);
    assert.ok(result.report.unknownCostReservationsUSD > 0);
    assert.equal(plan(run)[0].promptHash, plan(run)[1].promptHash);
    await runBenchmark(directory, run, async () => { throw new Error("Must not retry"); });
    await writeFile(join(directory, ".lock"), "123");
    await assert.rejects(runBenchmark(directory, run, async () => response()), /locked/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
