import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is required. Use the worktree run command.");
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});
export const db = drizzle(pool, { schema });
