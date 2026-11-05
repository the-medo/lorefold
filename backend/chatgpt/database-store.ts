import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type pg from "pg";
import { emptyState, validateState, type PlanAuthStore, type SaveState, type State } from "./store.js";

// Separate from the import worker's lock namespace. Hash collisions only make a
// connection temporarily busy; every row and ciphertext is still bound to its user.
const LOCK_NAMESPACE = 0x4c434750;
const invalidStore = () => new Error("ChatGPT database credentials could not be decrypted or validated. Check the encryption key; saved credentials were preserved.");
export function connectionStorage(env: NodeJS.ProcessEnv): "file" | "database" {
  const mode = env.LOREFOLD_CHATGPT_STORAGE ?? "file";
  if (mode !== "file" && mode !== "database") throw new Error("Choose file or database for LOREFOLD_CHATGPT_STORAGE.");
  if (mode === "database") encryptionKey(env.LOREFOLD_CHATGPT_ENCRYPTION_KEY);
  return mode;
}
function encryptionKey(value: string | undefined): Buffer {
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value))
    throw new Error("Database ChatGPT storage requires LOREFOLD_CHATGPT_ENCRYPTION_KEY as 64 hexadecimal characters.");
  return Buffer.from(value, "hex");
}

export class DatabasePlanAuthStore implements PlanAuthStore {
  private readonly key: Buffer;
  private readonly aad: Buffer;
  constructor(private readonly pool: pg.Pool, private readonly userId: string, key: string | undefined) {
    if (!userId) throw new Error("ChatGPT database storage requires a Lorefold account.");
    this.key = encryptionKey(key);
    this.aad = Buffer.from(`lorefold:chatgpt:v1:${userId}`);
  }
  private encrypt(state: State): string {
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(this.aad);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(validateState(state)), "utf8"), cipher.final()]);
    return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
  }
  private decrypt(envelope: string): State {
    try {
      const [version, nonce, tag, ciphertext, extra] = envelope.split(".");
      if (version !== "v1" || extra !== undefined || !nonce || !tag || !ciphertext) throw new Error();
      const iv = Buffer.from(nonce, "base64url"), authTag = Buffer.from(tag, "base64url");
      if (iv.length !== 12 || authTag.length !== 16) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAAD(this.aad); decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]);
      return validateState(JSON.parse(plaintext.toString("utf8")));
    } catch { throw invalidStore(); }
  }
  private async readFrom(connection: pg.Pool | pg.PoolClient): Promise<State | null> {
    const result = await connection.query<{ ciphertext: string }>("select ciphertext from chatgpt_credential_store where user_id = $1", [this.userId]);
    return result.rows.length ? this.decrypt(result.rows[0].ciphertext) : null;
  }
  async read() { return this.readFrom(this.pool); }
  async locked<T>(action: (state: State, save: SaveState) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    let locked = false, disconnected = false;
    const onError = () => { disconnected = true; };
    connection.on("error", onError);
    try {
      const result = await connection.query<{ locked: boolean }>("select pg_try_advisory_lock($1, hashtext($2)) as locked", [LOCK_NAMESPACE, this.userId]);
      locked = result.rows[0].locked;
      if (!locked) throw new Error("ChatGPT connection is busy. Try again shortly.");
      const save: SaveState = async state => {
        if (disconnected) throw new Error("ChatGPT database connection was interrupted. Reconnect ChatGPT if its session cannot be renewed.");
        await connection.query(`insert into chatgpt_credential_store (user_id, ciphertext) values ($1, $2)
          on conflict (user_id) do update set ciphertext = excluded.ciphertext, updated_at = now()`, [this.userId, this.encrypt(state)]);
      };
      const saved = await this.readFrom(connection), state = saved ?? emptyState();
      if (!saved) await save(state);
      // No long transaction while the browser is authorizing. Each replacement
      // commits immediately, including token removal before a terminal error.
      return await action(state, save);
    } finally {
      if (locked && !disconnected) {
        try { await connection.query("select pg_advisory_unlock($1, hashtext($2))", [LOCK_NAMESPACE, this.userId]); }
        catch { disconnected = true; }
      }
      connection.removeListener("error", onError);
      connection.release(disconnected);
    }
  }
}
