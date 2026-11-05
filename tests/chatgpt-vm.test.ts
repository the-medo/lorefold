import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "../backend/db/client.js";
import { user } from "../backend/db/schema.js";
import { provisionUser } from "../backend/provision-user.js";
import { DatabasePlanAuthStore } from "../backend/chatgpt/database-store.js";
import { ISSUER, PLAN_SCOPE, type Profile } from "../backend/chatgpt/auth.js";
import { VMChatGPTConnections } from "../backend/chatgpt/vm-connections.js";
import { importProvider } from "../backend/imports/provider.js";

if (!process.env.LOREFOLD_WORKTREE_ID) throw new Error("Use the worktree launcher.");
const email = `vm-owner-${randomUUID()}@example.test`, otherEmail = `vm-other-${randomUUID()}@example.test`, password = randomUUID();
const key = randomBytes(32).toString("hex"), origin = process.env.APP_ORIGIN!;
Object.assign(process.env, { NODE_ENV: "production", LOREFOLD_CHATGPT_PERSONAL: "1", LOREFOLD_OWNER_EMAIL: email,
  LOREFOLD_CHATGPT_STORAGE: "database", LOREFOLD_CHATGPT_ENCRYPTION_KEY: key, GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" });
const { app } = await import("../backend/app.js");
const { chatgptConnections } = await import("../backend/ai.js");
const users: string[] = [];
let ownerCookie: string, otherCookie: string;
const cookie = (r: Response) => r.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
const browser = (path: string, method = "GET", value?: unknown, session = ownerCookie) => app.request(`${origin}/api${path}`, {
  method, headers: { origin, cookie: session, "content-type": "application/json" }, ...(value === undefined ? {} : { body: JSON.stringify(value) }),
});
const helper = (code: string, value?: unknown, headers = {}) => app.request(`${origin}/api/connections/chatgpt/provision`, {
  method: value === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${code}`, "content-type": "application/json", ...headers },
  ...(value === undefined ? {} : { body: JSON.stringify(value) }),
});
before(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
  users.push(await provisionUser(email, password, "VM owner"), await provisionUser(otherEmail, password, "Other reader"));
  delete process.env.LOREFOLD_OWNER_EMAIL; // Create a pre-existing other-user session.
  try {
    ownerCookie = cookie(await browser("/auth/sign-in/email", "POST", { email, password }, ""));
    otherCookie = cookie(await browser("/auth/sign-in/email", "POST", { email: otherEmail, password }, ""));
    assert.ok(ownerCookie); assert.ok(otherCookie);
  } finally { process.env.LOREFOLD_OWNER_EMAIL = email; }
});
after(async () => {
  await chatgptConnections.close();
  try { if (users.length) await db.delete(user).where(inArray(user.id, users)); }
  finally { await pool.end(); }
});
test("owner restriction blocks old sessions, new password sessions, and other-user worker access", async () => {
  assert.equal((await browser("/books")).status, 200);
  for (const path of ["/books", "/settings/ai", "/connections/chatgpt/attempt"])
    assert.equal((await browser(path, "GET", undefined, otherCookie)).status, 403);
  assert.equal((await browser("/connections/chatgpt", "POST", undefined, otherCookie)).status, 403);
  assert.equal((await browser("/auth/sign-in/email", "POST", { email: otherEmail, password }, "")).status, 403);
  process.env.LOREFOLD_IMPORT_LIVE = "1";
  try { await assert.rejects(importProvider(users[1], "chatgpt-plan", { model: "gpt-6-astra", effort: "high" }), /installation owner/); }
  finally { delete process.env.LOREFOLD_IMPORT_LIVE; }
});
test("production browser setup transfers a signed identity into encrypted storage and rejects replay", async t => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const discovery = { issuer: ISSUER, authorization_endpoint: `${ISSUER}/api/accounts/authorize`, token_endpoint: `${ISSUER}/api/accounts/oauth/token`, jwks_uri: `${ISSUER}/.well-known/jwks.json`, revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke` };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("openid-configuration")) return Response.json(discovery);
    if (url.endsWith("jwks.json")) return Response.json({ keys: [await exportJWK(publicKey)] });
    if (url === discovery.revocation_endpoint) return new Response("");
    throw new Error("Unexpected network request");
  });
  assert.equal((await browser("/connections/chatgpt", "POST", undefined, "")).status, 401);
  const response = await browser("/connections/chatgpt", "POST");
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const { setupCode } = await response.json();
  const store = new DatabasePlanAuthStore(pool, users[0], key), vmHost = (await store.read())!.hostId;
  assert.equal((await helper("wrong")).status, 401);
  assert.equal((await helper(setupCode, undefined, { origin })).status, 403);
  assert.equal((await helper(setupCode, undefined, { cookie: ownerCookie })).status, 403);
  assert.deepEqual(await (await helper(setupCode)).json(), { registration: null });
  const id = await new SignJWT({ sub: "signed-owner", email: "chatgpt@example.test" }).setProtectedHeader({ alg: "RS256" })
    .setIssuer(ISSUER).setAudience("oaiapp_personal_fixture").setIssuedAt().setExpirationTime("1h").sign(privateKey);
  const profile: Profile = { clientId: "oaiapp_personal_fixture", subject: "signed-owner", email: "untrusted@example.test",
    tokens: { access: "fixture-private-access", refresh: "fixture-private-refresh", id, scopes: [PLAN_SCOPE, "resource.invoke"], expiresAt: Date.now() + 3600000 } };
  assert.equal((await helper(setupCode, profile)).status, 200);
  assert.equal((await helper(setupCode, profile)).status, 401);
  const stored = (await store.read())!;
  assert.equal(stored.hostId, vmHost);
  assert.equal(stored.profiles.account.email, "chatgpt@example.test");
  const settings = await (await browser("/settings/ai")).json();
  assert.equal(settings.chatgpt.connected, true); assert.equal(settings.chatgpt.enabled, true);
  assert.ok(!JSON.stringify(settings).includes("fixture-private"));
  assert.equal((await (await browser("/connections/chatgpt/attempt")).json()).state, "complete");
  await browser("/connections/chatgpt", "DELETE");
  assert.equal((await store.read())!.profiles.account.tokens, null);
  const next = await (await browser("/connections/chatgpt", "POST")).json();
  const registration = await (await helper(next.setupCode)).json();
  assert.equal(registration.registration.clientId, profile.clientId);
  assert.equal(registration.registration.tokens, null);
  assert.equal((await helper(next.setupCode, { ...profile, tokens: { ...profile.tokens, id: "invalid-signature" } })).status, 400);
  assert.equal((await store.read())!.profiles.account.tokens, null);
  assert.equal((await helper(next.setupCode, profile)).status, 401);
  await browser("/connections/chatgpt/attempt", "DELETE");
  // A cancelled browser attempt cannot later deliver credentials.
  const cancelled = await (await browser("/connections/chatgpt", "POST")).json();
  await browser("/connections/chatgpt/attempt", "DELETE");
  assert.equal((await helper(cancelled.setupCode, profile)).status, 401);
});

function fixture() {
  let time = 1000, active = true, connected = false, imports = 0, logouts = 0;
  let beforeSave: () => Promise<void> = async () => {};
  const client = {
    prepareTransfer: async () => null,
    status: async () => connected ? [{ profile: "account", email: null, connected: true, planEnabled: true, expiresAt: null }] : [],
    logout: async () => { connected = false; logouts++; return { revoked: true }; },
    importTransfer: async (_: unknown, canSave: () => Promise<boolean>) => { imports++; await beforeSave(); if (!await canSave()) throw new Error("expired"); connected = true; },
  };
  const service = new VMChatGPTConnections("https://personal.example.test", async (id, session) => active && id === "owner" && session === "session", () => client, () => time);
  return { service, expire: () => { time += 21 * 60000; }, invalidate: () => { active = false; }, block: (f: () => Promise<void>) => { beforeSave = f; },
    count: () => imports, connected: () => connected, logouts: () => logouts };
}
test("VM setup is bound to its owner/session, expires, and is cancelled on shutdown", async () => {
  for (const mode of ["expired", "signed-out", "cancelled", "shutdown"]) {
    const f = fixture();
    await assert.rejects(f.service.start("other", "session"), /invalid/);
    const { setupCode } = await f.service.start("owner", "session");
    assert.deepEqual(f.service.progress("other", "session"), { state: "none" });
    assert.throws(() => f.service.progress("owner", "other-session"), /browser session/);
    await assert.rejects(f.service.cancel("owner", "other-session"), /browser session/);
    if (mode === "expired") f.expire();
    if (mode === "signed-out") f.invalidate();
    if (mode === "cancelled") await f.service.cancel("owner", "session");
    if (mode === "shutdown") await f.service.close();
    await assert.rejects(f.service.receive(setupCode!, {}), /invalid/);
    assert.equal(f.count(), 0);
    await f.service.close();
  }
});
test("concurrent transfers consume a setup code only once and cancellation prevents a late save", async () => {
  const f = fixture();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  f.block(async () => { started(); await gate; });
  const { setupCode } = await f.service.start("owner", "session");
  const first = f.service.receive(setupCode!, {});
  const rejected = assert.rejects(first, /could not be verified/);
  await ready;
  await assert.rejects(f.service.receive(setupCode!, {}), /invalid/);
  const cancelled = f.service.cancel("owner", "session");
  release(); await rejected; await cancelled;
  assert.equal(f.count(), 1); assert.equal(f.connected(), false);
  await f.service.close();
});
