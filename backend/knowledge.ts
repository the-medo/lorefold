import { and, asc, eq, lte } from "drizzle-orm";
import type { db } from "./db/client.js";
import * as s from "./db/schema.js";
import type { Entity, Graph, GraphMode } from "../shared/contracts.js";

export type KnowledgeReader = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Call only after authorizing the book and deriving its cutoff in the same snapshot.
export async function readGraph(tx: KnowledgeReader, bookId: string, cutoff: number, mode: GraphMode): Promise<Graph> {
  if (cutoff === 0) return { entities: [], relationships: [] };
  const visibleFacts = await tx
    .select({
      entityId: s.facts.entityId,
      kind: s.entities.kind,
      factKind: s.facts.kind,
      value: s.facts.value,
      chapter: s.facts.revealChapter,
      evidence: {
        id: s.evidence.id,
        chapter: s.evidence.chapter,
        quote: s.evidence.quote,
      },
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
        lte(s.facts.revealChapter, cutoff),
        lte(s.evidence.chapter, cutoff),
      ),
    )
    .orderBy(asc(s.facts.revealChapter), asc(s.facts.id));
  const present =
    mode === "chapter"
      ? new Set(
          (
            await tx
              .select({ id: s.appearances.entityId })
              .from(s.appearances)
              .where(
                and(
                  eq(s.appearances.bookId, bookId),
                  eq(s.appearances.chapter, cutoff),
                ),
              )
          ).map((e) => e.id),
        )
      : null;
  const nodes = new Map<string, Entity>();
  for (const fact of visibleFacts) {
    if (present && !present.has(fact.entityId)) continue;
    const node = nodes.get(fact.entityId) ?? {
      id: fact.entityId,
      kind: fact.kind,
      label: "",
      aliases: [],
      facts: [],
    };
    if (fact.factKind === "label") node.label = fact.value;
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
        lte(s.relationships.revealChapter, cutoff),
        lte(s.evidence.chapter, cutoff),
        mode === "chapter" ? eq(s.evidence.chapter, cutoff) : undefined,
      ),
    )
    .orderBy(asc(s.relationships.id));
  return {
    entities: [...nodes.values()],
    relationships: edges.filter((edge) => nodes.has(edge.source) && nodes.has(edge.target)),
  };
}
