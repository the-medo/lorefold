export type EntityKind = "character" | "location" | "faction" | "object";
export type GraphMode = "chapter" | "story";
export type Evidence = { id: string; chapter: number; quote: string };
export type Entity = {
  id: string;
  kind: EntityKind;
  label: string;
  aliases: string[];
  facts: { value: string; chapter: number; evidence: Evidence }[];
};
export type Relationship = {
  id: string;
  source: string;
  target: string;
  label: string;
  chapter: number;
  evidence: Evidence;
};
export type Book = {
  id: string;
  title: string;
  author: string;
  description: string;
  universeId: string | null;
  resourceId: string | null;
  totalChapters: number;
  analyzedChapters: number;
  completedChapter: number;
};
export type Universe = {
  id: string;
  name: string;
  description: string;
  bookCount: number;
  resourceCount: number;
};
export type Resource = {
  id: string;
  title: string;
  kind: "book" | "document";
  bookId: string | null;
  filename: string;
  byteSize: number;
};
export type UniverseWorkspace = {
  universe: Universe;
  books: Book[];
  resources: Resource[];
};
export type Workspace = {
  book: Book;
  cutoff: number;
  mode: GraphMode;
  chapters: { number: number; title: string | null; analyzed: boolean }[];
  chapter: {
    number: number;
    title: string;
    text: string;
    recap: string;
    developments: string[];
  } | null;
  graph: { entities: Entity[]; relationships: Relationship[] };
};
