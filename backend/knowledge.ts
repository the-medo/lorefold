import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { db } from "./db/client.js";
import * as s from "./db/schema.js";
import type { Entity, GraphMode } from "../shared/contracts.js";

export type KnowledgeReader = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Both the reader and the private maintenance CLI use validated chapter knowledge.
export function readVisibleFacts(tx: KnowledgeReader, bookId: string, cutoff?: number) {
  return tx.select({
    id: s.facts.id,
    entityId: s.facts.entityId,
    kind: s.entities.kind,
    factKind: s.facts.kind,
    value: s.facts.value,
    chapter: s.facts.revealChapter,
    evidence: { id: s.evidence.id, chapter: s.evidence.chapter, quote: s.evidence.quote },
  })
    .from(s.facts)
    .innerJoin(
      s.entities,
      and(
        eq(s.entities.bookId, s.facts.bookId),
        eq(s.entities.id, s.facts.entityId),
      ),
    )
    .innerJoin(
      s.evidence,
      and(
        eq(s.evidence.bookId, s.facts.bookId),
        eq(s.evidence.id, s.facts.evidenceId),
      ),
    )
    .where(
      and(
        eq(s.facts.bookId, bookId),
        sql`exists (select 1 from chapters c where c.book_id = ${s.facts.bookId} and c.number = ${s.facts.revealChapter} and c.analyzed)`,
        sql`exists (select 1 from chapters c where c.book_id = ${s.evidence.bookId} and c.number = ${s.evidence.chapter} and c.analyzed)`,
        cutoff === undefined ? undefined : lte(s.facts.revealChapter, cutoff),
        cutoff === undefined ? undefined : lte(s.evidence.chapter, cutoff),
      ),
    )
    .orderBy(asc(s.facts.revealChapter), asc(s.facts.id));
}
export type VisibleFact = Awaited<ReturnType<typeof readVisibleFacts>>[number];
export function readPointMerges(tx: KnowledgeReader, bookId: string) {
  return tx.select().from(s.pointMerges).where(eq(s.pointMerges.bookId, bookId));
}

// Only join endpoints whose names AND cited facts are visible in this snapshot.
export function mergedEntityIds(facts: VisibleFact[], links: { firstFactId: string; secondFactId: string }[]) {
  const parents = new Map<string, string>();
  if (!links.length) return parents;
  const byId = new Map(facts.map(f => [f.id, f]));
  const named = new Set(facts.filter(f => f.factKind === "label").map(f => f.entityId));
  function root(id: string) {
    let next;
    while ((next = parents.get(id)) !== undefined) id = next;
    return id;
  }
  for (const link of links) {
    const left = byId.get(link.firstFactId), right = byId.get(link.secondFactId);
    if (!left || !right || left.kind !== right.kind || !named.has(left.entityId) || !named.has(right.entityId)) continue;
    const a = root(left.entityId), b = root(right.entityId);
    if (a !== b) parents.set(a < b ? b : a, a < b ? a : b);
  }
  for (const id of parents.keys()) parents.set(id, root(id));
  return parents;
}

// Call only after authorizing the book and deriving its cutoff in the same snapshot.
export async function readGraph(tx: KnowledgeReader, bookId: string, cutoff: number, mode: GraphMode) {
  if (cutoff === 0) return { graph: { entities: [], relationships: [] }, mergedIds: new Map<string, string>() };
  const visibleFacts = await readVisibleFacts(tx, bookId, cutoff);
  const mergedIds = mergedEntityIds(visibleFacts, await readPointMerges(tx, bookId));
  const canonical = (id: string) => mergedIds.get(id) ?? id;
  const mergedRoots = new Set(mergedIds.values());
  const present =
    mode === "chapter"
      ? new Set(
          (
            await tx
              .select({ id: s.appearances.entityId })
              .from(s.appearances)
              .innerJoin(s.chapters, and(eq(s.chapters.bookId, s.appearances.bookId), eq(s.chapters.number, s.appearances.chapter)))
              .where(
                and(
                  eq(s.appearances.bookId, bookId),
                  eq(s.appearances.chapter, cutoff),
                  eq(s.chapters.analyzed, true),
                ),
              )
          ).map((e) => canonical(e.id)),
        )
      : null;
  const nodes = new Map<string, Entity>();
  for (const fact of visibleFacts) {
    const id = canonical(fact.entityId);
    if (present && !present.has(id)) continue;
    const node: Entity = nodes.get(id) ?? {
      id,
      kind: fact.kind,
      label: "",
      aliases: [],
      facts: [],
    };
    if (fact.factKind === "label") {
      if (mergedRoots.has(id) && node.label && node.label !== fact.value) node.aliases.push(node.label);
      node.label = fact.value;
    }
    if (fact.factKind === "alias") node.aliases.push(fact.value);
    if (fact.factKind === "description")
      node.facts.push({
        value: fact.value,
        chapter: fact.chapter,
        evidence: fact.evidence,
      });
    nodes.set(node.id, node);
  }
  // An entity without a supported visible name must not escape through an edge or ID.
  for (const [id, node] of nodes) if (!node.label) nodes.delete(id);
  for (const id of mergedRoots) {
    const node = nodes.get(id);
    if (node) node.aliases = [...new Set(node.aliases)].filter(name => name !== node.label);
  }
  const edges = await tx
    .select({
      id: s.relationships.id,
      source: s.relationships.sourceId,
      target: s.relationships.targetId,
      label: s.relationships.label,
      chapter: s.relationships.revealChapter,
      evidence: {
        id: s.evidence.id,
        chapter: s.evidence.chapter,
        quote: s.evidence.quote,
      },
    })
    .from(s.relationships)
    .innerJoin(
      s.evidence,
      and(
        eq(s.evidence.bookId, s.relationships.bookId),
        eq(s.evidence.id, s.relationships.evidenceId),
      ),
    )
    .where(
      and(
        eq(s.relationships.bookId, bookId),
        sql`exists (select 1 from chapters c where c.book_id = ${s.relationships.bookId} and c.number = ${s.relationships.revealChapter} and c.analyzed)`,
        sql`exists (select 1 from chapters c where c.book_id = ${s.evidence.bookId} and c.number = ${s.evidence.chapter} and c.analyzed)`,
        lte(s.relationships.revealChapter, cutoff),
        lte(s.evidence.chapter, cutoff),
        mode === "chapter" ? eq(s.evidence.chapter, cutoff) : undefined,
      ),
    )
    .orderBy(asc(s.relationships.id));
  return {
    mergedIds,
    graph: {
      entities: [...nodes.values()],
      relationships: edges.flatMap(edge => {
        const source = canonical(edge.source), target = canonical(edge.target);
        if (!nodes.has(source) || !nodes.has(target) || (source === target && edge.source !== edge.target)) return [];
        return [{ ...edge, source, target }];
      }),
    },
  };
}
