import { useState } from "react";
import type { Book } from "../../shared/contracts.js";
import { api } from "./api.js";
export const importing = (book: Book) => Boolean(book.import && ["queued", "extracting", "analyzing"].includes(book.import.status));
export function ImportProgress({ book, refresh, compact = false }: { book: Book; refresh?: () => void; compact?: boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const job = book.import;
  const labels = { queued: "Waiting to analyze", extracting: "Extracting chapters", analyzing: "Analyzing chapters", paused: "Analysis paused", failed: "Analysis needs attention", complete: "Analysis complete" };
  async function control(action: "pause" | "resume") {
    setBusy(true); setError("");
    try { await api(`/books/${encodeURIComponent(book.id)}/import`, { method: "POST", body: JSON.stringify({ action }) }); refresh?.(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  if (!job && !book.resourceId) return null;
  return <section className={`import-progress ${compact ? "compact" : ""}`} aria-label="Book analysis">
    <strong>{job ? labels[job.status] : "Ready to analyze"}</strong>
    {job && <>
      <span className="import-provider">{job.mode === "mock" ? "Mock analysis · source excerpts, no AI calls" : `${job.model === "gpt-6-astra" ? "Astra" : "Sol 6.1"} · ${job.effort === "xhigh" ? "Extra high" : job.effort} · ${job.mode === "chatgpt-plan" ? "ChatGPT plan" : "AI Gateway"}`}</span>
      {job.totalParts > 0 && <><progress aria-label="Analysis progress" value={job.completedParts} max={job.totalParts} /><span>{book.analyzedChapters}/{book.totalChapters} chapters · {job.completedParts}/{job.totalParts} steps completed</span></>}
      {!compact && job.mode !== "mock" && <p className="muted">Recorded usage: {job.inputTokens.toLocaleString()} input + {job.outputTokens.toLocaleString()} output tokens. Interrupted calls may have additional usage.</p>}
      {job.error && <p className="error">{job.error}</p>}
    </>}
    {!compact && <>
      <p className="muted">Analysis does not advance your reading progress. Finish chapters to reveal their recaps and map.</p>
      {refresh && (importing(book) ? <><button className="secondary" disabled={busy} onClick={() => control("pause")}>Pause analysis</button><small>Pauses after the current request is saved.</small></>
        : (!job || (job.status !== "complete" && job.retryable)) && <><button className="primary" disabled={busy} onClick={() => control("resume")}>{job ? "Resume analysis" : "Analyze book"}</button>{job?.mode !== "mock" && <small>Resuming keeps completed parts. Failed or interrupted requests may consume usage again.</small>}</>)}
    </>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
