import { lazy, Suspense, useMemo, useState } from "react";
import { BookOpen, ChevronRight, FileText, Network, Search } from "lucide-react";
import type { EntityKind, UniverseWorkspace } from "../../shared/contracts.js";
import { EntityDetails } from "./EntityDetails.js";
import { GraphBoundary } from "./GraphBoundary.js";
import { entityColors } from "./graph-theme.js";

const StoryGraph = lazy(() => import("./Graph.js").then((module) => ({ default: module.StoryGraph })));
const kinds = { all: "All", character: "Characters", location: "Locations", faction: "Factions", object: "Objects" } as const;

export function UniverseMap({ data }: { data: UniverseWorkspace }) {
  const preferenceKey = `lorefold:universe-map:${data.universe.id}:excluded`;
  const [excluded, setExcluded] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(preferenceKey) ?? "[]");
      return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
    } catch { return []; }
  });
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<EntityKind | "all">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const sources = [
    ...data.books.map((book) => ({
      id: `book:${book.id}`, title: book.title, kind: "book" as const,
      status: !book.totalChapters
        ? book.resourceId ? "Uploaded · awaiting extraction" : "No chapters yet"
        : !book.completedChapter ? `No finished chapters · ${book.totalChapters} chapters`
        : `Through chapter ${Math.min(book.completedChapter, book.totalChapters)} of ${book.totalChapters}`,
    })),
    ...data.resources.filter((resource) => resource.kind === "document").map((resource) => ({
      id: `document:${resource.id}`, title: resource.title, kind: "document" as const,
      status: "Reference document · awaiting analysis",
    })),
  ];
  const includedCount = sources.filter((source) => !excluded.includes(source.id)).length;
  function changeSources(next: string[]) {
    setSelected(null);
    setExcluded(next);
    // These are view preferences only; progress and universe membership never change.
    try { localStorage.setItem(preferenceKey, JSON.stringify(next)); } catch { /* Storage may be disabled. */ }
  }
  const includedGraph = useMemo(() => {
    const entities = data.graph.entities.filter((entity) => !excluded.includes(`book:${entity.bookId}`));
    const ids = new Set(entities.map((entity) => entity.id));
    return { entities, relationships: data.graph.relationships.filter((edge) => ids.has(edge.source) && ids.has(edge.target)) };
  }, [data.graph, excluded]);
  const visible = useMemo(() => {
    const entities = includedGraph.entities.filter((entity) =>
      (kind === "all" || entity.kind === kind) &&
      `${entity.label} ${entity.aliases.join(" ")}`.toLowerCase().includes(search.toLowerCase()));
    const ids = new Set(entities.map((entity) => entity.id));
    return { entities, relationships: includedGraph.relationships.filter((edge) => ids.has(edge.source) && ids.has(edge.target)) };
  }, [includedGraph, kind, search]);
  const entity = visible.entities.find((item) => item.id === selected);
  const book = data.books.find((item) => item.id === entity?.bookId);
  const titleFor = (bookId: string) => data.books.find((item) => item.id === bookId)?.title;
  const emptyMessage = !sources.length ? "Add books or sources to start exploring this universe."
    : !includedCount ? "No sources selected. Select a book or source to include it in the map."
    : !includedGraph.entities.length ? "No knowledge to map yet. Finish chapters in a book to reveal its story. Uploaded sources will contribute after extraction and analysis are available."
    : "No matches. Try another search or entity type.";

  return <section className="universe-map" aria-label="Universe map">
    <div className="universe-map-layout">
      <fieldset className="map-sources">
        <legend>Included sources</legend>
        <div className="map-source-actions"><button className="inline-link" disabled={!sources.length || includedCount === sources.length} onClick={() => changeSources([])}>Select all</button>
          <button className="inline-link" disabled={!includedCount} onClick={() => changeSources(sources.map((source) => source.id))}>Deselect all</button></div>
        {sources.map((source) => <label className="map-source" key={source.id}>
          <input type="checkbox" aria-label={`Include ${source.title}`} checked={!excluded.includes(source.id)}
            onChange={(event) => changeSources(event.target.checked ? excluded.filter((id) => id !== source.id) : [...excluded, source.id])} />
          {source.kind === "book" ? <BookOpen size={16} /> : <FileText size={16} />}
          <span><strong>{source.title}</strong><small>{source.status}</small></span>
        </label>)}
        <p className="map-source-note">{includedCount} of {sources.length} selected · Saved in this browser</p>
        {sources.some((source) => source.kind === "document") && <p className="map-source-note">Reference documents have no analyzed knowledge yet.</p>}
      </fieldset>
      <div className="universe-map-content">
        <label className="search"><Search size={16} /><input aria-label="Search universe map" placeholder="Find someone or somewhere…" value={search}
          onChange={(event) => { setSelected(null); setSearch(event.target.value); }} /></label>
        <div className="entity-filters" aria-label="Universe entity type">
          {(Object.keys(kinds) as (keyof typeof kinds)[]).map((value) => <button key={value} aria-pressed={kind === value} className={kind === value ? "active" : ""}
            onClick={() => { setSelected(null); setKind(value); }}>
            {value !== "all" && <i style={{ background: entityColors[value] }} />}{kinds[value]}</button>)}
        </div>
        {visible.entities.length ? <GraphBoundary><Suspense fallback={<div className="graph-wrap loading" role="status">Opening the 3D map…</div>}>
          <StoryGraph entities={visible.entities} relationships={visible.relationships} selectedId={entity?.id ?? null} onSelect={setSelected} />
        </Suspense></GraphBoundary> : <div className="graph-wrap universe-map-empty"><Network size={32} /><p>{emptyMessage}</p></div>}
        <div className="graph-caption"><span>{visible.entities.length} entities · {visible.relationships.length} connections</span><span>Select a node to see its sources</span></div>
        <div className="entity-list" aria-label="Universe map entities">
          {visible.entities.map((item) => <button key={item.id} aria-pressed={item.id === entity?.id} className={item.id === entity?.id ? "active" : ""} onClick={() => setSelected(item.id)}>
            <i style={{ background: entityColors[item.kind] }} /><span>{item.label}<small>{titleFor(item.bookId)}</small></span><ChevronRight size={13} />
          </button>)}
        </div>
        {entity && book && <EntityDetails entity={entity} graph={includedGraph} cutoff={Math.min(book.completedChapter, book.totalChapters)} sourceTitle={book.title} close={() => setSelected(null)} />}
      </div>
    </div>
  </section>;
}
