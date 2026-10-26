import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db } from "./db/client.js";
import * as s from "./db/schema.js";
import { isThemeConfig, type ThemeLibrary } from "../shared/themes.js";
import { textField } from "./universes.js";

const selection = { id: s.themes.id, name: s.themes.name, config: s.themes.config };
const themeOwner = (ownerId: string, id: string) => and(eq(s.themes.ownerId, ownerId), eq(s.themes.id, id));

export async function themeLibrary(ownerId: string, universeId?: string, bookId?: string): Promise<ThemeLibrary> {
  if (universeId !== undefined && bookId !== undefined) throw new HTTPException(400, { message: "Choose one theme context." });
  return db.transaction(async (tx) => {
    let contextUniverseId: string | null = null;
    if (bookId !== undefined) {
      const [book] = await tx.select({ universeId: s.books.universeId }).from(s.books)
        .where(and(eq(s.books.id, bookId), eq(s.books.ownerId, ownerId)));
      if (!book) throw new HTTPException(404, { message: "Book not found." });
      contextUniverseId = book.universeId;
    } else if (universeId !== undefined) {
      const [universe] = await tx.select({ id: s.universes.id }).from(s.universes)
        .where(and(eq(s.universes.id, universeId), eq(s.universes.ownerId, ownerId)));
      if (!universe) throw new HTTPException(404, { message: "Universe not found." });
      contextUniverseId = universe.id;
    }
    const themes = await tx.select(selection).from(s.themes).where(eq(s.themes.ownerId, ownerId))
      .orderBy(asc(s.themes.createdAt), asc(s.themes.id));
    const [preference] = await tx.select().from(s.userThemePreferences).where(eq(s.userThemePreferences.userId, ownerId));
    const universeThemes = await tx.select({ universeId: s.universeThemePreferences.universeId, themeId: s.universeThemePreferences.themeId })
      .from(s.universeThemePreferences).where(eq(s.universeThemePreferences.ownerId, ownerId));
    return { themes, defaultThemeId: preference?.themeId ?? null, universeThemes, contextUniverseId };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
export async function saveTheme(ownerId: string, body: Record<string, unknown>, id?: string) {
  const name = textField(body.name, "Theme name", 80);
  if (!isThemeConfig(body.config)) throw new HTTPException(400, { message: "Choose valid theme colors, fonts, and sizes." });
  if (Object.keys(body).some((key) => key !== "name" && key !== "config"))
    throw new HTTPException(400, { message: "Send only the theme name and settings." });
  if (id) {
    const [theme] = await db.update(s.themes).set({ name, config: body.config, updatedAt: new Date() })
      .where(themeOwner(ownerId, id)).returning(selection);
    if (!theme) throw new HTTPException(404, { message: "Theme not found." });
    return theme;
  }
  const [theme] = await db.insert(s.themes).values({ id: randomUUID(), ownerId, name, config: body.config }).returning(selection);
  return theme;
}
export async function deleteTheme(ownerId: string, id: string) {
  const deleted = await db.delete(s.themes).where(themeOwner(ownerId, id)).returning({ id: s.themes.id });
  if (!deleted.length) throw new HTTPException(404, { message: "Theme not found." });
}
export async function assignTheme(ownerId: string, body: Record<string, unknown>, universeId?: string) {
  if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "themeId") ||
      (body.themeId !== null && (typeof body.themeId !== "string" || !body.themeId || body.themeId.length > 200)))
    throw new HTTPException(400, { message: "Choose a saved theme, or null to use the default." });
  const themeId = body.themeId as string | null;
  await db.transaction(async (tx) => {
    if (universeId !== undefined) {
      const [universe] = await tx.select({ id: s.universes.id }).from(s.universes)
        .where(and(eq(s.universes.id, universeId), eq(s.universes.ownerId, ownerId))).for("key share");
      if (!universe) throw new HTTPException(404, { message: "Universe not found." });
    }
    if (themeId !== null) {
      const [theme] = await tx.select({ id: s.themes.id }).from(s.themes).where(themeOwner(ownerId, themeId)).for("key share");
      if (!theme) throw new HTTPException(404, { message: "Theme not found." });
    }
    if (universeId !== undefined) {
      if (themeId === null) await tx.delete(s.universeThemePreferences).where(and(eq(s.universeThemePreferences.universeId, universeId), eq(s.universeThemePreferences.ownerId, ownerId)));
      else await tx.insert(s.universeThemePreferences).values({ universeId, ownerId, themeId })
        .onConflictDoUpdate({ target: s.universeThemePreferences.universeId, set: { themeId } });
    } else {
      if (themeId === null) await tx.delete(s.userThemePreferences).where(eq(s.userThemePreferences.userId, ownerId));
      else await tx.insert(s.userThemePreferences).values({ userId: ownerId, themeId })
        .onConflictDoUpdate({ target: s.userThemePreferences.userId, set: { themeId } });
    }
  });
}
