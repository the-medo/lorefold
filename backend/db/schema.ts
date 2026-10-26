import { sql } from "drizzle-orm";
import type { ThemeConfig } from "../../shared/themes.js";
import type { AnalysisPreference } from "../../shared/ai.js";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  primaryKey,
  uniqueIndex,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const user = pgTable("app_user", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
export const session = pgTable("auth_session", {
  id: text().primaryKey(),
  token: text().notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});
export const account = pgTable(
  "auth_account",
  {
    id: text().primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text(),
    password: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("account_provider_identity").on(t.providerId, t.accountId),
  ],
);
export const verification = pgTable("auth_verification", {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const userAiPreferences = pgTable("user_ai_preferences", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  model: text().$type<AnalysisPreference["model"]>().notNull().default("gpt-6-astra"),
  effort: text().$type<AnalysisPreference["effort"]>().notNull().default("high"),
}, (t) => [
  check("analysis_model", sql`${t.model} in ('gpt-6-astra', 'gpt-6.1-sol')`),
  check("analysis_effort", sql`${t.effort} in ('medium', 'high', 'xhigh')`),
]);

export const universes = pgTable("universes", {
  id: text().primaryKey(),
  ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  name: text().notNull(),
  description: text().notNull().default(""),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("universe_owner_identity").on(t.id, t.ownerId)]);

export const themes = pgTable("themes", {
  id: text().primaryKey(),
  ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  name: text().notNull(),
  config: jsonb().$type<ThemeConfig>().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("theme_owner_identity").on(t.id, t.ownerId)]);

// A missing assignment means inheritance. Cascades remove assignments when a
// theme is deleted, without deleting users/universes or nulling their owner IDs.
export const userThemePreferences = pgTable("user_theme_preferences", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  themeId: text("theme_id").notNull(),
}, (t) => [foreignKey({ columns: [t.themeId, t.userId], foreignColumns: [themes.id, themes.ownerId] }).onDelete("cascade")]);

export const universeThemePreferences = pgTable("universe_theme_preferences", {
  universeId: text("universe_id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  themeId: text("theme_id").notNull(),
}, (t) => [
  foreignKey({ columns: [t.universeId, t.ownerId], foreignColumns: [universes.id, universes.ownerId] }).onDelete("cascade"),
  foreignKey({ columns: [t.themeId, t.ownerId], foreignColumns: [themes.id, themes.ownerId] }).onDelete("cascade"),
]);

export const books = pgTable("books", {
  id: text().primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  title: text().notNull(),
  author: text().notNull(),
  description: text().notNull(),
  universeId: text("universe_id"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("book_universe_owner_identity").on(t.id, t.universeId, t.ownerId),
  foreignKey({ columns: [t.universeId, t.ownerId], foreignColumns: [universes.id, universes.ownerId] }),
]);

export const resources = pgTable("resources", {
  id: text().primaryKey(),
  ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  universeId: text("universe_id").notNull(),
  bookId: text("book_id").unique(),
  title: text().notNull(),
  kind: text({ enum: ["book", "document"] }).notNull(),
  storageKey: text("storage_key").notNull().unique(),
  filename: text().notNull(),
  byteSize: integer("byte_size").notNull(),
  createdAt: createdAt(),
}, (t) => [
  foreignKey({ columns: [t.universeId, t.ownerId], foreignColumns: [universes.id, universes.ownerId] }).onDelete("cascade"),
  foreignKey({ columns: [t.bookId, t.universeId, t.ownerId], foreignColumns: [books.id, books.universeId, books.ownerId] }).onDelete("cascade"),
  check("resource_kind", sql`${t.kind} in ('book', 'document')`),
  check("resource_book_kind", sql`(${t.kind} = 'book') = (${t.bookId} is not null)`),
  check("resource_size", sql`${t.byteSize} > 0 and ${t.byteSize} <= 26214400`),
]);
export const chapters = pgTable(
  "chapters",
  {
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    number: integer().notNull(),
    title: text().notNull(),
    text: text().notNull(),
    recap: text().notNull(),
    developments: jsonb().$type<string[]>().notNull(),
    analyzed: boolean().notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.number] }),
    check("chapter_positive", sql`${t.number} > 0`),
  ],
);
export const progress = pgTable(
  "reader_progress",
  {
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    completedChapter: integer("completed_chapter").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.userId] }),
    check("progress_nonnegative", sql`${t.completedChapter} >= 0`),
  ],
);
export const entities = pgTable(
  "entities",
  {
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    id: text().notNull(),
    kind: text({
      enum: ["character", "location", "faction", "object"],
    }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.id] })],
);
export const evidence = pgTable(
  "evidence",
  {
    bookId: text("book_id").notNull(),
    id: text().notNull(),
    chapter: integer().notNull(),
    quote: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.id] }),
    foreignKey({
      columns: [t.bookId, t.chapter],
      foreignColumns: [chapters.bookId, chapters.number],
    }).onDelete("cascade"),
  ],
);
export const facts = pgTable(
  "entity_facts",
  {
    bookId: text("book_id").notNull(),
    id: text().notNull(),
    entityId: text("entity_id").notNull(),
    kind: text({ enum: ["label", "description", "alias"] }).notNull(),
    value: text().notNull(),
    revealChapter: integer("reveal_chapter").notNull(),
    evidenceId: text("evidence_id").notNull(),
    extractionVersion: text("extraction_version")
      .notNull()
      .default("synthetic-v1"),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.id] }),
    foreignKey({
      columns: [t.bookId, t.entityId],
      foreignColumns: [entities.bookId, entities.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.bookId, t.evidenceId],
      foreignColumns: [evidence.bookId, evidence.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.bookId, t.revealChapter],
      foreignColumns: [chapters.bookId, chapters.number],
    }).onDelete("cascade"),
  ],
);
export const appearances = pgTable(
  "entity_appearances",
  {
    bookId: text("book_id").notNull(),
    entityId: text("entity_id").notNull(),
    chapter: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.entityId, t.chapter] }),
    foreignKey({
      columns: [t.bookId, t.entityId],
      foreignColumns: [entities.bookId, entities.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.bookId, t.chapter],
      foreignColumns: [chapters.bookId, chapters.number],
    }).onDelete("cascade"),
  ],
);
export const relationships = pgTable(
  "relationships",
  {
    bookId: text("book_id").notNull(),
    id: text().notNull(),
    sourceId: text("source_id").notNull(),
    targetId: text("target_id").notNull(),
    label: text().notNull(),
    revealChapter: integer("reveal_chapter").notNull(),
    evidenceId: text("evidence_id").notNull(),
    extractionVersion: text("extraction_version")
      .notNull()
      .default("synthetic-v1"),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.id] }),
    foreignKey({
      columns: [t.bookId, t.sourceId],
      foreignColumns: [entities.bookId, entities.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.bookId, t.targetId],
      foreignColumns: [entities.bookId, entities.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.bookId, t.evidenceId],
      foreignColumns: [evidence.bookId, evidence.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.bookId, t.revealChapter],
      foreignColumns: [chapters.bookId, chapters.number],
    }).onDelete("cascade"),
  ],
);
