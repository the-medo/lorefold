import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import type { ChatGPTConnection, ConnectionAttempt, ConnectionProgress } from "../../shared/ai.js";
import type { PlanAuth } from "./auth.js";
import { accountAuth } from "./connections.js";

type Client = Pick<PlanAuth, "status" | "logout" | "prepareTransfer" | "importTransfer">;
type Pending = { userId: string; sessionId: string; expires: number; attempt: ConnectionAttempt;
  state: "pending" | "complete" | "failed"; cancelled: boolean; consumed: boolean; done: Promise<void> | null };
const digest = (code: string) => createHash("sha256").update(code).digest();
const denied = () => new HTTPException(401, { message: "Connection setup code is invalid, expired, or already used. Start again in Lorefold." });

// One personal owner, one web replica. Codes live only in memory: a restart
// cancels setup, but the established connection lives in encrypted PostgreSQL.
export class VMChatGPTConnections {
  private pending: Pending | null = null;
  private changing = false;
  private closing = false;
  constructor(private origin: string, private sessionIsActive: (userId: string, sessionId: string) => Promise<boolean>,
    private client: (userId: string) => Client = accountAuth, private now = Date.now) {}
  private live(p: Pending) { return !this.closing && !p.cancelled && p.expires > this.now(); }
  async status(userId: string): Promise<ChatGPTConnection> {
    const profile = (await this.client(userId).status()).find(p => p.profile === "account");
    return { enabled: true, connected: Boolean(profile?.connected), planEnabled: Boolean(profile?.planEnabled),
      email: profile?.email ?? null, registered: Boolean(profile),
      pending: Boolean(this.pending?.userId === userId && this.pending.state === "pending" && this.live(this.pending)) };
  }
  progress(userId: string, sessionId: string): ConnectionProgress {
    const p = this.pending;
    if (!p || p.userId !== userId) return { state: "none" };
    if (p.sessionId !== sessionId) throw new HTTPException(409, { message: "Finish or cancel the connection in the browser session where you started it." });
    if (!this.live(p)) return { state: "failed" };
    return p.state === "pending" ? { state: "pending", attempt: p.attempt } : { state: p.state };
  }
  async start(userId: string, sessionId: string): Promise<ConnectionAttempt> {
    if (this.closing || this.changing || (this.pending?.state === "pending" && this.live(this.pending)))
      throw new HTTPException(409, { message: "A ChatGPT connection change is already in progress. Finish or cancel it first." });
    this.changing = true;
    try {
      if (!await this.sessionIsActive(userId, sessionId)) throw denied();
      await this.client(userId).prepareTransfer(); // Persist the VM host before local OAuth.
      if (this.closing) throw denied();
      const expires = this.now() + 20 * 60000;
      const attempt: ConnectionAttempt = { authorizationUrl: "", tunnelCommand: null, expiresAt: new Date(expires).toISOString(),
        setupCode: randomBytes(32).toString("base64url"), serverUrl: this.origin };
      this.pending = { userId, sessionId, expires, attempt, state: "pending", consumed: false, cancelled: false, done: null };
      return attempt;
    } finally { this.changing = false; }
  }
  private async authorized(code: string): Promise<Pending> {
    const p = this.pending;
    if (!p || !/^[a-zA-Z0-9_-]{43}$/.test(code) || !timingSafeEqual(digest(code), digest(p.attempt.setupCode!)) ||
        p.state !== "pending" || p.consumed || !this.live(p) || !await this.sessionIsActive(p.userId, p.sessionId)) throw denied();
    // Recheck after session lookup: two submissions may have arrived together.
    if (p !== this.pending || p.consumed || !this.live(p)) throw denied();
    return p;
  }
  async registration(code: string) {
    const p = await this.authorized(code);
    return { registration: await this.client(p.userId).prepareTransfer() };
  }
  async receive(code: string, profile: unknown) {
    const p = await this.authorized(code);
    if (p.consumed || !this.live(p)) throw denied();
    p.consumed = true;
    p.done = (async () => {
      try {
        await this.client(p.userId).importTransfer(profile, async () => this.live(p) && await this.sessionIsActive(p.userId, p.sessionId));
        p.state = "complete";
      } catch {
        p.state = "failed";
        throw new HTTPException(400, { message: "The connection could not be verified. Start again in Lorefold." });
      }
    })();
    await p.done;
    return { connected: true };
  }
  async cancel(userId: string, sessionId: string) {
    this.progress(userId, sessionId);
    return this.stop(userId, false);
  }
  async disconnect(userId: string) { return this.stop(userId, true); }
  private async stop(userId: string, disconnect: boolean) {
    if (this.changing) throw new HTTPException(409, { message: "A connection change is already in progress." });
    this.changing = true;
    try {
      const p = this.pending?.userId === userId ? this.pending : null;
      const inFlight = Boolean(p?.done && p.state === "pending");
      if (p) { p.cancelled = true; await p.done?.catch(() => {}); this.pending = null; }
      return disconnect || (inFlight && p?.state === "complete") ? await this.client(userId).logout("account") : { revoked: true };
    } finally { this.changing = false; }
  }
  async close() {
    this.closing = true;
    if (this.pending) { this.pending.cancelled = true; await this.pending.done?.catch(() => {}); }
    this.pending = null;
  }
}
