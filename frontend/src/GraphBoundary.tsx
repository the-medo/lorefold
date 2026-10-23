import { Component, type ReactNode } from "react";

/** Keep the book and evidence list usable if the optional renderer cannot load. */
export class GraphBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    if (this.state.failed) return <div className="graph-wrap">
      <div className="graph-fallback" role="status">
        <p>The 3D map couldn’t load. You can still explore the entities and evidence below.</p>
        <button className="secondary" onClick={() => window.location.reload()}>Reload page</button>
      </div>
    </div>;
    return this.props.children;
  }
}
