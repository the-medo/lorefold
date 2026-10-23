import { test } from "node:test";
import assert from "node:assert/strict";
import type { Entity, Relationship } from "../shared/contracts.js";
import { layoutGraph } from "../frontend/src/graph-layout.js";

const entities: Entity[] = Array.from({ length: 12 }, (_, i) => ({
  id: `entity-${i}`, label: `Entity ${i}`, kind: "character", aliases: [], facts: [],
}));
const edge = (source: string, target: string): Relationship => ({
  id: `${source}-${target}`, source, target, label: "knows", chapter: 1,
  evidence: { id: "evidence", chapter: 1, quote: "Synthetic test." },
});
const relationships = entities.slice(1).map((e) => edge(entities[0].id, e.id));

test("3D layout is finite and repeatable across response ordering", () => {
  const original = structuredClone({ entities, relationships });
  const positions = layoutGraph(entities, relationships);
  assert.deepEqual(positions, layoutGraph([...entities].reverse(), [...relationships].reverse()));
  assert.deepEqual({ entities, relationships }, original);
  assert.equal(positions.size, entities.length);
  for (const p of positions.values()) assert.ok(Object.values(p).every(Number.isFinite));
  for (const axis of ["x", "y", "z"] as const) {
    const values = [...positions.values()].map((p) => p[axis]);
    assert.ok(Math.max(...values) - Math.min(...values) > 1);
    assert.ok(Math.abs(values.reduce((sum, value) => sum + value, 0)) < 1e-8);
  }
});

test("filtered graphs never create or attract hidden endpoints", () => {
  const visible = entities.slice(0, 3);
  const knownEdges = [edge(visible[0].id, visible[1].id)];
  const positions = layoutGraph(visible, knownEdges);
  assert.deepEqual(positions, layoutGraph(visible, [...knownEdges, edge(visible[0].id, "hidden"), edge("hidden", visible[1].id)]));
  assert.equal(positions.has("hidden"), false);
  assert.deepEqual(layoutGraph([], relationships), new Map());
  assert.deepEqual(layoutGraph([entities[0]], relationships), new Map([[entities[0].id, { x: 0, y: 0, z: 0 }]]));
});
