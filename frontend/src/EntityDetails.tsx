import { ShieldCheck, X } from "lucide-react";
import type { Entity, Graph } from "../../shared/contracts.js";
import { entityColors } from "./graph-theme.js";

export function EntityDetails({
  entity,
  graph,
  cutoff,
  sourceTitle,
  close,
}: {
  entity: Entity;
  graph: Graph;
  cutoff: number;
  sourceTitle?: string;
  close: () => void;
}) {
  const connections = graph.relationships.filter(
    (r) => r.source === entity.id || r.target === entity.id,
  );
  const label = (id: string) =>
    graph.entities.find((e) => e.id === id)?.label;
  return (
    <aside className="details" aria-label="Entity details">
      <div className="details-heading">
        <span className="eyebrow">A CLOSER LOOK</span>
        <button
          className="icon-button"
          aria-label="Close details"
          onClick={close}
        >
          <X size={18} />
        </button>
      </div>
      <span
        className="entity-symbol"
        style={{ background: entityColors[entity.kind] }}
      >
        {entity.label.charAt(0)}
      </span>
      <span className="eyebrow entity-kind">{entity.kind}</span>
      <h2>{entity.label}</h2>
      {sourceTitle && <p className="muted">From {sourceTitle}</p>}
      {entity.aliases.length > 0 && (
        <p className="muted">Also known as {entity.aliases.join(", ")}</p>
      )}
      {entity.facts.map((fact, index) => (
        <div className="fact" key={index}>
          <p>{fact.value}</p>
          <details>
            <summary>{sourceTitle ?? "Source"} · Chapter {fact.evidence.chapter}</summary>
            <blockquote>{fact.evidence.quote}</blockquote>
          </details>
        </div>
      ))}
      <h3 className="detail-subtitle">Connections</h3>
      {connections.length ? (
        connections.map((r) => (
          <div className="connection" key={r.id}>
            <p>
              <strong>{label(r.source)}</strong> {r.label}{" "}
              <strong>{label(r.target)}</strong>
            </p>
            <details>
              <summary>{sourceTitle ?? "Source"} · Chapter {r.evidence.chapter}</summary>
              <blockquote>{r.evidence.quote}</blockquote>
            </details>
          </div>
        ))
      ) : (
        <p className="muted">No connections in this view yet.</p>
      )}
      <div className="boundary-note">
        <ShieldCheck size={15} /> Known through chapter {cutoff}
      </div>
    </aside>
  );
}

