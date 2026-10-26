import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { app } from "../backend/app.js";
import { db, pool } from "../backend/db/client.js";
import * as s from "../backend/db/schema.js";
import { provisionUser } from "../backend/provision-user.js";
import { accountAuth, PersonalChatGPTConnections, personalConnectionConfiguration } from "../backend/chatgpt/connections.js";
import type { PlanAuth } from "../backend/chatgpt/auth.js";
import { defaultAnalysisPreference } from "../shared/ai.js";

if (!process.env.LOREFOLD_WORKTREE_ID) throw new Error("Use the worktree launcher.");
const origin = process.env.APP_ORIGIN!;
const users: string[] = [], cookies: string[] = [];
const request = (path: string, init: RequestInit = {}, cookie: string | null = cookies[0]) => app.request(`${origin}/api${path}`, {
  ...init, headers: { origin, ...(cookie ? { cookie } : {}), ...init.headers },
});
const json = (body: unknown) => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
before(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
  for (let i = 0; i < 2; i++) {
    const email = `ai-${randomUUID()}@example.test`, password = randomUUID();
    users.push(await provisionUser(email, password, "AI reader"));
    const response = await request("/auth/sign-in/email", { ...json({ email, password }), method: "POST" }, null);
    assert.equal(response.status, 200);
    cookies.push(response.headers.getSetCookie().map(c => c.split(";")[0]).join("; "));
  }
});
after(async () => {
  try {
    for (const id of users) {
      await db.delete(s.user).where(eq(s.user.id, id));
      await rm(accountAuth(id).directory, { recursive: true, force: true });
    }
  } finally { await pool.end(); }
});

test("AI settings default to Astra high and persist only for the authenticated account", async () => {
  const first = await request("/settings/ai");
  assert.equal(first.status, 200); assert.equal(first.headers.get("cache-control"), "no-store");
  const body = await first.json();
  assert.deepEqual(body.preference, defaultAnalysisPreference);
  assert.equal(body.chatgpt.connected, false); // Never adopts the real CLI profile.
  assert.equal(body.chatgpt.email, null);
  for (const model of ["gpt-6-astra", "gpt-6.1-sol"]) for (const effort of ["medium", "high", "xhigh"]) {
    assert.equal((await request("/settings/ai", json({ model, effort }))).status, 200);
    assert.deepEqual((await (await request("/settings/ai")).json()).preference, { model, effort });
    assert.deepEqual((await (await request("/settings/ai", {}, cookies[1])).json()).preference, defaultAnalysisPreference);
  }
  const [row] = await db.select().from(s.userAiPreferences).where(eq(s.userAiPreferences.userId, users[0]));
  assert.equal(row.model, "gpt-6.1-sol"); assert.equal(row.effort, "xhigh");
  for (const invalid of [null, [], {}, { ...defaultAnalysisPreference, userId: users[1] },
    { model: "arbitrary-model", effort: "high" }, { model: "gpt-6-astra", effort: "ultra" }])
    assert.equal((await request("/settings/ai", json(invalid))).status, 400);
});

test("settings and connection routes require authentication and same-origin mutations", async () => {
  for (const [path, method] of [["/settings/ai", "GET"], ["/settings/ai", "PUT"], ["/connections/chatgpt", "POST"],
    ["/connections/chatgpt", "DELETE"], ["/connections/chatgpt/attempt", "GET"], ["/connections/chatgpt/attempt", "DELETE"]]) {
    assert.equal((await request(path, { method }, null)).status, 401);
    if (method !== "GET") for (const badOrigin of ["https://foreign.example", ""]) {
      assert.equal((await request(path, { method, headers: { origin: badOrigin } })).status, 403);
    }
  }
});

function fixtureConnections() {
  const clients = new Map<string, { connected: boolean; complete: () => void; logouts: number }>();
  let validSession = true;
  const factory = (id: string): Pick<PlanAuth, "login" | "status" | "logout"> => {
    if (!clients.has(id)) clients.set(id, { connected: false, complete: () => {}, logouts: 0 });
    const client = clients.get(id)!;
    return {
      status: async () => client.connected ? [{ profile: "account", connected: true, email: `${id}@example.test`, planEnabled: true, expiresAt: null }] : [],
      login: async (name, port, ready, signal, canSave) => {
        await new Promise<void>((resolve, reject) => {
          client.complete = resolve;
          signal?.addEventListener("abort", () => reject(new Error("Secret must not escape")), { once: true });
          ready(`https://auth.openai.com/api/accounts/authorize?fixture=${id}`);
        });
        if (signal?.aborted || !await canSave!()) throw new Error("Expired Lorefold session");
        client.connected = true;
        return { profile: name, email: `${id}@example.test`, planEnabled: true };
      },
      logout: async () => { client.connected = false; client.logouts++; return { revoked: false }; },
    };
  };
  const service = new PersonalChatGPTConnections({ enabled: true, port: 15190, sshTarget: "reader@private.example" }, factory,
    async (id, session) => validSession && session === `${id}-session`);
  return { service, clients, invalidate: () => { validSession = false; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test("OAuth attempts bind to their user and browser session; disconnect cannot touch another account", async () => {
  const { service, clients } = fixtureConnections();
  try {
    const attempt = await service.start("alice", "alice-session");
    assert.match(attempt.tunnelCommand!, /127\.0\.0\.1:15190/);
    assert.deepEqual(service.progress("bob", "bob-session"), { state: "none" });
    assert.throws(() => service.progress("alice", "different-session"), /browser session/);
    await assert.rejects(service.cancel("alice", "different-session"), /browser session/);
    await assert.rejects(service.start("bob", "bob-session"), /already in progress/);
    clients.get("alice")!.complete(); await tick();
    assert.equal((await service.status("alice")).connected, true);
    assert.equal((await service.status("bob")).connected, false);
    await service.disconnect("bob");
    assert.equal((await service.status("alice")).connected, true);
    assert.equal(clients.get("alice")!.logouts, 0);
    assert.equal((await service.disconnect("alice")).revoked, false);
    assert.equal((await service.status("alice")).connected, false);
    assert.equal(JSON.stringify(await service.status("alice")).includes("Secret"), false);
  } finally { await service.close(); }
});
test("cancel, session expiry, disconnect races and shutdown prevent late connections", async () => {
  for (const mode of ["cancel", "expired", "disconnect", "shutdown"]) {
    const { service, clients, invalidate } = fixtureConnections();
    try {
      await service.start("alice", "alice-session");
      if (mode === "expired") { invalidate(); clients.get("alice")!.complete(); await tick(); }
      if (mode === "cancel") await service.cancel("alice", "alice-session");
      if (mode === "disconnect") { clients.get("alice")!.complete(); await service.disconnect("alice"); }
      if (mode === "shutdown") await service.close();
      assert.equal((await service.status("alice")).connected, false, mode);
      assert.equal((await service.status("alice")).pending, false, mode);
    } finally { await service.close(); }
  }
});
test("personal ChatGPT must be explicitly configured and cannot be enabled in production", async () => {
  assert.equal(personalConnectionConfiguration({}).enabled, false);
  assert.equal(personalConnectionConfiguration({ NODE_ENV: "production", LOREFOLD_CHATGPT_PERSONAL: "1" }).enabled, false);
  for (const config of [{ LOREFOLD_CHATGPT_CALLBACK_PORT: "15191" }, { LOREFOLD_CHATGPT_SSH_TARGET: "host; echo unsafe" }])
    assert.throws(() => personalConnectionConfiguration({ LOREFOLD_CHATGPT_PERSONAL: "1", ...config }), /Invalid/);
  const service = new PersonalChatGPTConnections({ enabled: false, port: 15190, sshTarget: null });
  await assert.rejects(service.start("alice", "alice-session"), /personal development/);
});
