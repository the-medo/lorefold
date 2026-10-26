import { before, beforeEach, after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "../backend/db/client.js";
import { account, user, verification } from "../backend/db/schema.js";
import { provisionUser } from "../backend/provision-user.js";
import { seedSample } from "../backend/db/sample.js";
import { defaultTheme } from "../shared/themes.js";

if (!process.env.LOREFOLD_WORKTREE_ID) throw new Error("Use the worktree launcher.");
// Process-local fixtures: never use real credentials or contact Google in tests.
process.env.GOOGLE_CLIENT_ID = "synthetic-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "synthetic-client-secret";
const { app } = await import("../backend/app.js");
const origin = process.env.APP_ORIGIN!;
const email = `google-${randomUUID()}@example.test`;
const otherEmail = `google-other-${randomUUID()}@example.test`;
const newEmail = `google-new-${randomUUID()}@example.test`;
const unverifiedEmail = `google-unverified-${randomUUID()}@example.test`;
const password = randomUUID();
let ownerId: string, otherId: string, bookId: string, otherBookId: string;
const states: string[] = [];
// Independent synthetic clients keep each case within the real sign-in rate limit.
let client = 0;
beforeEach(() => { client++; });
const cookieFrom = (response: Response) => response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
const request = (path: string, init: RequestInit = {}, cookie = "") => app.request(`${origin}/api${path}`, {
  ...init,
  headers: { "content-type": "application/json", "x-forwarded-for": `192.0.2.${client}`, origin, cookie, ...init.headers },
});

before(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
  ownerId = await provisionUser(email, password, "Google reader");
  otherId = await provisionUser(otherEmail, password, "Other reader");
  bookId = await seedSample(ownerId);
  otherBookId = await seedSample(otherId);
});
after(async () => {
  try {
    await db.delete(user).where(inArray(user.email, [email, otherEmail, newEmail, unverifiedEmail]));
    if (states.length) await db.delete(verification).where(inArray(verification.identifier, states.map((state) => `auth-state:${state}`)));
  } finally { await pool.end(); }
});

async function begin(extra: Record<string, unknown> = {}) {
  const response = await request("/auth/sign-in/social", {
    method: "POST", body: JSON.stringify({ provider: "google", callbackURL: "/", errorCallbackURL: "/sign-in", disableRedirect: true, ...extra }),
  });
  assert.equal(response.status, 200);
  const url = new URL((await response.json()).url);
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("redirect_uri"), `${origin}/api/auth/callback/google`);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.deepEqual(url.searchParams.get("scope")?.split(" ").sort(), ["email", "openid", "profile"]);
  assert.equal(url.searchParams.get("access_type"), "online");
  const state = url.searchParams.get("state")!;
  assert.ok(state);
  states.push(state);
  return { state, cookie: cookieFrom(response), challenge: url.searchParams.get("code_challenge")! };
}

function googleResponse(t: TestContext, flow: Awaited<ReturnType<typeof begin>>, profile: { email: string; email_verified?: boolean; sub: string }) {
  const payload = Buffer.from(JSON.stringify({
    iss: "https://accounts.google.com", aud: process.env.GOOGLE_CLIENT_ID,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    name: "Synthetic Google reader", ...profile,
  })).toString("base64url");
  // The code flow trusts the TLS token exchange. Only that external boundary is
  // mocked; Better Auth still validates state/PKCE and performs all DB writes.
  return t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    assert.equal(url, "https://oauth2.googleapis.com/token", "Unexpected external request");
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("redirect_uri"), `${origin}/api/auth/callback/google`);
    assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), flow.challenge);
    assert.equal(body.get("code"), "synthetic-code");
    return Response.json({
      access_token: "synthetic-access-token", token_type: "Bearer", expires_in: 3600,
      id_token: `eyJhbGciOiJSUzI1NiJ9.${payload}.synthetic-signature`, scope: "openid email profile",
    });
  });
}

const finish = (flow: Awaited<ReturnType<typeof begin>>, cookie = flow.cookie) => request(
  `/auth/callback/google?code=synthetic-code&state=${encodeURIComponent(flow.state)}`, {}, cookie,
);
function assertFailure(response: Response, error: string) {
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location")!, origin);
  assert.equal(location.origin, origin);
  assert.equal(location.pathname, "/sign-in");
  assert.equal(location.searchParams.get("error"), error);
  assert.doesNotMatch(cookieFrom(response), /session_token=/);
}

test("Google provider discovery is public, uncached, and contains no credentials", async () => {
  const response = await request("/auth/providers");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { google: true });
});

test("verified Google links an existing password account, preserves ownership, and keeps email login working", async (t) => {
  const flow = await begin();
  googleResponse(t, flow, { email: email.toUpperCase(), email_verified: true, sub: "synthetic-owner" });
  const response = await finish(flow);
  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get("location")!, origin).href, `${origin}/`);
  const cookie = cookieFrom(response);
  assert.ok(cookie.includes(process.env.AUTH_COOKIE_PREFIX!));
  assert.match(response.headers.get("set-cookie")!, /HttpOnly/i);
  if (origin.startsWith("https:")) assert.match(response.headers.get("set-cookie")!, /Secure/i);
  assert.equal((await (await request("/auth/get-session", {}, cookie)).json()).user.id, ownerId);
  assert.deepEqual((await (await request("/books", {}, cookie)).json()).books.map((b: { id: string }) => b.id), [bookId]);
  assert.equal((await request(`/books/${otherBookId}/workspace`, {}, cookie)).status, 404);
  assert.equal((await request(`/books/${bookId}/progress`, { method: "PATCH", body: '{"completedChapter":1}' }, cookie)).status, 200);
  assert.equal((await (await request(`/books/${bookId}/workspace`, {}, cookie)).json()).book.completedChapter, 1);
  const accounts = await db.select().from(account).where(eq(account.userId, ownerId));
  assert.deepEqual(accounts.map((a) => a.providerId).sort(), ["credential", "google"]);
  assert.notEqual(accounts.find((a) => a.providerId === "google")?.accessToken, "synthetic-access-token");
  assert.equal((await request("/auth/sign-out", { method: "POST", body: "{}" }, cookie)).status, 200);
  assert.equal((await request("/books", {}, cookie)).status, 401);
  const emailLogin = await request("/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email, password }) });
  assert.equal(emailLogin.status, 200);
  assert.equal((await emailLogin.json()).user.id, ownerId);
});

test("returning Google sign-in uses the same user and does not duplicate accounts", async (t) => {
  const flow = await begin();
  googleResponse(t, flow, { email, email_verified: true, sub: "synthetic-owner" });
  const response = await finish(flow);
  assert.equal(response.status, 302);
  const session = await (await request("/auth/get-session", {}, cookieFrom(response))).json();
  assert.equal(session.user.id, ownerId);
  assert.equal((await db.select().from(account).where(eq(account.userId, ownerId))).length, 2);
});

test("first Google sign-in creates a private account and returning sign-in preserves its data", async (t) => {
  const flow = await begin(); // The regular Continue with Google flow needs no signup flag.
  const mock = googleResponse(t, flow, { email: newEmail.toUpperCase(), email_verified: true, sub: "synthetic-new" });
  const response = await finish(flow);
  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get("location")!, origin).href, `${origin}/`);
  const cookie = cookieFrom(response);
  const session = await (await request("/auth/get-session", {}, cookie)).json();
  assert.equal(session.user.email, newEmail);
  assert.equal(session.user.emailVerified, true);
  const id = session.user.id;
  const accounts = await db.select().from(account).where(eq(account.userId, id));
  assert.deepEqual(accounts.map((a) => a.providerId), ["google"]);
  assert.equal(accounts[0].password, null);
  assert.notEqual(accounts[0].accessToken, "synthetic-access-token");
  for (const collection of ["books", "universes", "themes"] as const) {
    assert.deepEqual((await (await request(`/${collection}`, {}, cookie)).json())[collection], []);
  }
  assert.equal((await request(`/books/${bookId}/workspace`, {}, cookie)).status, 404);
  const universe = await request("/universes", { method: "POST", body: JSON.stringify({ name: "New reader's universe" }) }, cookie);
  assert.equal(universe.status, 201);
  const universeId = (await universe.json()).universe.id;
  const theme = await request("/themes", { method: "POST", body: JSON.stringify({ name: "New reader's theme", config: defaultTheme }) }, cookie);
  assert.equal(theme.status, 201);
  const themeId = (await theme.json()).theme.id;
  assert.equal((await request("/auth/sign-out", { method: "POST", body: "{}" }, cookie)).status, 200);
  assert.equal((await request("/themes", {}, cookie)).status, 401);
  mock.mock.restore();

  const returning = await begin();
  googleResponse(t, returning, { email: newEmail, email_verified: true, sub: "synthetic-new" });
  const returningCookie = cookieFrom(await finish(returning));
  assert.equal((await (await request("/auth/get-session", {}, returningCookie)).json()).user.id, id);
  assert.equal((await db.select().from(user).where(eq(user.email, newEmail))).length, 1);
  assert.equal((await db.select().from(account).where(eq(account.userId, id))).length, 1);
  assert.deepEqual((await (await request("/universes", {}, returningCookie)).json()).universes.map((u: { id: string }) => u.id), [universeId]);
  assert.deepEqual((await (await request("/themes", {}, returningCookie)).json()).themes.map((theme: { id: string }) => theme.id), [themeId]);
  const otherLogin = await request("/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email: otherEmail, password }) });
  assert.equal((await request(`/universes/${universeId}`, {}, cookieFrom(otherLogin))).status, 404);
  assert.equal((await request(`/themes/${themeId}`, { method: "DELETE" }, cookieFrom(otherLogin))).status, 404);
});

test("Google cannot create an account without a verified email", async (t) => {
  for (const email_verified of [false, undefined]) {
    const flow = await begin({ requestSignUp: true });
    const mock = googleResponse(t, flow, { email: unverifiedEmail, email_verified, sub: "synthetic-unverified" });
    assertFailure(await finish(flow), "google_email_unverified");
    assert.equal((await db.select().from(user).where(eq(user.email, unverifiedEmail))).length, 0);
    assert.equal((await db.select().from(account).where(eq(account.accountId, "synthetic-unverified"))).length, 0);
    mock.mock.restore();
  }
});

test("unverified Google emails cannot link or sign in to existing accounts", async (t) => {
  for (const profile of [
    { email: otherEmail, email_verified: false, sub: "synthetic-other" },
    { email, email_verified: false, sub: "synthetic-owner" },
  ]) {
    const flow = await begin();
    const mock = googleResponse(t, flow, profile);
    const response = await finish(flow);
    const error = new URL(response.headers.get("location")!, origin).searchParams.get("error");
    assert.ok(error === "account_not_linked" || error === "google_email_unverified");
    assertFailure(response, error!);
    mock.mock.restore();
  }
  assert.deepEqual((await db.select().from(account).where(eq(account.userId, otherId))).map((a) => a.providerId), ["credential"]);
});

test("cancelled callbacks and callbacks without the browser state cannot create a session", async (t) => {
  const flow = await begin();
  const fetch = googleResponse(t, flow, { email, email_verified: true, sub: "synthetic-owner" });
  assertFailure(await request(`/auth/callback/google?error=access_denied&state=${encodeURIComponent(flow.state)}`, {}, flow.cookie), "access_denied");
  const missingCookieFlow = await begin();
  const rejected = await finish(missingCookieFlow, "");
  assert.equal(rejected.status, 302);
  assert.doesNotMatch(cookieFrom(rejected), /session_token=/);
  const replay = await finish(flow);
  assert.equal(replay.status, 302);
  assert.doesNotMatch(cookieFrom(replay), /session_token=/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("Google sign-in rejects foreign origins and callback destinations", async () => {
  for (const [headers, extra] of [
    [{ origin: "https://foreign.example" }, {}],
    [{}, { callbackURL: "https://foreign.example" }],
    [{}, { errorCallbackURL: "https://foreign.example" }],
  ] as const) {
    const response = await request("/auth/sign-in/social", {
      method: "POST", headers,
      body: JSON.stringify({ provider: "google", callbackURL: "/", ...extra }),
    });
    assert.equal(response.status, 403);
  }
});
