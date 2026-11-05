import type { UniverseGraph } from "./contracts.js";
// Apply source selection BEFORE combining identities, so excluded books cannot
// contribute facts, names, or a bridge that merges otherwise distinct nodes.
export function combineUniverseGraph(graph: UniverseGraph, excluded: string[] = []) {
  const entities = graph.entities.filter(e => !excluded.includes(`book:${e.bookId}`));
  const parent = new Map(entities.map(e => [e.id, e.id]));
  function root(id: string): string { let p = parent.get(id)!; while (p !== parent.get(p)) p = parent.get(p)!; return p; }
  for (const m of graph.matches ?? []) if (parent.has(m.source) && parent.has(m.target)) parent.set(root(m.target), root(m.source));
  const groups = new Map<string, typeof entities[number] & { bookIds: string[] }>();
  for (const e of entities) {
    const id = root(e.id), existing = groups.get(id);
    if (!existing) groups.set(id, { ...e, id, aliases: [...e.aliases], facts: [...e.facts], bookIds: [e.bookId] });
    else {
      existing.bookIds = [...new Set([...existing.bookIds, e.bookId])];
      existing.aliases = [...new Set([...existing.aliases, ...(e.label !== existing.label ? [e.label] : []), ...e.aliases])];
      existing.facts.push(...e.facts);
    }
  }
  return { entities: [...groups.values()], relationships: graph.relationships
    .filter(e => !excluded.includes(`book:${e.bookId}`) && parent.has(e.source) && parent.has(e.target))
    .map(e => ({ ...e, source: root(e.source), target: root(e.target) })) };
}
