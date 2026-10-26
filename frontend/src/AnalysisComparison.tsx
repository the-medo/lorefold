import { analysisEfforts, analysisModels, defaultAnalysisPreference, type AnalysisPreference } from "../../shared/ai.js";

// Aggregate measurements from the private 2026-10-26 effort comparison,
// book-evidence-v2, chapters 1–3, 16,000 characters of prior context.
// Keep book text, identities, quotes and raw model responses out of this snapshot.
const benchmark = {
  chapters: 3,
  inputTokens: 35_128,
  results: [
    { model: "gpt-6.1-sol", effort: "medium", totalMs: 391_214, outputTokens: 12_601, reasoningTokens: 267, passes: 3, matchedQuotes: 240, quotes: 240 },
    { model: "gpt-6.1-sol", effort: "high", totalMs: 622_248, outputTokens: 21_828, reasoningTokens: 2_993, passes: 3, matchedQuotes: 345, quotes: 345 },
    { model: "gpt-6.1-sol", effort: "xhigh", totalMs: 1_514_137, outputTokens: 50_163, reasoningTokens: 28_691, passes: 3, matchedQuotes: 317, quotes: 317 },
    { model: "gpt-6-astra", effort: "medium", totalMs: 214_032, outputTokens: 10_290, reasoningTokens: 28, passes: 2, matchedQuotes: 190, quotes: 191 },
    { model: "gpt-6-astra", effort: "high", totalMs: 384_258, outputTokens: 15_420, reasoningTokens: 616, passes: 3, matchedQuotes: 273, quotes: 273 },
    { model: "gpt-6-astra", effort: "xhigh", totalMs: 1_018_064, outputTokens: 32_420, reasoningTokens: 13_501, passes: 2, matchedQuotes: 293, quotes: 296 },
  ] satisfies (AnalysisPreference & { totalMs: number; outputTokens: number; reasoningTokens: number; passes: number; matchedQuotes: number; quotes: number })[],
};
const numbers = new Intl.NumberFormat("en-US");
const matches = (a: AnalysisPreference, b: AnalysisPreference) => a.model === b.model && a.effort === b.effort;
const baseline = benchmark.results.find(row => matches(row, defaultAnalysisPreference))!;
function averageTime(totalMs: number) {
  const seconds = Math.round(totalMs / benchmark.chapters / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
function label(row: AnalysisPreference) {
  return `${analysisModels.find(model => model.id === row.model)!.label} · ${analysisEfforts.find(effort => effort.id === row.effort)!.label}`;
}

export function AnalysisComparison({ preference }: { preference: AnalysisPreference }) {
  const selected = benchmark.results.find(row => matches(row, preference));
  return <section className="ai-comparison" aria-labelledby="comparison-heading">
    <h3 id="comparison-heading">Time &amp; token comparison</h3>
    <p className="muted">Same three chapters of one book · tested 26 Oct 2026.</p>
    {selected && <p className="ai-comparison-selection" aria-live="polite">
      <strong>{label(selected)}</strong>
      <span>{(selected.outputTokens / baseline.outputTokens).toFixed(2)}× the output tokens of Astra high</span>
    </p>}
    <div className="ai-comparison-scroll" role="region" aria-label="Model benchmark results" tabIndex={0}>
      <table aria-describedby="comparison-notes">
        <caption>Measured results · token and check totals cover all three chapters</caption>
        <thead><tr>
          <th scope="col">Model &amp; effort</th>
          <th scope="col">Output tokens<br /><span>including reasoning</span></th>
          <th scope="col">Avg. time<br />per chapter</th>
          <th scope="col">Checks<br />passed</th>
          <th scope="col">Exact<br />quotes</th>
        </tr></thead>
        <tbody>{benchmark.results.map(row => {
          const current = matches(row, preference);
          return <tr key={`${row.model}-${row.effort}`} className={current ? "is-selected" : undefined} aria-current={current ? "true" : undefined}>
            <th scope="row">{label(row)}{current && <span className="ai-comparison-badge">Selected</span>}</th>
            <td><strong>{numbers.format(row.outputTokens)}</strong><span className="ai-comparison-reasoning">{numbers.format(row.reasoningTokens)} reasoning</span></td>
            <td>{averageTime(row.totalMs)}</td>
            <td>{row.passes}/{benchmark.chapters}</td>
            <td>{row.matchedQuotes}/{row.quotes}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <p className="ai-comparison-scroll-hint">Scroll the table sideways for timings and checks.</p>
    <div id="comparison-notes" className="ai-comparison-notes">
      <p>Each configuration also used the same <strong>{numbers.format(benchmark.inputTokens)} input tokens</strong>. Reasoning tokens are already included in the output total.</p>
      <p>Checks count chapter results that passed formatting and exact-quote validation; they do not measure overall accuracy. One run per configuration and chapter; times and results can vary.</p>
      <p>Plan allowance, monetary cost and full-book usage were not measured.</p>
    </div>
  </section>;
}
