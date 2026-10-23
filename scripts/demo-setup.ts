import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db, pool } from "../backend/db/client.js";
import { user } from "../backend/db/schema.js";
import { provisionUser } from "../backend/provision-user.js";
import { seedSample } from "../backend/db/sample.js";

try {
  if (
    process.env.NODE_ENV !== "development" ||
    !process.env.LOREFOLD_WORKTREE_ID ||
    new URL(process.env.DATABASE_URL!).hostname !== "127.0.0.1"
  ) {
    throw new Error(
      "Demo setup is only available through a local worktree development environment.",
    );
  }
  const file = new URL("../.lorefold/demo-account.json", import.meta.url);
  const email = "reader@lorefold.local";
  const [existing] = await db.select().from(user).where(eq(user.email, email));
  let credentials: { email: string; password: string };
  try {
    credentials = JSON.parse(await readFile(file, "utf8"));
    if (
      credentials.email !== email ||
      typeof credentials.password !== "string" ||
      credentials.password.length < 12
    ) {
      throw new Error(
        "The local demo credential file is invalid. Use user:create to provision another account.",
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (existing)
      throw new Error(
        "The demo account already exists but its credential file is missing. Use user:create to provision another account.",
      );
    credentials = { email, password: randomBytes(24).toString("base64url") };
    await mkdir(new URL("../.lorefold/", import.meta.url), {
      recursive: true,
      mode: 0o700,
    });
    // Save first so interrupted setup or a recreated DB can reuse the same local credentials.
    await writeFile(file, JSON.stringify(credentials, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  }
  const id =
    existing?.id ??
    (await provisionUser(email, credentials.password, "Reader"));
  await seedSample(id);
  console.log(
    "Local demo ready. Sign-in details are in .lorefold/demo-account.json (ignored by Git).",
  );
} catch (error) {
  console.error(
    (error as Error).cause
      ? "Demo setup failed. Check the local database and migrations."
      : (error as Error).message,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
