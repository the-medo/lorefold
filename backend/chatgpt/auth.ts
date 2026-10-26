import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from "jose";

export const ISSUER = "https://auth.openai.com";
export const RESOURCE = "https://api.openai.com/v1";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
type Tokens = { access: string; refresh: string; id: string; expiresAt: number; scopes: string[] };
export type Profile = { clientId: string; subject: string | null; email: string | null; tokens: Tokens | null };
type State = { version: 1; hostId: string; profiles: Record<string, Profile> };
type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; revocation_endpoint: string };
export const authDirectory = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "lorefold", "chatgpt-plan");
export function profileName(name: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name) || ["constructor", "prototype"].includes(name)) throw new Error("Profile must be a short lowercase name (letters, digits, _ or -).");
  return name;
}
export const profileFingerprint = (p: Profile) => createHash("sha256").update(`${p.clientId}\0${p.subject}`).digest("hex");
export const hasPlan = (p?: Profile) => Boolean(p?.tokens?.scopes.includes(PLAN_SCOPE) && p.tokens.scopes.includes("resource.invoke"));
const random = () => randomBytes(32).toString("base64url");

export function authorization(hostId: string, existing: Profile | undefined, port: number) {
  if (!Number.isInteger(port) || port < 15184 || port > 15190) throw new Error("Callback port must be in 15184–15190; use a free port.");
  const state = random(), nonce = random(), verifier = random();
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const url = new URL(`${ISSUER}/api/accounts/authorize`);
  url.search = new URLSearchParams({ client_id: existing?.clientId ?? "dynamic_agent_client",
    ...(existing ? {} : { agent_name_hint: "Lorefold" }), ext_agent_host_id: hostId,
    ...(existing && !hasPlan(existing) ? { prompt: "consent" } : {}),
    response_type: "code", redirect_uri: redirectUri, scope: SCOPES, resource: RESOURCE,
    state, nonce, code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url") }).toString();
  // Omit optional ID/email hints: this URL is displayed in a terminal, not kept secret.
  return { url: url.toString(), state, nonce, verifier, redirectUri, existing };
}
export type Attempt = ReturnType<typeof authorization>;
export function callback(attempt: Attempt, url: URL) {
  if (url.origin + url.pathname !== attempt.redirectUri || url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== attempt.state)
    throw new Error("OAuth callback state or destination did not match.");
  if (url.searchParams.has("error")) throw new Error("OpenAI sign-in was declined or failed. No credentials were exchanged.");
  const code = url.searchParams.get("code"), returnedId = url.searchParams.get("client_id");
  const clientId = returnedId ?? attempt.existing?.clientId;
  if (!code || code.length > 16384 || url.searchParams.getAll("code").length !== 1 || url.searchParams.getAll("client_id").length > 1 ||
      !clientId || clientId === "dynamic_agent_client" || !/^[a-zA-Z0-9_-]{1,200}$/.test(clientId) ||
      (attempt.existing && attempt.existing.clientId !== clientId)) throw new Error("OAuth callback has an invalid code or client registration.");
  return { code, clientId };
}

export async function verifyIdentity(token: string, clientId: string, nonce: string | undefined, previous: string | null, keys: JWTVerifyGetKey) {
  try {
    const { payload } = await jwtVerify(token, keys, { issuer: ISSUER, audience: clientId, requiredClaims: ["exp", "iat", "sub"], clockTolerance: 5, algorithms: ["RS256", "ES256"] });
    if (!payload.sub || (nonce !== undefined && payload.nonce !== nonce) || (previous !== null && payload.sub !== previous)) throw new Error();
    return { subject: payload.sub, email: typeof payload.email === "string" ? payload.email : null };
  } catch { throw new Error("OpenAI identity signature, audience, expiry, nonce or account did not validate."); }
}

const EXPIRED_REFRESH = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);
class AuthHTTPError extends Error {
  constructor(status: number, readonly expiredRefresh: boolean) { super(`OpenAI authentication HTTP ${status}. ${expiredRefresh ? "Session expired; sign in again." : "Check the connection and registration; credentials have been preserved."}`); }
}
async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error("OpenAI authentication response exceeded its size limit.");
  let data;
  try { data = JSON.parse(text); } catch { if (!response.ok) throw new AuthHTTPError(response.status, false); throw new Error("OpenAI authentication returned an invalid response."); }
  if (!response.ok) throw new AuthHTTPError(response.status, EXPIRED_REFRESH.has(typeof data?.error === "string" ? data.error : data?.error?.code));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("OpenAI authentication returned an invalid response.");
  return data;
}
function tokens(data: Record<string, unknown>, old?: Tokens): Tokens {
  if (typeof data.access_token !== "string" || !data.access_token || typeof data.refresh_token !== "string" || !data.refresh_token ||
      data.token_type !== "Bearer" || typeof data.expires_in !== "number" || data.expires_in <= 0 || data.expires_in > 86400 ||
      (!old && typeof data.scope !== "string") || (!old && typeof data.id_token !== "string")) throw new Error("OpenAI returned incomplete credentials.");
  return { access: data.access_token, refresh: data.refresh_token,
    id: typeof data.id_token === "string" ? data.id_token : old!.id,
    scopes: typeof data.scope === "string" ? data.scope.split(/\s+/).filter(Boolean) : old!.scopes,
    expiresAt: Date.now() + data.expires_in * 1000 };
}

export class PlanAuth {
  constructor(readonly directory = authDirectory(), readonly send: typeof fetch = fetch) {}
  private async request(url: string, init: RequestInit = {}) {
    try { return await this.send(url, { ...init, redirect: "error", signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) }); }
    catch { throw new Error("OpenAI authentication connection failed. No credentials were logged."); }
  }
  private async discovery(signal?: AbortSignal): Promise<Discovery> {
    const data = await jsonResponse(await this.request(`${ISSUER}/.well-known/openid-configuration`, { signal }));
    if (data.issuer !== ISSUER || ["authorization_endpoint", "token_endpoint", "jwks_uri", "revocation_endpoint"].some(k => {
      try { return new URL(String(data[k])).origin !== ISSUER; } catch { return true; }
    })) throw new Error("OpenAI discovery returned an unexpected issuer or endpoint.");
    return data as unknown as Discovery;
  }
  async read(): Promise<State | null> {
    const path = join(this.directory, "accounts.json");
    try {
      const info = await lstat(path);
      if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error();
      const data = JSON.parse(await readFile(path, "utf8")) as State;
      if (data.version !== 1 || !/^urn:uuid:[a-f0-9-]{36}$/.test(data.hostId) || !data.profiles || typeof data.profiles !== "object" || Array.isArray(data.profiles)) throw new Error();
      for (const [name, p] of Object.entries(data.profiles)) {
        profileName(name);
        if (!p || typeof p.clientId !== "string" || p.clientId === "dynamic_agent_client" || (p.subject !== null && typeof p.subject !== "string") ||
            (p.tokens && (typeof p.tokens.access !== "string" || typeof p.tokens.refresh !== "string" || typeof p.tokens.id !== "string" ||
              !Number.isFinite(p.tokens.expiresAt) || !Array.isArray(p.tokens.scopes) || p.tokens.scopes.some(s => typeof s !== "string")))) throw new Error();
      }
      return data;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("ChatGPT credential store is invalid or not owner-only. Refusing to use it.");
    }
  }
  private async save(state: State) {
    const path = join(this.directory, `accounts.${randomUUID()}.tmp`);
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(path, join(this.directory, "accounts.json"));
  }
  private async locked<T>(action: (state: State) => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) throw new Error("ChatGPT credential directory must be owned by this user.");
    await chmod(this.directory, 0o700);
    const lockPath = join(this.directory, "session.lock");
    let lock;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch { throw new Error("ChatGPT session is busy. After a crash, confirm its PID has stopped before removing session.lock."); }
    try {
      await lock.writeFile(String(process.pid));
      const saved = await this.read();
      const state: State = saved ?? { version: 1, hostId: `urn:uuid:${randomUUID()}`, profiles: {} };
      if (!saved) await this.save(state);
      return await action(state);
    } finally { await lock.close(); await rm(lockPath); }
  }
  async status() {
    const state = await this.read();
    return Object.entries(state?.profiles ?? {}).map(([name, p]) => ({ profile: name, email: p.email,
      connected: Boolean(p.tokens), planEnabled: hasPlan(p), expiresAt: p.tokens ? new Date(p.tokens.expiresAt).toISOString() : null }));
  }
  async login(name: string, port: number, onReady: (url: string) => void, signal?: AbortSignal, canSave: () => Promise<boolean> = async () => true) {
    profileName(name);
    return this.locked(async state => {
      const discovery = await this.discovery(signal);
      const attempt = authorization(state.hostId, state.profiles[name], port);
      let accept!: (value: ReturnType<typeof callback>) => void, decline!: (error: Error) => void;
      const received = new Promise<ReturnType<typeof callback>>((resolve, reject) => { accept = resolve; decline = reject; });
      // Attach immediately so an abort during listener setup cannot become unhandled.
      void received.catch(() => {});
      let consumed = false;
      const server = createServer((req, res) => {
        res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        if (req.method !== "GET" || req.headers.host !== `127.0.0.1:${port}` || (req.url?.length ?? 0) > 20000) { res.writeHead(400).end("Invalid callback."); return; }
        const url = new URL(req.url ?? "/", attempt.redirectUri);
        if (url.pathname !== "/auth/callback" || url.searchParams.get("state") !== attempt.state || consumed) { res.writeHead(400).end("Invalid or expired callback."); return; }
        consumed = true;
        try { accept(callback(attempt, url)); res.end("Authorization received. Return to Lorefold for verification results. You can close this tab."); }
        catch (error) { decline(error as Error); res.writeHead(400).end("Authorization was declined or invalid. Return to Lorefold."); }
      });
      const cancelled = () => decline(new Error("ChatGPT sign-in cancelled or timed out. Run login again."));
      const timeout = setTimeout(cancelled, 20 * 60 * 1000);
      signal?.addEventListener("abort", cancelled, { once: true });
      try {
        await new Promise<void>((resolve, reject) => { server.once("error", () => reject(new Error("Callback port is unavailable; choose another free port in 15184–15190."))); server.listen(port, "127.0.0.1", resolve); });
        if (signal?.aborted) cancelled(); else onReady(attempt.url);
        const result = await received;
        // Keep the issued registration even if its first code expires during exchange.
        state.profiles[name] ??= { clientId: result.clientId, subject: null, email: null, tokens: null };
        await this.save(state);
        const data = await jsonResponse(await this.request(discovery.token_endpoint, { method: "POST", signal, body: new URLSearchParams({
          grant_type: "authorization_code", client_id: result.clientId, code: result.code,
          code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: RESOURCE,
        }) }));
        const next = tokens(data);
        try {
          const identity = await verifyIdentity(next.id, result.clientId, attempt.nonce, attempt.existing?.subject ?? null, createRemoteJWKSet(new URL(discovery.jwks_uri), { [customFetch]: (url, init) => this.send(url, { ...init, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) }) }));
          if (!await canSave() || signal?.aborted) throw new Error("ChatGPT sign-in cancelled or Lorefold session expired. Sign in again.");
          state.profiles[name] = { clientId: result.clientId, ...identity, tokens: next };
          await this.save(state);
          return { profile: name, email: identity.email, planEnabled: hasPlan(state.profiles[name]) };
        } catch (error) {
          // A cancelled/invalid link must not leave the newly issued renewable
          // session active. Bound this cleanup so shutdown can release its lock.
          try {
            const revoked = await this.request(discovery.revocation_endpoint, { method: "POST", signal: AbortSignal.timeout(3000), body: new URLSearchParams({
              token: next.refresh, token_type_hint: "refresh_token", client_id: result.clientId,
            }) });
            await revoked.body?.cancel();
          } catch { /* No credentials are retained or exposed on a failed link. */ }
          throw error;
        }
      } finally {
        clearTimeout(timeout); signal?.removeEventListener("abort", cancelled);
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  }
  async access(name: string, expectedFingerprint?: string) {
    profileName(name);
    return this.locked(async state => {
      const p = state.profiles[name];
      if (!p?.subject || !p.tokens || !hasPlan(p)) throw new Error("Provider ChatGPT plan is not connected or not authorized. Run npm run chatgpt:plan -- login.");
      if (expectedFingerprint && profileFingerprint(p) !== expectedFingerprint) throw new Error("Provider ChatGPT account does not match this benchmark. Refusing to resume.");
      if (p.tokens.expiresAt < Date.now() + 60000) {
        const discovery = await this.discovery();
        let data;
        try {
          data = await jsonResponse(await this.request(discovery.token_endpoint, { method: "POST", body: new URLSearchParams({
            grant_type: "refresh_token", client_id: p.clientId, refresh_token: p.tokens.refresh, resource: RESOURCE,
          }) }));
        } catch (error) {
          if (error instanceof AuthHTTPError && error.expiredRefresh) { p.tokens = null; await this.save(state); }
          throw error;
        }
        const next = tokens(data, p.tokens);
        if (typeof data.id_token === "string") await verifyIdentity(next.id, p.clientId, undefined, p.subject, createRemoteJWKSet(new URL(discovery.jwks_uri), { [customFetch]: this.send }));
        p.tokens = next;
        await this.save(state);
        if (!hasPlan(p)) throw new Error("Provider ChatGPT plan permission was removed. Sign in again.");
      }
      return { token: p.tokens.access, fingerprint: profileFingerprint(p) };
    });
  }
  async logout(name: string) {
    profileName(name);
    return this.locked(async state => {
      const p = state.profiles[name];
      if (!p?.tokens) return { revoked: true };
      let revoked = false;
      try {
        const discovery = await this.discovery();
        const response = await this.request(discovery.revocation_endpoint, { method: "POST", body: new URLSearchParams({
          token: p.tokens.refresh, token_type_hint: "refresh_token", client_id: p.clientId,
        }) });
        revoked = response.status === 200; await response.body?.cancel();
      } catch { /* Still remove local credentials; report unconfirmed revocation. */ }
      p.tokens = null; await this.save(state);
      return { revoked };
    });
  }
}
