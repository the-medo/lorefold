import { eq } from "drizzle-orm";
import { db, pool } from "../backend/db/client.js";
import { user } from "../backend/db/schema.js";
import { seedSample } from "../backend/db/sample.js";

try {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) throw new Error("Usage: npm run db:seed -- your@email.example");
  const [owner] = await db.select().from(user).where(eq(user.email, email));
  if (!owner)
    throw new Error(
      "Create the private account first with npm run user:create.",
    );
  await seedSample(owner.id);
  console.log("Sample book is ready. Existing progress has been preserved.");
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
