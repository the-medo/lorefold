export type EntityKind = "character" | "location" | "faction" | "object";
export type GraphMode = "chapter" | "story";
export type Evidence = { id: string; chapter: number; quote: string; sourceTitle?: string };
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
export type Graph = { entities: Entity[]; relationships: Relationship[] };
export type UniverseGraph = {
  entities: (Entity & { bookId: string })[];
  relationships: (Relationship & { bookId: string })[];
  matches?: { source: string; target: string }[];
};
export type Book = {
  import?: import("./imports.js").ImportProgress | null;
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
  graph: UniverseGraph;
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
    recapEvidence?: { text: string; evidence: { chapter: number; quote: string }[] }[];
  } | null;
  graph: Graph;
};
