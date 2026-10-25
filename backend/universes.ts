import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join, extname } from "node:path";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db } from "./db/client.js";
import * as s from "./db/schema.js";
import { listBooks } from "./library.js";
import { readGraph, type KnowledgeReader } from "./knowledge.js";
import type { Universe, Resource, UniverseWorkspace } from "../shared/contracts.js";

export const MAX_UPLOAD_SIZE = 25 * 1024 * 1024;
const universeSelection = {
  id: s.universes.id, name: s.universes.name, description: s.universes.description,
  // Keep the outer table qualified inside correlated subqueries. A single-table
  // Drizzle selection otherwise shortens its column to the inner table's "id".
  bookCount: sql<number>`(select count(*) from books where universe_id = universes.id)`.mapWith(Number),
  resourceCount: sql<number>`(select count(*) from resources where universe_id = universes.id and kind = 'document')`.mapWith(Number),
};
const resourceSelection = {
  id: s.resources.id, title: s.resources.title, kind: s.resources.kind,
  bookId: s.resources.bookId, filename: s.resources.filename, byteSize: s.resources.byteSize,
};

export function textField(value: unknown, name: string, max: number, required = true) {
  if (typeof value !== "string" || value.trim().length > max || (required && !value.trim()))
    throw new HTTPException(400, { message: `${name} must be ${required ? "1" : "0"}–${max} characters.` });
  return value.trim();
}
export function listUniverses(ownerId: string): Promise<Universe[]> {
  return db.select(universeSelection).from(s.universes)
    .where(eq(s.universes.ownerId, ownerId)).orderBy(asc(s.universes.createdAt), asc(s.universes.id));
}
export async function requireUniverse(ownerId: string, id: string, reader: typeof db | KnowledgeReader = db) {
  const [universe] = await reader.select(universeSelection).from(s.universes)
    .where(and(eq(s.universes.id, id), eq(s.universes.ownerId, ownerId)));
  if (!universe) throw new HTTPException(404, { message: "Universe not found." });
  return universe;
}
export async function createUniverse(ownerId: string, body: Record<string, unknown>) {
  const name = textField(body.name, "Universe name", 120);
  const description = textField(body.description ?? "", "Description", 2000, false);
  const id = randomUUID();
  await db.insert(s.universes).values({ id, ownerId, name, description });
  return requireUniverse(ownerId, id);
}
export async function universeWorkspace(ownerId: string, id: string): Promise<UniverseWorkspace> {
  // Membership, per-book progress, and knowledge must agree even during concurrent writes.
  return db.transaction(async (tx) => {
    const universe = await requireUniverse(ownerId, id, tx);
    const books = await listBooks(ownerId, id, tx);
    const resources = await tx.select(resourceSelection).from(s.resources)
      .where(and(eq(s.resources.universeId, id), eq(s.resources.ownerId, ownerId)))
      .orderBy(asc(s.resources.createdAt), asc(s.resources.id));
    const graph: UniverseWorkspace["graph"] = { entities: [], relationships: [] };
    for (const book of books) {
      const cutoff = Math.min(book.completedChapter, book.totalChapters);
      const source = await readGraph(tx, book.id, cutoff, "story");
      // IDs are local to a book. Never infer a shared identity from an ID or name.
      const scopedId = (localId: string) => JSON.stringify([book.id, localId]);
      graph.entities.push(...source.entities.map((entity) => ({
        ...entity, id: scopedId(entity.id), bookId: book.id,
        facts: entity.facts.map((fact) => ({ ...fact, evidence: { ...fact.evidence, id: scopedId(fact.evidence.id) } })),
      })));
      graph.relationships.push(...source.relationships.map((relationship) => ({
        ...relationship, id: scopedId(relationship.id), bookId: book.id,
        source: scopedId(relationship.source), target: scopedId(relationship.target),
        evidence: { ...relationship.evidence, id: scopedId(relationship.evidence.id) },
      })));
    }
    return { universe, books, resources, graph };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
export async function attachBook(ownerId: string, universeId: string, bookId: string) {
  await requireUniverse(ownerId, universeId);
  const [book] = await db.select().from(s.books)
    .where(and(eq(s.books.id, bookId), eq(s.books.ownerId, ownerId)));
  if (!book) throw new HTTPException(404, { message: "Book not found." });
  if (book.universeId === universeId) return;
  const updated = await db.update(s.books).set({ universeId })
    .where(and(eq(s.books.id, bookId), eq(s.books.ownerId, ownerId), isNull(s.books.universeId))).returning();
  if (!updated.length) throw new HTTPException(409, { message: "This book already belongs to a universe." });
}

function storagePath(key: string) {
  // This adapter is deliberately confined to the development worktree. Production
  // uses private R2; never silently write production uploads to an ephemeral disk.
  if (process.env.NODE_ENV !== "development" || !process.env.LOREFOLD_WORKTREE_ID || !process.env.LOREFOLD_LOCAL_STORAGE_DIR || (process.env.LOREFOLD_STORAGE_MODE ?? "local") !== "local")
    throw new HTTPException(503, { message: "File storage is not configured for this environment." });
  if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error("Invalid internal storage key");
  return join(process.env.LOREFOLD_LOCAL_STORAGE_DIR, "uploads", key);
}

export async function uploadResource(ownerId: string, universeId: string, form: FormData): Promise<Resource> {
  await requireUniverse(ownerId, universeId);
  const kind = form.get("kind");
  if (kind !== "book" && kind !== "document") throw new HTTPException(400, { message: "Choose a book or reference document." });
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) throw new HTTPException(400, { message: "Choose a nonempty file to upload." });
  if (file.size > MAX_UPLOAD_SIZE) throw new HTTPException(413, { message: "Files can be up to 25 MB." });
  const extension = extname(file.name).toLowerCase();
  if (![".epub", ".pdf", ".txt", ".md"].includes(extension) || (kind === "document" && extension === ".epub"))
    throw new HTTPException(400, { message: "Use EPUB, PDF, TXT, or Markdown for books; PDF, TXT, or Markdown for documents." });
  const title = textField(form.get("title"), "Title", 200);
  const author = textField(form.get("author") ?? "", "Author", 200, false);
  const filename = (file.name.split(/[\\/]/).pop() ?? "upload").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 180) || "upload";
  const id = randomUUID();
  const path = storagePath(id);
  const resource = { id, ownerId, universeId, kind: kind as Resource["kind"], title, filename, byteSize: file.size,
    storageKey: id, bookId: kind === "book" ? randomUUID() : null };
  const bytes = Buffer.from(await file.arrayBuffer());
  // Validate the basic container signature without parsing or extracting user files.
  if ((extension === ".pdf" && bytes.subarray(0, 5).toString() !== "%PDF-") ||
      (extension === ".epub" && !bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) ||
      ([".txt", ".md"].includes(extension) && bytes.includes(0)))
    throw new HTTPException(400, { message: "The file contents do not match the selected format." });
  await mkdir(join(process.env.LOREFOLD_LOCAL_STORAGE_DIR!, "uploads"), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.close();
    await db.transaction(async (tx) => {
      if (resource.bookId) await tx.insert(s.books).values({
        id: resource.bookId, ownerId, universeId, title, author: author || "Unknown author", description: "",
      });
      await tx.insert(s.resources).values(resource);
    });
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw error;
  }
  return { id, kind, title, filename, byteSize: file.size, bookId: resource.bookId };
}

export async function downloadResource(ownerId: string, id: string) {
  const [resource] = await db.select().from(s.resources)
    .where(and(eq(s.resources.id, id), eq(s.resources.ownerId, ownerId)));
  if (!resource) throw new HTTPException(404, { message: "Resource not found." });
  try {
    return { resource, bytes: await readFile(storagePath(resource.storageKey)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new HTTPException(404, { message: "The uploaded file is unavailable." });
    throw error;
  }
}
