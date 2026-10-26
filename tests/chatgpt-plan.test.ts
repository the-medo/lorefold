import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { authorization, callback, ISSUER, PlanAuth, PLAN_SCOPE, profileFingerprint, verifyIdentity } from "../scripts/chatgpt-plan/auth.js";
import { listPlanModels, PLAN_MODELS, planModels, planProvider, planRequest, PlanRequestError, readPlanStream } from "../scripts/chatgpt-plan/provider.js";
import { mockAnalysis, prompt, syntheticChapters } from "../scripts/book-benchmark/analysis.js";
import { createRun, manifest, readManifest, runBenchmark } from "../scripts/book-benchmark/runner.js";

const chapters = syntheticChapters();
const call = { model: PLAN_MODELS[0], prompt: prompt(chapters.slice(0, 1)), maxOutput: 0, runId: "fixture", chapter: 1 };
const identity = { clientId: "oaiapp_fixture", subject: "user-1", email: "fixture@example.invalid" };
const fixture = () => ({ version: 1, hostId: "urn:uuid:11111111-1111-4111-8111-111111111111", profiles: { personal: { ...identity,
  tokens: { access: "private-access", refresh: "private-refresh", id: "private-id", expiresAt: Date.now() + 3600000, scopes: [PLAN_SCOPE, "resource.invoke"] } } } });
const output = { status: "completed", model: "gpt-6.1-sol", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(mockAnalysis(chapters.slice(0, 1))) }] }], usage: { input_tokens: 100, output_tokens: 50, output_tokens_details: { reasoning_tokens: 10 } } };
const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
function stream(text: string, step = 11) {
  const bytes = new TextEncoder().encode(text); let offset = 0;
  return new Response(new ReadableStream({ pull(controller) { if (offset === bytes.length) controller.close(); else { controller.enqueue(bytes.slice(offset, offset + step)); offset = Math.min(bytes.length, offset + step); } } }), { headers: { "content-type": "text/event-stream" } });
}
const discovery = { issuer: ISSUER, authorization_endpoint: `${ISSUER}/api/accounts/authorize`, token_endpoint: `${ISSUER}/api/accounts/oauth/token`, jwks_uri: `${ISSUER}/.well-known/jwks.json`, revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke` };

test("OAuth registration uses fresh PKCE, strict callback state, and a stable returning client", () => {
  const first = authorization(fixture().hostId, undefined, 15190), second = authorization(fixture().hostId, undefined, 15190);
  const url = new URL(first.url);
  assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(url.searchParams.get("agent_name_hint"), "Lorefold");
  assert.notEqual(first.state, second.state); assert.notEqual(first.verifier, second.verifier);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const valid = new URL(first.redirectUri); valid.search = new URLSearchParams({ code: "one-time-code", state: first.state, client_id: identity.clientId }).toString();
  assert.deepEqual(callback(first, valid), { code: "one-time-code", clientId: identity.clientId });
  valid.searchParams.set("state", "attacker"); assert.throws(() => callback(first, valid), /state/);
  valid.searchParams.set("state", first.state); valid.searchParams.delete("client_id"); assert.throws(() => callback(first, valid), /registration/);
  const returning = authorization(fixture().hostId, fixture().profiles.personal, 15189);
  assert.equal(new URL(returning.url).searchParams.get("client_id"), identity.clientId);
  assert.equal(new URL(returning.url).searchParams.has("agent_name_hint"), false);
  assert.equal(returning.url.includes("private-id"), false);
  const ret = new URL(returning.redirectUri); ret.search = new URLSearchParams({ code: "one-time-code", state: returning.state, client_id: "oaiapp_other" }).toString();
  assert.throws(() => callback(returning, ret), /registration/);
  ret.searchParams.delete("client_id"); assert.equal(callback(returning, ret).clientId, identity.clientId);
  ret.searchParams.set("error", "access_denied"); assert.throws(() => callback(returning, ret), /declined/);
  assert.throws(() => authorization(fixture().hostId, undefined, 16000), /port/);
});

test("ID token validation rejects wrong issuer, audience, nonce, identity, expiry and signature", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const keys = createLocalJWKSet({ keys: [await exportJWK(publicKey)] });
  const sign = (overrides = {}) => new SignJWT({ sub: "user-1", nonce: "expected", iss: ISSUER, aud: identity.clientId,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, ...overrides }).setProtectedHeader({ alg: "RS256" }).sign(privateKey);
  assert.equal((await verifyIdentity(await sign(), identity.clientId, "expected", null, keys)).subject, "user-1");
  for (const change of [{ iss: "https://evil.invalid" }, { aud: "other-app" }, { nonce: "other" }, { sub: "other-user" }, { exp: 1 }])
    await assert.rejects(verifyIdentity(await sign(change), identity.clientId, "expected", "user-1", keys), /did not validate/);
  const other = await generateKeyPair("RS256");
  await assert.rejects(verifyIdentity(await sign(), identity.clientId, "expected", null, createLocalJWKSet({ keys: [await exportJWK(other.publicKey)] })), /did not validate/);
});

test("login validates the browser callback and stores a verified identity with owner-only credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lorefold-siwc-login-"));
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  let authUrl: URL, exchanges = 0;
  const auth = new PlanAuth(directory, async (url, init) => {
    if (String(url).endsWith("openid-configuration")) return Response.json(discovery);
    if (String(url).endsWith("jwks.json")) return Response.json({ keys: [await exportJWK(publicKey)] });
    assert.equal(String(url), discovery.token_endpoint); exchanges++;
    const form = init!.body as URLSearchParams;
    assert.equal(form.get("client_id"), identity.clientId); assert.equal(form.get("redirect_uri"), authUrl!.searchParams.get("redirect_uri"));
    assert.equal(form.get("grant_type"), "authorization_code"); assert.ok(form.get("code_verifier"));
    const id = await new SignJWT({ sub: identity.subject, email: identity.email, nonce: authUrl!.searchParams.get("nonce") })
      .setProtectedHeader({ alg: "RS256" }).setIssuer(ISSUER).setAudience(identity.clientId).setIssuedAt().setExpirationTime("1h").sign(privateKey);
    return Response.json({ access_token: "secret-access", refresh_token: "secret-refresh", id_token: id, token_type: "Bearer", expires_in: 3600, scope: `${PLAN_SCOPE} resource.invoke` });
  });
  const controller = new AbortController();
  let browser: Promise<void> | undefined;
  try {
    const result = await auth.login("personal", 15190, url => {
      authUrl = new URL(url);
      browser = (async () => {
        const callbackUrl = new URL(authUrl.searchParams.get("redirect_uri")!);
        callbackUrl.search = new URLSearchParams({ code: "fixture-code", state: "bad-state", client_id: identity.clientId }).toString();
        assert.equal((await fetch(callbackUrl)).status, 400);
        callbackUrl.searchParams.set("state", authUrl.searchParams.get("state")!);
        assert.equal((await fetch(callbackUrl)).status, 200);
      })().catch(e => { controller.abort(); throw e; });
    }, controller.signal);
    await browser;
    assert.equal(exchanges, 1); assert.equal(result.planEnabled, true);
    assert.equal((await stat(join(directory, "accounts.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal(JSON.stringify(await auth.status()).includes("secret"), false);
    assert.equal((await auth.access("personal")).token, "secret-access");
  } finally { controller.abort(); await rm(directory, { recursive: true, force: true }); }
});

test("a valid OAuth response cannot link an expired Lorefold session, and its renewable token is revoked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lorefold-siwc-binding-"));
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  let authUrl: URL, revocations = 0;
  const auth = new PlanAuth(directory, async (url, init) => {
    if (String(url).endsWith("openid-configuration")) return Response.json(discovery);
    if (String(url).endsWith("jwks.json")) return Response.json({ keys: [await exportJWK(publicKey)] });
    if (String(url) === discovery.revocation_endpoint) {
      assert.equal((init!.body as URLSearchParams).get("token"), "new-refresh");
      revocations++; return new Response("");
    }
    const id = await new SignJWT({ sub: identity.subject, nonce: authUrl!.searchParams.get("nonce") })
      .setProtectedHeader({ alg: "RS256" }).setIssuer(ISSUER).setAudience(identity.clientId).setIssuedAt().setExpirationTime("1h").sign(privateKey);
    return Response.json({ access_token: "new-access", refresh_token: "new-refresh", id_token: id, token_type: "Bearer", expires_in: 3600, scope: `${PLAN_SCOPE} resource.invoke` });
  });
  let browser: Promise<Response> | undefined;
  try {
    await assert.rejects(auth.login("account", 15190, url => {
      authUrl = new URL(url);
      const callbackUrl = new URL(authUrl.searchParams.get("redirect_uri")!);
      callbackUrl.search = new URLSearchParams({ code: "fixture", state: authUrl.searchParams.get("state")!, client_id: identity.clientId }).toString();
      browser = fetch(callbackUrl);
    }, undefined, async () => false), /session expired/);
    await (await browser)?.body?.cancel();
    assert.equal(revocations, 1);
    assert.equal((await auth.read())!.profiles.account.tokens, null);
    assert.equal((await auth.status())[0].connected, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("refresh rotates credentials atomically, preserves identity, and respects scope removal and locks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lorefold-siwc-refresh-"));
  try {
    const state = fixture(); state.profiles.personal.tokens.expiresAt = 1;
    await writeFile(join(directory, "accounts.json"), JSON.stringify(state), { mode: 0o600 });
    let refreshes = 0;
    const auth = new PlanAuth(directory, async (url, init) => {
      if (String(url).endsWith("openid-configuration")) return Response.json(discovery);
      refreshes++;
      const form = init!.body as URLSearchParams;
      assert.equal(form.get("refresh_token"), "private-refresh"); assert.equal(form.get("client_id"), identity.clientId); assert.equal(form.has("scope"), false);
      return Response.json({ access_token: "replacement", refresh_token: "rotated", expires_in: 3600, token_type: "Bearer" });
    });
    const access = await auth.access("personal", profileFingerprint(state.profiles.personal));
    assert.equal(access.token, "replacement"); await auth.access("personal"); assert.equal(refreshes, 1);
    assert.equal((await auth.read())!.profiles.personal.tokens!.refresh, "rotated");
    await assert.rejects(auth.access("personal", "wrong-account"), /does not match/);
    await writeFile(join(directory, "session.lock"), "fixture", { mode: 0o600 });
    await assert.rejects(auth.access("personal"), /busy/); await rm(join(directory, "session.lock"));
    state.profiles.personal.tokens.scopes = ["openid"];
    await writeFile(join(directory, "accounts.json"), JSON.stringify(state));
    await assert.rejects(auth.access("personal"), /not authorized/); assert.equal(refreshes, 1);
    await chmod(join(directory, "accounts.json"), 0o644); await assert.rejects(auth.read(), /owner-only/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("logout clears local tokens even if revocation fails, retaining the client registration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lorefold-siwc-logout-"));
  try {
    await writeFile(join(directory, "accounts.json"), JSON.stringify(fixture()), { mode: 0o600 });
    const auth = new PlanAuth(directory, async () => { throw new Error("private-token must not leak"); });
    assert.equal((await auth.logout("personal")).revoked, false);
    const p = (await auth.read())!.profiles.personal;
    assert.equal(p.tokens, null); assert.equal(p.clientId, identity.clientId);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("terminal refresh errors clear unusable tokens; temporary failures retain them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lorefold-siwc-expired-"));
  try {
    const state = fixture(); state.profiles.personal.tokens.expiresAt = 1;
    await writeFile(join(directory, "accounts.json"), JSON.stringify(state), { mode: 0o600 });
    let terminal = false;
    const auth = new PlanAuth(directory, async url => String(url).endsWith("openid-configuration") ? Response.json(discovery) :
      Response.json({ error: terminal ? "invalid_grant" : "temporarily_unavailable", error_description: "private-credential" }, { status: terminal ? 400 : 503 }));
    await assert.rejects(auth.access("personal"), /HTTP 503/);
    assert.ok((await auth.read())!.profiles.personal.tokens);
    terminal = true;
    await assert.rejects(auth.access("personal"), error => error instanceof Error && /Session expired/.test(error.message) && !error.message.includes("private-credential"));
    assert.equal((await auth.read())!.profiles.personal.tokens, null);
    assert.equal((await auth.read())!.profiles.personal.clientId, identity.clientId);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("subscription requests obey preview fields and streams require terminal completion", async () => {
  const body = planRequest(call);
  assert.equal(body.model, "gpt-6.1-sol"); assert.equal(body.store, false); assert.equal(body.stream, true);
  assert.equal(body.input[0].role, "user");
  for (const field of ["max_output_tokens", "metadata", "background", "previous_response_id", "temperature"]) assert.equal(field in body, false);
  const result = await readPlanStream(stream(": heartbeat\r\n\r\n" + event({ type: "response.output_text.delta", delta: "héllo" }) + event({ type: "response.completed", response: output }), 1));
  assert.equal(result.usage!.outputTokens, 50); assert.equal(result.usage!.reasoningTokens, 10); assert.equal(result.truncated, false);
  await assert.rejects(readPlanStream(stream(event({ type: "response.output_text.delta", delta: "partial" }) + "data: [DONE]\n\n")), /before response.completed/);
  await assert.rejects(readPlanStream(stream(event({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "private-prompt" } } }))), e => e instanceof PlanRequestError && /usage limit/.test(e.message) && !e.message.includes("private-prompt"));
  await assert.rejects(readPlanStream(stream(event({ type: "response.incomplete" }))), /incomplete/);
  await assert.rejects(readPlanStream(new Response("secret", { status: 401 })), /HTTP 401/);
});

test("plan streams tolerate a missing Content-Type only when a completed SSE event is present", async () => {
  const headerless = (text: string) => new Response(new TextEncoder().encode(text));
  const result = await readPlanStream(headerless(event({ type: "response.completed", response: output })));
  assert.equal(result.usage!.inputTokens, 100);
  await assert.rejects(readPlanStream(headerless(JSON.stringify(output))), /before response.completed/);
  await assert.rejects(readPlanStream(headerless(event({ type: "response.output_text.delta", delta: "partial" }))), /before response.completed/);
  await assert.rejects(readPlanStream(headerless(event({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } }))), /usage limit/);
  await assert.rejects(readPlanStream(Response.json(output)), /non-stream/);
});

test("plan streams retain completed output items when the terminal snapshot omits output", async () => {
  const item = (output_index: number, text: string) => event({ type: "response.output_item.done", output_index,
    item: { type: "message", status: "completed", content: [{ type: "output_text", text }] } });
  const items = item(1, " world") + item(0, "héllo");
  const complete = event({ type: "response.completed", response: { ...output, output: [] } });
  const result = await readPlanStream(stream(items + complete, 1));
  assert.equal(result.text, "héllo world"); assert.equal(result.usage!.outputTokens, 50);
  const snapshot = await readPlanStream(stream(items + event({ type: "response.completed", response: output })));
  assert.equal(snapshot.text, output.output[0].content[0].text);
  await assert.rejects(readPlanStream(stream(items)), /before response.completed/);
  await assert.rejects(readPlanStream(stream(items + event({ type: "response.incomplete" }))), /incomplete/);
  await assert.rejects(readPlanStream(stream(items + event({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_unavailable" } } }))), /usage limit/);
  await assert.rejects(readPlanStream(stream(event({ type: "response.output_text.delta", delta: "unfinished" }) + complete)), /without output text/);
});

test("plan provider preserves extra-high effort and timeout, uses the public route, and never retries", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lorefold-siwc-provider-"));
  try {
    const state = fixture(); await writeFile(join(directory, "accounts.json"), JSON.stringify(state), { mode: 0o600 });
    let requests = 0;
    const timeouts: number[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, "timeout", (ms: number) => { timeouts.push(ms); return timeout(ms); });
    const auth = new PlanAuth(directory, async (url, init) => {
      assert.equal(new Headers(init!.headers).get("authorization"), "Bearer private-access"); assert.equal(init!.redirect, "error");
      if (String(url).endsWith("/models")) return Response.json({ models: [{ visibility: "list", slug: "gpt-6.1-sol", display_name: "Sol" }, { visibility: "hide", slug: "other", display_name: "hidden" }] });
      requests++; assert.equal(url, "https://api.openai.com/v1/responses");
      assert.equal(JSON.parse(String(init!.body)).reasoning.effort, "xhigh");
      return stream(event({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_unavailable" } } }));
    });
    assert.deepEqual(await listPlanModels(auth, "personal"), [{ slug: "gpt-6.1-sol", name: "Sol" }]);
    assert.throws(() => planProvider(auth, "personal", "unused", undefined, 901), /timeout/);
    await assert.rejects(planProvider(auth, "personal", profileFingerprint(state.profiles.personal), undefined, 600)({ ...call, model: planModels("sol", "xhigh")[0] }), /usage limit/);
    assert.ok(timeouts.includes(600000));
    assert.equal(requests, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("plan runner persists allowance billing, stops on failure, and counts saved attempts across resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "lorefold-siwc-run-"));
  try {
    const run = manifest({ mode: "live", provider: "chatgpt-plan", models: planModels("sol,astra"), chapters: chapters.slice(0, 1), maxOutput: 0,
      contextChars: 0, budgetUSD: 0, gateway: null, chatgptPlan: { profile: "personal", fingerprint: "a".repeat(64), maxCalls: 1 } });
    const directory = await createRun(root, run);
    let sent = 0;
    const result = await runBenchmark(directory, run, async () => { sent++; throw new PlanRequestError("Provider ChatGPT plan usage limit reached."); }, { intervalMs: 0 });
    assert.equal(sent, 1); assert.equal(result.report.recordedCalls, 1); assert.equal(result.report.estimatedCostUSD, null);
    assert.equal(result.report.budgetUSD, null); assert.equal(result.report.billing, "shared-chatgpt-plan");
    await runBenchmark(directory, await readManifest(directory), async () => { sent++; throw new Error(); }, { intervalMs: 0 });
    assert.equal(sent, 1);
    const markdown = await readFile(join(directory, "report.md"), "utf8");
    assert.match(markdown, /plan allowance/); assert.equal(markdown.includes("$0.0000"), false);
    const next = manifest({ ...run, models: planModels("sol", "xhigh"), chatgptPlan: { ...run.chatgptPlan!, maxCalls: 1, timeoutSeconds: 600 } });
    const successDir = await createRun(root, next);
    assert.deepEqual(await readManifest(successDir), next);
    const complete = await runBenchmark(successDir, next, async () => readPlanStream(stream(event({ type: "response.completed", response: output }))), { intervalMs: 0 });
    assert.equal(complete.complete, true); assert.equal(complete.report.estimatedCostUSD, null);
    assert.equal(complete.report.entries[0].result!.usage!.inputTokens, 100);
    assert.equal(complete.report.timeoutSeconds, 600);
    await writeFile(join(successDir, "run.json"), JSON.stringify({ ...next, chatgptPlan: { ...next.chatgptPlan, timeoutSeconds: 901 } }));
    await assert.rejects(readManifest(successDir), /incompatible/);
    await writeFile(join(successDir, "run.json"), JSON.stringify({ ...next, models: [{ ...next.models[0], reasoning: "extra-high" }] }));
    await assert.rejects(readManifest(successDir), /incompatible/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("plan CLI stays offline for planning, rejects misleading caps and requires live opt-in", () => {
  const env = { ...process.env }; delete env.LOREFOLD_BENCHMARK_LIVE;
  const invoke = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/book-benchmark.ts", "--provider", "chatgpt-plan", ...args], { encoding: "utf8", env });
  const plan = invoke("--plan", "--live"); assert.equal(plan.status, 0); assert.match(plan.stdout, /6 requests/); assert.equal(plan.stdout.includes("$0.0000"), false);
  assert.match(invoke("--budget-usd", "2").stderr, /neither a USD budget/);
  assert.match(invoke("--max-output", "8192").stderr, /neither a USD budget/);
  assert.match(invoke("--max-calls", "1").stderr, /exceeds --max-calls/);
  assert.match(invoke("--live").stderr, /LOREFOLD_BENCHMARK_LIVE/);
  const extraHigh = invoke("--plan", "--reasoning", "xhigh", "--timeout-seconds", "600");
  assert.equal(extraHigh.status, 0); assert.match(extraHigh.stdout, /xhigh/); assert.match(extraHigh.stdout, /600 seconds/);
  assert.match(invoke("--plan", "--reasoning", "extra-high").stderr, /reasoning must be/);
  for (const value of ["29", "901", "1.5", "NaN", ""]) assert.match(invoke("--plan", "--timeout-seconds", value).stderr, /timeout-seconds must be/);
});
