import { eq } from "drizzle-orm";
import { db } from "./db/client.js";
import { user } from "./db/schema.js";

export function ownerEmail(env = process.env): string | null {
  const value = env.LOREFOLD_OWNER_EMAIL?.trim().toLowerCase();
  if (!value) return null;
  if (!/^[^\s,@]+@[^\s,@]+\.[^\s,@]+$/.test(value)) throw new Error("LOREFOLD_OWNER_EMAIL must contain one email address.");
  return value;
}
export function ownerAllowed(email: string, env = process.env): boolean {
  const owner = ownerEmail(env);
  return owner === null || owner === email.trim().toLowerCase();
}
export async function isInstallationOwner(userId: string): Promise<boolean> {
  const [account] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
  return Boolean(account && ownerAllowed(account.email));
}
