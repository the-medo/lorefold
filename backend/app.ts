import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { auth, signInProviders, trustedOrigins } from "./auth.js";
import { getWorkspace, listBooks, saveProgress } from "./library.js";
import { pool } from "./db/client.js";
import { assignTheme, deleteTheme, saveTheme, themeLibrary } from "./themes.js";
import { attachBook, createUniverse, downloadResource, listUniverses, MAX_UPLOAD_SIZE, requireUniverse, textField, universeWorkspace, uploadResource } from "./universes.js";

export const app = new Hono<{ Variables: { userId: string } }>();
app.use("*", secureHeaders());
app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
const smallBody = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Request is too large." }, 413) });
app.use("/api/*", (c, next) =>
  c.req.method === "POST" && /^\/api\/universes\/[^/]+\/resources$/.test(c.req.path)
    ? next() : smallBody(c, next),
);
app.get("/api/health", async (c) => {
  await pool.query("select 1");
  return c.json({ status: "ok" });
});
app.get("/api/auth/providers", (c) => c.json(signInProviders));
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.use("/api/*", async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Sign in to open your library." }, 401);
  if (
    !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
    !trustedOrigins.includes(c.req.header("origin") ?? "")
  ) {
    return c.json({ error: "Request origin is not allowed." }, 403);
  }
  c.set("userId", session.user.id);
  await next();
});
app.get("/api/books", async (c) =>
  c.json({ books: await listBooks(c.get("userId")) }),
);
async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HTTPException(400, { message: "Send a JSON object." });
  }
}
app.get("/api/themes", async (c) => c.json(await themeLibrary(c.get("userId"), c.req.query("universeId"), c.req.query("bookId"))));
app.post("/api/themes", async (c) => c.json({ theme: await saveTheme(c.get("userId"), await jsonObject(c.req.raw)) }, 201));
app.put("/api/themes/:id", async (c) => c.json({ theme: await saveTheme(c.get("userId"), await jsonObject(c.req.raw), c.req.param("id")) }));
app.delete("/api/themes/:id", async (c) => {
  await deleteTheme(c.get("userId"), c.req.param("id"));
  return c.json({ deleted: true });
});
app.put("/api/preferences/theme", async (c) => {
  await assignTheme(c.get("userId"), await jsonObject(c.req.raw));
  return c.json({ saved: true });
});
app.put("/api/universes/:id/theme", async (c) => {
  await assignTheme(c.get("userId"), await jsonObject(c.req.raw), c.req.param("id"));
  return c.json({ saved: true });
});
app.get("/api/universes", async (c) => c.json({ universes: await listUniverses(c.get("userId")) }));
app.post("/api/universes", async (c) => c.json({
  universe: await createUniverse(c.get("userId"), await jsonObject(c.req.raw)),
}, 201));
app.get("/api/universes/:id", async (c) => c.json(await universeWorkspace(c.get("userId"), c.req.param("id"))));
app.post("/api/universes/:id/books", async (c) => {
  const body = await jsonObject(c.req.raw);
  await attachBook(c.get("userId"), c.req.param("id"), textField(body.bookId, "Book ID", 200));
  return c.json({ added: true });
});
app.post("/api/universes/:id/resources",
  bodyLimit({ maxSize: MAX_UPLOAD_SIZE + 64 * 1024, onError: (c) => c.json({ error: "Files can be up to 25 MB." }, 413) }),
  async (c) => {
    await requireUniverse(c.get("userId"), c.req.param("id"));
    let form: FormData;
    try { form = await c.req.raw.formData(); }
    catch { throw new HTTPException(400, { message: "Send a file using multipart form data." }); }
    return c.json({ resource: await uploadResource(c.get("userId"), c.req.param("id"), form) }, 201);
  },
);
app.get("/api/resources/:id/download", async (c) => {
  const { resource, bytes } = await downloadResource(c.get("userId"), c.req.param("id"));
  return new Response(new Uint8Array(bytes), { headers: {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(resource.filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
    "Content-Length": String(bytes.length), "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox",
  } });
});
app.get("/api/books/:id/workspace", async (c) => {
  const rawChapter = c.req.query("chapter");
  if (
    rawChapter !== undefined &&
    (!/^\d+$/.test(rawChapter) || !Number.isSafeInteger(Number(rawChapter)))
  ) {
    return c.json({ error: "Chapter must be a nonnegative integer." }, 400);
  }
  const mode = c.req.query("mode") ?? "story";
  if (mode !== "chapter" && mode !== "story")
    return c.json({ error: "Unknown graph mode." }, 400);
  const workspace = await getWorkspace(
    c.get("userId"),
    c.req.param("id"),
    rawChapter === undefined ? undefined : Number(rawChapter),
    mode,
  );
  return workspace
    ? c.json(workspace)
    : c.json({ error: "Book not found." }, 404);
});
app.patch("/api/books/:id/progress", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Send a JSON progress value." }, 400);
  }
  const completedChapter = (body as { completedChapter?: unknown } | null)
    ?.completedChapter;
  if (
    typeof completedChapter !== "number" ||
    !Number.isSafeInteger(completedChapter)
  ) {
    return c.json({ error: "Completed chapter must be an integer." }, 400);
  }
  const result = await saveProgress(
    c.get("userId"),
    c.req.param("id"),
    completedChapter,
  );
  if (result === "missing") return c.json({ error: "Book not found." }, 404);
  if (result === "invalid")
    return c.json(
      { error: "Choose a chapter in this book, or zero for not started." },
      400,
    );
  return c.json({ completedChapter });
});
app.all("/api/*", (c) => c.json({ error: "API route not found." }, 404));
app.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  // Avoid logging source text, credentials, or database connection strings.
  console.error("Request failed:", c.req.method, c.req.path);
  return c.json({ error: "Something went wrong. Please try again." }, 500);
});
