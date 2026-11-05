import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

export interface Storage {
  get(key: string, maxBytes?: number): Promise<Buffer>;
  put(key: string, bytes: Buffer): Promise<void>;
  remove(key: string): Promise<void>;
}
function validKey(key: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,240}$/.test(key) || key.split("/").some(p => !p || p === "." || p === ".."))
    throw new Error("Invalid storage key.");
}
export function storage(env = process.env): Storage {
  const mode = env.LOREFOLD_STORAGE_MODE ?? "local";
  if (mode === "local") {
    if (env.NODE_ENV !== "development" || !env.LOREFOLD_WORKTREE_ID || !env.LOREFOLD_LOCAL_STORAGE_DIR)
      throw new Error("Local storage requires an isolated development worktree.");
    const root = env.LOREFOLD_LOCAL_STORAGE_DIR;
    return {
      async get(key, max = 32 * 1024 * 1024) { validKey(key); const data = await readFile(join(root, key)); if (data.length > max) throw new Error("Stored file too large."); return data; },
      async put(key, bytes) {
        validKey(key); const path = join(root, key); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temp = `${path}.${randomUUID()}.tmp`;
        try { await writeFile(temp, bytes, { mode: 0o600, flag: "wx" }); await rename(temp, path); }
        finally { await rm(temp, { force: true }); }
      },
      async remove(key) { validKey(key); await rm(join(root, key), { force: true }); },
    };
  }
  if (mode !== "r2" || (env.NODE_ENV !== "production" && env.LOREFOLD_R2_LIVE !== "1")) throw new Error("R2 storage requires explicit configuration.");
  const endpoint = env.R2_ENDPOINT ?? "", bucket = env.R2_BUCKET ?? "", prefix = env.R2_KEY_PREFIX ?? "";
  if (!/^https:\/\/[a-f0-9]{32}(?:\.eu|\.fedramp)?\.r2\.cloudflarestorage\.com\/?$/.test(endpoint) ||
    !bucket || !prefix || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) throw new Error("Incomplete private R2 configuration.");
  validKey(prefix.replace(/\/$/, ""));
  const client = new S3Client({ region: "auto", endpoint, maxAttempts: 2,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } });
  const keyFor = (key: string) => { validKey(key); return `${prefix.replace(/\/$/, "")}/${key}`; };
  return {
    async put(key, bytes) { await client.send(new PutObjectCommand({ Bucket: bucket, Key: keyFor(key), Body: bytes, ContentType: "application/octet-stream" })); },
    async get(key, max = 32 * 1024 * 1024) {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(key) }));
      if (!result.Body) throw new Error("Stored file unavailable.");
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) { length += chunk.length; if (length > max) throw new Error("Stored file too large."); chunks.push(Buffer.from(chunk)); }
      return Buffer.concat(chunks);
    },
    async remove(key) { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: keyFor(key) })); },
  };
}
