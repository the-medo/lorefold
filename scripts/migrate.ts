import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "../backend/db/client.js";

try {
  await migrate(db, {
    migrationsFolder: new URL("../migrations", import.meta.url).pathname,
  });
  console.log("Database migrations applied.");
} finally {
  await pool.end();
}
