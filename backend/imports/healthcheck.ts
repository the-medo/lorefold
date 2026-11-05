import pg from "pg";

// A short, read-only probe; never claim jobs or require web/auth configuration.
let client: pg.Client | undefined;
try {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Database configuration is missing.");
  client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 1500,
    query_timeout: 1500,
    statement_timeout: 1500,
  });
  await client.connect();
  await client.query("SELECT 1");
} catch {
  // Connection errors can contain credentials; Docker persists this output.
  console.error("Import worker database health check failed.");
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => { process.exitCode = 1; });
}
