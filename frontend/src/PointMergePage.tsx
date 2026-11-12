import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, GitMerge, LockKeyhole } from "lucide-react";
import type { PointMergeReview } from "../../shared/point-merges.js";
import type { ImportMode } from "../../shared/imports.js";
import { api } from "./api.js";

const providers: Record<ImportMode, string> = {
  mock: "Mock analysis · no AI calls",
  "chatgpt-plan": "Uses your connected ChatGPT plan",
  gateway: "Uses AI Gateway credits",
};
const merges = (n: number) => n === 1 ? "1 merge" : `${n} merges`;

export function PointMergePage({ bookId, chapter, back }: { bookId: string; chapter?: number; back: () => void }) {
  const base = `/books/${encodeURIComponent(bookId)}/point-merges`;
  const query = chapter === undefined ? "" : `?chapter=${chapter}`;
  const [review, setReview] = useState<PointMergeReview | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [skip, setSkip] = useState<number[]>([]);
  const [includeLater, setIncludeLater] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const load = async () => {
      try {
        const next = await api<PointMergeReview>(base + query, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setReview(next);
        setError("");
        if (next.scan?.status === "queued" || next.scan?.status === "running") timer = window.setTimeout(load, 2000);
      } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    };
    void load();
    const refresh = () => { setReview(null); setRevision(r => r + 1); };
    window.addEventListener("focus", refresh);
    return () => { controller.abort(); clearTimeout(timer); window.removeEventListener("focus", refresh); };
  }, [base, query, revision]);
  const scan = review?.scan;
  const selectionId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (scan && selectionId.current !== scan.id) {
      selectionId.current = scan.id;
      setSkip([]);
      setIncludeLater(true);
    }
  }, [scan]);
  const active = scan?.status === "queued" || scan?.status === "running";
  const selected = (scan?.suggestions.filter(p => !skip.includes(p.number)).length ?? 0) + (includeLater ? scan?.later ?? 0 : 0);
  async function submit(action: "analyze" | "apply") {
    setError(""); setBusy(true);
    try {
      const body = action === "analyze" ? { previousId: scan?.id ?? null } : { id: scan?.id, skip, includeLater };
      await api(`${base}/${action}${query}`, { method: "POST", body: JSON.stringify(body) });
      setReview(null);
      setRevision(r => r + 1);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <main className="library-page merge-page">
    <button className="back-link" onClick={back}><ArrowLeft size={16} />Back to book</button>
    <header className="page-intro">
      {review && <p className="muted">{review.bookTitle}</p>}
      <h1>Merge duplicate points</h1>
    </header>
    {!review && !error && <p role="status">Loading analysis…</p>}
    {review && <section className="merge-review" aria-label="Duplicate point analysis">
      {active ? <div role="status"><h2>{scan?.status === "queued" ? "Analysis queued" : "Analyzing points…"}</h2>
        <p>You can leave this page and return for the results.</p><small>{providers[scan!.mode]}</small></div>
      : <>
        {scan?.status === "applied" && <p className="merge-success" role="status"><Check size={18} />{merges(scan.applied)} applied to the map.</p>}
        {scan?.status === "failed" && <p role="alert" className="error">{scan.error}</p>}
        {scan?.status === "ready" ? <>
          <h2>{scan.suggestions.length + scan.later === 0 ? "No duplicate points found" : "Suggested merges"}</h2>
          <small>{providers[scan.mode]}</small>
          {scan.suggestions.map(pair => <article className="merge-pair" key={pair.number}>
            <label><input type="checkbox" checked={!skip.includes(pair.number)} disabled={busy}
              onChange={e => setSkip(prev => e.target.checked ? prev.filter(n => n !== pair.number) : [...prev, pair.number])} />
              <strong>{pair.first.name} <span aria-hidden="true">↔</span> {pair.second.name}</strong></label>
            {pair.reason && <p>{pair.reason}</p>}
            <details><summary>Supporting passages</summary>
              {[pair.first, pair.second].map((point, i) => <blockquote key={i}><small>{point.name} · Chapter {point.chapter}</small>{point.quote}</blockquote>)}
            </details>
          </article>)}
          {scan.later > 0 && <div className="merge-pair"><label><input type="checkbox" checked={includeLater}
            disabled={busy} onChange={e => setIncludeLater(e.target.checked)} />
            <strong>Include {merges(scan.later)} from later chapters</strong></label>
            <p><LockKeyhole size={14} /> Names and passages will appear when you reach those chapters.</p></div>}
        </> : <p>Analyze all map points in this book to find names that refer to the same person, place, faction, or object.</p>}
        <div className="merge-actions">
          {scan?.status === "ready" && scan.suggestions.length + scan.later > 0 &&
            <button className="primary" disabled={busy || !selected} onClick={() => submit("apply")}><GitMerge size={16} />Apply {merges(selected)}</button>}
          <button className={scan?.status === "ready" ? "secondary" : "primary"} disabled={busy} onClick={() => submit("analyze")}>
            {scan ? "Analyze again" : "Analyze all points"}
          </button>
        </div>
        {(scan?.status !== "ready" || scan.mode !== review.nextMode) && <small>{providers[review.nextMode]}</small>}
      </>}
    </section>}
    {error && <div role="alert"><p className="error">{error}</p><button className="secondary" onClick={() => setRevision(r => r + 1)}>Refresh analysis</button></div>}
  </main>;
}
