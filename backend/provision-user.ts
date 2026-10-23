import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { db } from "./db/client.js";
import { user, account } from "./db/schema.js";

export async function provisionUser(
  email: string,
  password: string,
  name: string,
) {
  email = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("Enter a valid email address.");
  if (password.length < 12 || password.length > 128)
    throw new Error("Use a password with 12–128 characters.");
  if (!name.trim()) throw new Error("A name is required.");
  const id = randomUUID();
  const passwordHash = await hashPassword(password);
  await db.transaction(async (tx) => {
    await tx.insert(user).values({ id, email, name: name.trim() });
    await tx
      .insert(account)
      .values({
        id: randomUUID(),
        accountId: id,
        providerId: "credential",
        userId: id,
        password: passwordHash,
      });
  });
  return id;
}
