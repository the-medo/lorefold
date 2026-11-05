import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export type Tokens = { access: string; refresh: string; id: string; expiresAt: number; scopes: string[] };
export type Profile = { clientId: string; subject: string | null; email: string | null; tokens: Tokens | null };
export type State = { version: 1; hostId: string; profiles: Record<string, Profile> };
export type SaveState = (state: State) => Promise<void>;
export interface PlanAuthStore {
  read(): Promise<State | null>;
  locked<T>(action: (state: State, save: SaveState) => Promise<T>): Promise<T>;
}
export function profileName(name: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name) || ["constructor", "prototype"].includes(name)) throw new Error("Profile must be a short lowercase name (letters, digits, _ or -).");
  return name;
}
export const emptyState = (): State => ({ version: 1, hostId: `urn:uuid:${randomUUID()}`, profiles: {} });
export function validateState(value: unknown): State {
  const data = value as State;
  if (!data || data.version !== 1 || !/^urn:uuid:[a-f0-9-]{36}$/.test(data.hostId) || !data.profiles || typeof data.profiles !== "object" || Array.isArray(data.profiles)) throw new Error("Invalid ChatGPT credential state.");
  for (const [name, p] of Object.entries(data.profiles)) {
    profileName(name);
    if (!p || typeof p.clientId !== "string" || p.clientId === "dynamic_agent_client" || (p.subject !== null && typeof p.subject !== "string") ||
        (p.email !== null && typeof p.email !== "string") ||
        (p.tokens && (typeof p.tokens.access !== "string" || typeof p.tokens.refresh !== "string" || typeof p.tokens.id !== "string" ||
          !Number.isFinite(p.tokens.expiresAt) || !Array.isArray(p.tokens.scopes) || p.tokens.scopes.some(s => typeof s !== "string")))) throw new Error("Invalid ChatGPT credential state.");
  }
  return data;
}

// CLI credentials and existing development connections retain their own files.
export class FilePlanAuthStore implements PlanAuthStore {
  constructor(readonly directory: string) {}
  async read(): Promise<State | null> {
    try {
      const path = join(this.directory, "accounts.json"), info = await lstat(path);
      if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error();
      return validateState(JSON.parse(await readFile(path, "utf8")));
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
  async locked<T>(action: (state: State, save: SaveState) => Promise<T>): Promise<T> {
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
      const saved = await this.read(), state = saved ?? emptyState();
      if (!saved) await this.save(state);
      return await action(state, state => this.save(state));
    } finally { await lock.close(); await rm(lockPath); }
  }
}
