import type { Entity, Relationship } from "../../shared/contracts.js";

export type Point3D = { x: number; y: number; z: number };

/** A deterministic spring layout computed only from the visible, authorized graph. */
export function layoutGraph(entities: Entity[], relationships: Relationship[]): Map<string, Point3D> {
  const nodes = [...entities].sort((a, b) => a.id.localeCompare(b.id));
  const count = nodes.length;
  if (!count) return new Map();
  if (count === 1) return new Map([[nodes[0].id, { x: 0, y: 0, z: 0 }]]);
  const indices = new Map(nodes.map((node, index) => [node.id, index]));
  const edges = [...relationships].sort((a, b) => a.id.localeCompare(b.id)).flatMap((edge) => {
    const source = indices.get(edge.source), target = indices.get(edge.target);
    return source !== undefined && target !== undefined && source !== target ? [[source, target]] : [];
  });
  // Seed connected nodes together around the rim. Visiting low-degree
  // neighbors first keeps short branches alongside their junction.
  const neighbors = nodes.map((): number[] => []);
  for (const [source, target] of edges) {
    neighbors[source].push(target);
    neighbors[target].push(source);
  }
  for (const list of neighbors) list.sort((a, b) => neighbors[b].length - neighbors[a].length || b - a);
  const points: Point3D[] = [];
  const radius = 40 * Math.sqrt(count);
  let next = 0;
  for (let root = 0; root < count; root++) {
    const stack = [root];
    while (stack.length) {
      const index = stack.pop()!;
      if (points[index]) continue;
      const angle = 2 * Math.PI * next++ / count;
      points[index] = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, z: Math.sin(index * 2.4 + 0.8) * 38 };
      for (const neighbor of neighbors[index]) if (!points[neighbor]) stack.push(neighbor);
    }
  }
  // Bound the work for larger imported graphs. This small initial graph does not
  // need a continuously running physics simulation or a random source of motion.
  const steps = Math.max(12, Math.min(160, Math.floor(1200000 / (count * count))));
  for (let step = 0; step < steps; step++) {
    const forces = points.map((p) => ({ x: -p.x * 0.025, y: -p.y * 0.025 }));
    for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) {
      const dx = points[i].x - points[j].x, dy = points[i].y - points[j].y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const strength = 5600 / (distance * distance * distance);
      for (const [axis, delta] of [["x", dx], ["y", dy]] as const) {
        forces[i][axis] += delta * strength;
        forces[j][axis] -= delta * strength;
      }
    }
    for (const [i, j] of edges) {
      const delta = { x: points[j].x - points[i].x, y: points[j].y - points[i].y };
      const distance = Math.max(1, Math.hypot(delta.x, delta.y));
      const strength = (distance - 108) / distance * 0.035;
      for (const axis of ["x", "y"] as const) {
        forces[i][axis] += delta[axis] * strength;
        forces[j][axis] -= delta[axis] * strength;
      }
    }
    const cooling = 1 - step / steps * 0.8;
    points.forEach((p, i) => {
      for (const axis of ["x", "y"] as const) p[axis] += Math.max(-3, Math.min(3, forces[i][axis])) * cooling;
    });
  }
  const center = points.reduce((sum, p) => ({ x: sum.x + p.x / count, y: sum.y + p.y / count, z: sum.z + p.z / count }), { x: 0, y: 0, z: 0 });
  return new Map(nodes.map((node, i) => [node.id, { x: points[i].x - center.x, y: points[i].y - center.y, z: points[i].z - center.z }]));
}
