import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { app } from "./app.js";
import { pool } from "./db/client.js";
import { chatgptConnections } from "./ai.js";
import { fileURLToPath } from "node:url";

// Works from both backend/index.ts and dist/server/backend/index.js.
const clientRoot = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts") ? "../dist/client/" : "../../client/",
    import.meta.url,
  ),
);
app.get("*", serveStatic({ root: clientRoot }));
app.get("*", serveStatic({ path: `${clientRoot}/index.html` }));
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid PORT.");
const server = serve({ fetch: app.fetch, port, hostname }, () =>
  console.log(`Lorefold API: http://${hostname}:${port}`),
);
server.on("error", (error) => {
  console.error(`API failed to listen: ${error.message}`);
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    // Abort a login even while its HTTP start request is waiting for discovery.
    const connectionsClosed = chatgptConnections.close();
    server.close(() => {
      void connectionsClosed.then(() => pool.end()).then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 5000).unref();
  });
