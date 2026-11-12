import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Entity, Graph } from "../../../shared/contracts.js";
import { defaultTheme } from "../../../shared/themes.js";
import { StoryGraph } from "../../src/Graph.js";
import { applyDocumentTheme } from "../../src/theme.js";
import "../../src/style.css";

// An original, synthetic graph used only by this development preview.
function makeStudy(): Graph {
  const ports = ["Alder", "Bracken", "Cinder", "Dusk", "Ember", "Fallow", "Gale", "Larch", "Reed", "Sable"];
  const entities: Entity[] = [];
  const relationships: Graph["relationships"] = [];
  function link(source: number, target: number, label: string) {
    const from = entities[source], to = entities[target];
    const id = `${from.id}-${to.id}`;
    relationships.push({
      id, source: from.id, target: to.id, label, chapter: 1,
      evidence: { id, chapter: 1, quote: `${from.label} ${label} ${to.label}.` },
    });
  }
  for (const port of ports) {
    const add = (kind: Entity["kind"], label: string) =>
      entities.push({ id: String(entities.length).padStart(3, "0"), kind, label, aliases: [], facts: [] });
    for (const name of ["Ada", "Bram", "Eda", "Ivo", "Lea", "Nico", "Ori", "Tess"]) add("character", `${name} ${port}`);
    for (const place of ["Quay", "Library", "Gate", "Beacon", "Lock", "Reach"]) add("location", `${port} ${place}`);
    for (const group of ["Watch", "Guild"]) add("faction", `${port} ${group}`);
    for (const item of ["Key", "Atlas", "Bell", "Seal"]) add("object", `${port} ${item}`);
  }
  for (let start = 0; start < entities.length; start += 20) {
    for (let person = 1; person < 8; person++) link(start + person, start + Math.floor((person - 1) / 2), "knows");
    for (let place = 0; place < 6; place++) link(start + place + 1, start + 8 + place, "works at");
    for (let group = 0; group < 2; group++) link(start + group, start + 14 + group, "leads");
    for (let item = 0; item < 4; item++) link(start + item + 2, start + 16 + item, "carries");
    link(start + 14, start + 10, "guards");
    link(start + 15, start + 8, "maintains");
    link(start + 7, start + 15, "belongs to");
    link(start + 8, (start + 20) % entities.length + 8, "trades with");
  }
  return { entities, relationships };
}

const graph = makeStudy();
function Study() {
  const [selection, setSelection] = useState<string | null>(null);
  return <>
    <header>
      <div><h1>200-node map study</h1><p>Synthetic sample · {graph.relationships.length} connections</p></div>
      <select aria-label="Inspect entity" value={selection ?? ""} onChange={event => setSelection(event.target.value || null)}>
        <option value="">All entities</option>
        {graph.entities.map(entity => <option key={entity.id} value={entity.id}>{entity.label}</option>)}
      </select>
    </header>
    <StoryGraph {...graph} selectedId={selection} onSelect={setSelection} />
  </>;
}

applyDocumentTheme(defaultTheme);
createRoot(document.getElementById("root")!).render(<Study />);
