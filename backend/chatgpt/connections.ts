import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { HTTPException } from "hono/http-exception";
import type { ChatGPTConnection, ConnectionAttempt, ConnectionProgress } from "../../shared/ai.js";
import { PlanAuth } from "./auth.js";

type Client = Pick<PlanAuth, "login" | "status" | "logout">;
type Configuration = { enabled: boolean; port: number; sshTarget: string | null };
type Pending = {
  sessionId: string; controller: AbortController; done: Promise<void>;
  progress: ConnectionProgress; finished: boolean; expires: number;
};
export function personalConnectionConfiguration(env: NodeJS.ProcessEnv): Configuration {
  const enabled = env.NODE_ENV !== "production" && env.LOREFOLD_CHATGPT_PERSONAL === "1";
  const port = Number(env.LOREFOLD_CHATGPT_CALLBACK_PORT ?? 15190);
  const sshTarget = env.LOREFOLD_CHATGPT_SSH_TARGET || null;
  if (enabled && (!Number.isInteger(port) || port < 15184 || port > 15190 ||
    (sshTarget && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(sshTarget))))
    throw new Error("Invalid personal ChatGPT callback port or SSH target.");
  return { enabled, port, sshTarget };
}

// Account IDs only select an isolated store after the API authenticates a session.
// Never adopt the machine-wide CLI profile: it has no Lorefold account owner.
export function accountAuth(userId: string) {
  const key = createHash("sha256").update(userId).digest("hex");
  return new PlanAuth(resolve(".lorefold/chatgpt-accounts", key));
}

export class PersonalChatGPTConnections {
  private attempts = new Map<string, Pending>();
  private changing = new Set<string>();
  private closing = false;
  constructor(
    private config: Configuration,
    private client: (userId: string) => Client = accountAuth,
    private sessionIsActive: (userId: string, sessionId: string) => Promise<boolean> = async () => false,
  ) {}
  private enabled() {
    if (!this.config.enabled) throw new HTTPException(409, { message: "ChatGPT connections are available only in a configured personal development installation." });
  }
  async status(userId: string): Promise<ChatGPTConnection> {
    const profile = (await this.client(userId).status()).find(p => p.profile === "account");
    return { enabled: this.config.enabled, connected: Boolean(profile?.connected), planEnabled: Boolean(profile?.planEnabled),
      email: profile?.email ?? null, registered: Boolean(profile), pending: Boolean(this.attempts.get(userId) && !this.attempts.get(userId)!.finished) };
  }
  progress(userId: string, sessionId: string): ConnectionProgress {
    const attempt = this.attempts.get(userId);
    if (!attempt || (attempt.finished && attempt.expires < Date.now())) return { state: "none" };
    if (attempt.sessionId !== sessionId) throw new HTTPException(409, { message: "Finish or cancel the connection in the browser session where you started it." });
    return attempt.progress;
  }
  async start(userId: string, sessionId: string): Promise<ConnectionAttempt> {
    this.enabled();
    if (this.closing) throw new HTTPException(503, { message: "Lorefold is restarting. Try again shortly." });
    // One loopback listener per installation. Reserve it before any async work.
    if (this.changing.has(userId) || [...this.attempts.values()].some(a => !a.finished))
      throw new HTTPException(409, { message: "A ChatGPT connection is already in progress. Finish or cancel it before trying again." });
    for (const [id, attempt] of this.attempts) if (attempt.finished && attempt.expires < Date.now()) this.attempts.delete(id);
    let ready!: (value: ConnectionAttempt) => void, failed!: (error: Error) => void;
    const listener = new Promise<ConnectionAttempt>((resolve, reject) => { ready = resolve; failed = reject; });
    const pending: Pending = { sessionId, controller: new AbortController(), done: Promise.resolve(), progress: { state: "none" }, finished: false, expires: Date.now() + 20 * 60_000 };
    this.attempts.set(userId, pending);
    pending.done = (async () => {
      try {
        const auth = this.client(userId);
        if ((await auth.status()).some(p => p.profile === "account" && p.connected && p.planEnabled))
          throw new Error("Already connected.");
        await auth.login("account", this.config.port, authorizationUrl => {
          const attempt: ConnectionAttempt = { authorizationUrl, expiresAt: new Date(pending.expires).toISOString(),
            tunnelCommand: this.config.sshTarget ? `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:${this.config.port}:127.0.0.1:${this.config.port} ${this.config.sshTarget}` : null };
          pending.progress = { state: "pending", attempt }; ready(attempt);
        }, pending.controller.signal, () => this.sessionIsActive(userId, sessionId));
        pending.progress = { state: "complete" };
      } catch {
        // Never return provider errors, codes, credentials or another user's URL.
        pending.progress = { state: "failed" };
        failed(new HTTPException(409, { message: "ChatGPT sign-in could not start. Check that the callback port is free and try again." }));
      } finally { pending.finished = true; }
    })();
    return listener;
  }
  async cancel(userId: string, sessionId: string) {
    this.progress(userId, sessionId); // Enforce the initiating browser session.
    if (this.changing.has(userId)) throw new HTTPException(409, { message: "A connection change is already in progress." });
    this.changing.add(userId);
    try {
      const attempt = this.attempts.get(userId);
      let revoked = true;
      if (attempt && !attempt.finished) {
        attempt.controller.abort(); await attempt.done;
        // If cancellation raced the final atomic save, undo that completed link.
        if (attempt.progress.state === "complete") revoked = (await this.client(userId).logout("account")).revoked;
      }
      this.attempts.delete(userId);
      return { revoked };
    } finally { this.changing.delete(userId); }
  }
  async disconnect(userId: string) {
    if (this.changing.has(userId)) throw new HTTPException(409, { message: "A connection change is already in progress." });
    this.changing.add(userId);
    try {
      const attempt = this.attempts.get(userId);
      if (attempt && !attempt.finished) { attempt.controller.abort(); await attempt.done; }
      this.attempts.delete(userId);
      return await this.client(userId).logout("account");
    } finally { this.changing.delete(userId); }
  }
  async close() {
    this.closing = true;
    for (const attempt of this.attempts.values()) attempt.controller.abort();
    await Promise.all([...this.attempts.values()].map(a => a.done));
    this.attempts.clear();
  }
}
