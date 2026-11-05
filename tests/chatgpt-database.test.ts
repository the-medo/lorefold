import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "../backend/db/client.js";
import * as s from "../backend/db/schema.js";
import { ISSUER, PLAN_SCOPE, PlanAuth } from "../backend/chatgpt/auth.js";
import { connectionStorage, DatabasePlanAuthStore } from "../backend/chatgpt/database-store.js";

if (!process.env.LOREFOLD_WORKTREE_ID) throw new Error("Use the worktree launcher.");
const key = randomBytes(32).toString("hex");
const workerPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const users: string[] = [];
const discovery = { issuer: ISSUER, authorization_endpoint: `${ISSUER}/api/accounts/authorize`, token_endpoint: `${ISSUER}/api/accounts/oauth/token`, jwks_uri: `${ISSUER}/.well-known/jwks.json`, revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke` };
const profile = () => ({ clientId: "oaiapp_database_fixture", subject: "database-subject", email: "database@example.invalid",
  tokens: { access: "private-database-access", refresh: "private-database-refresh", id: "private-database-id", expiresAt: Date.now() + 3600000, scopes: [PLAN_SCOPE, "resource.invoke"] } });
async function owner() {
  const id = randomUUID();
  await db.insert(s.user).values({ id, name: "Database connection fixture", email: `${id}@example.invalid` });
  users.push(id); return id;
}
const storeFor = (id: string, connectionPool = pool) => new DatabasePlanAuthStore(connectionPool, id, key);
async function seed(store: DatabasePlanAuthStore, expired = false) {
  return store.locked(async (state, save) => {
    state.profiles.account = profile();
    if (expired) state.profiles.account.tokens!.expiresAt = 1;
    await save(state); return state;
  });
}
async function encrypted(id: string) {
  const [row] = await db.select().from(s.chatgptCredentialStore).where(eq(s.chatgptCredentialStore.userId, id));
  return row.ciphertext;
}
before(async () => { await migrate(db, { migrationsFolder: "./migrations" }); });
after(async () => {
  try { if (users.length) await db.delete(s.user).where(inArray(s.user.id, users)); }
  finally { await workerPool.end(); await pool.end(); }
});

test("database storage requires an explicit mode and a separate valid encryption key", () => {
  assert.equal(connectionStorage({}), "file");
  assert.throws(() => connectionStorage({ LOREFOLD_CHATGPT_STORAGE: "invalid" }), /Choose/);
  for (const value of [undefined, "short", "g".repeat(64)])
    assert.throws(() => connectionStorage({ LOREFOLD_CHATGPT_STORAGE: "database", LOREFOLD_CHATGPT_ENCRYPTION_KEY: value }), /64 hexadecimal/);
  assert.equal(connectionStorage({ LOREFOLD_CHATGPT_STORAGE: "database", LOREFOLD_CHATGPT_ENCRYPTION_KEY: key }), "database");
});

test("encrypted credentials and host identity survive new web/worker instances without a shared directory", async () => {
  const id = await owner(), web = storeFor(id), state = await seed(web);
  const first = await encrypted(id);
  for (const secret of Object.values(profile().tokens!))
    if (typeof secret === "string") assert.ok(!first.includes(secret));
  assert.ok(!first.includes(profile().email));
  assert.ok(!first.includes(profile().clientId));
  const worker = storeFor(id, workerPool);
  assert.deepEqual(await worker.read(), state);
  const auth = new PlanAuth(undefined, fetch, worker);
  assert.equal((await auth.access("account")).token, profile().tokens!.access);
  assert.ok(!JSON.stringify(await auth.status()).includes("private-database"));
  await web.locked(async (same, save) => { assert.equal(same.hostId, state.hostId); await save(same); });
  assert.notEqual(await encrypted(id), first, "each encryption must use a fresh nonce");
  assert.deepEqual(await worker.read(), state);
});

test("wrong keys, changed ciphertext and another owner's ciphertext fail closed without overwriting data", async () => {
  const id = await owner(), other = await owner(), store = storeFor(id);
  await seed(store); const original = await encrypted(id);
  const wrongKey = new DatabasePlanAuthStore(pool, id, randomBytes(32).toString("hex"));
  await assert.rejects(wrongKey.read(), /could not be decrypted/);
  await assert.rejects(wrongKey.locked(async () => {}), /could not be decrypted/);
  assert.equal(await encrypted(id), original);
  await db.insert(s.chatgptCredentialStore).values({ userId: other, ciphertext: original });
  await assert.rejects(storeFor(other).read(), /could not be decrypted/);
  const parts = original.split(".");
  const bytes = Buffer.from(parts[3], "base64url"); bytes[0] ^= 1; parts[3] = bytes.toString("base64url");
  await db.update(s.chatgptCredentialStore).set({ ciphertext: parts.join(".") }).where(eq(s.chatgptCredentialStore.userId, id));
  await assert.rejects(store.read(), /could not be decrypted/);
});

test("separate database connections cannot refresh the same rotating token concurrently", async () => {
  const id = await owner(), web = storeFor(id), initial = await seed(web, true);
  let release!: () => void, started!: () => void, refreshes = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const pending = new Promise<void>(resolve => { started = resolve; });
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("openid-configuration")) return Response.json(discovery);
    refreshes++;
    assert.equal((init!.body as URLSearchParams).get("refresh_token"), profile().tokens!.refresh);
    started(); await blocked;
    return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", token_type: "Bearer", expires_in: 3600 });
  };
  const first = new PlanAuth(undefined, fetcher, web);
  const second = new PlanAuth(undefined, fetcher, storeFor(id, workerPool));
  const access = first.access("account");
  try {
    await pending;
    await assert.rejects(second.access("account"), /busy/);
    // Different Lorefold accounts do not share a lock.
    await seed(storeFor(await owner(), workerPool));
  } finally { release(); }
  assert.equal((await access).token, "rotated-access");
  assert.equal((await second.access("account")).token, "rotated-access");
  assert.equal(refreshes, 1);
  const state = (await web.read())!;
  assert.equal(state.hostId, initial.hostId);
  assert.equal(state.profiles.account.tokens!.refresh, "rotated-refresh");
  assert.equal(state.profiles.account.tokens!.id, profile().tokens!.id);
});

test("terminal refresh failure persists disconnection; transient failure preserves credentials", async () => {
  const id = await owner(), store = storeFor(id);
  const original = await seed(store, true);
  const auth = (terminal: boolean) => new PlanAuth(undefined, async url => String(url).endsWith("openid-configuration")
    ? Response.json(discovery) : Response.json({ error: terminal ? "invalid_grant" : "temporarily_unavailable" }, { status: terminal ? 400 : 503 }), store);
  await assert.rejects(auth(false).access("account"), /preserved/);
  assert.deepEqual(await store.read(), original);
  await assert.rejects(auth(true).access("account"), /Session expired/);
  const restarted = (await storeFor(id, workerPool).read())!;
  assert.equal(restarted.profiles.account.tokens, null);
  assert.equal(restarted.profiles.account.clientId, original.profiles.account.clientId);
  assert.equal(restarted.hostId, original.hostId);
});

test("disconnect removes all tokens while retaining the registration and host for reconnecting", async () => {
  const id = await owner(), store = storeFor(id), initial = await seed(store);
  let revoked = false;
  const auth = new PlanAuth(undefined, async (url, init) => {
    if (String(url).endsWith("openid-configuration")) return Response.json(discovery);
    assert.equal(String(url), discovery.revocation_endpoint);
    assert.equal((init!.body as URLSearchParams).get("token"), profile().tokens!.refresh);
    revoked = true; return new Response("");
  }, store);
  assert.deepEqual(await auth.logout("account"), { revoked: true });
  assert.equal(revoked, true);
  const saved = (await storeFor(id, workerPool).read())!;
  assert.equal(saved.profiles.account.tokens, null);
  assert.equal(saved.hostId, initial.hostId);
  assert.equal(saved.profiles.account.clientId, initial.profiles.account.clientId);
});

test("database locks are released after errors and connection loss, without leaving a stale lock file", async () => {
  const id = await owner(), store = storeFor(id);
  await assert.rejects(store.locked(async () => { throw new Error("fixture failure"); }), /fixture failure/);
  await seed(store);
  const exclusivePool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  // Only this test uses exclusivePool: this PID belongs to the exact connection
  // subsequently borrowed by our store, never an app or another project's session.
  const pid = (await exclusivePool.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
  const crashing = storeFor(id, exclusivePool);
  let release!: () => void, ready!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { ready = resolve; });
  const action = crashing.locked(async () => { ready(); await gate; });
  try {
    await started;
    await assert.rejects(store.locked(async () => {}), /busy/);
    await pool.query("select pg_terminate_backend($1)", [pid]);
    // Waiting for the terminated client's error event is bounded by a short poll.
    for (let attempt = 0; ; attempt++) {
      try { await store.locked(async () => {}); break; }
      catch (error) { if (attempt === 20 || !(error instanceof Error) || !error.message.includes("busy")) throw error; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } finally { release(); await action; await exclusivePool.end(); }
});

test("deleting a Lorefold user deletes their encrypted credentials", async () => {
  const id = await owner(), store = storeFor(id);
  await seed(store);
  await db.delete(s.user).where(eq(s.user.id, id));
  assert.equal(await store.read(), null);
});
