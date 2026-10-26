import { useEffect, useState } from "react";
import { ExternalLink, Link2, Unplug } from "lucide-react";
import { analysisEfforts, analysisModels, type AISettings, type AnalysisPreference, type ConnectionAttempt, type ConnectionProgress } from "../../shared/ai.js";
import { api } from "./api.js";
import { AnalysisComparison } from "./AnalysisComparison.js";

export function AISettingsPage() {
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [preference, setPreference] = useState<AnalysisPreference | null>(null);
  const [attempt, setAttempt] = useState<ConnectionAttempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void api<AISettings>("/settings/ai").then(async result => {
      if (!active) return;
      setSettings(result); setPreference(result.preference);
      if (result.chatgpt.pending) {
        const progress = await api<ConnectionProgress>("/connections/chatgpt/attempt");
        if (active && progress.state === "pending") setAttempt(progress.attempt);
      }
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!attempt) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const progress = await api<ConnectionProgress>("/connections/chatgpt/attempt");
        if (!active) return;
        if (progress.state === "pending") { timer = setTimeout(poll, 2000); return; }
        const result = await api<AISettings>("/settings/ai");
        if (!active) return;
        setAttempt(null); setSettings(result);
        if (progress.state === "complete") setMessage(result.chatgpt.planEnabled
          ? "ChatGPT connected. Your plan will be available for eligible book analyses."
          : "Your ChatGPT identity is connected, but plan use was not authorized. Continue with ChatGPT again to grant access.");
        else setError("ChatGPT sign-in was cancelled, expired, or could not be verified. Check the tunnel and try again.");
      } catch (e) {
        if (active) { setError((e as Error).message); timer = setTimeout(poll, 5000); }
      }
    };
    timer = setTimeout(poll, 1500);
    return () => { active = false; clearTimeout(timer); };
  }, [attempt]);

  async function action(task: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("");
    try { await task(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const changed = settings && preference && (settings.preference.model !== preference.model || settings.preference.effort !== preference.effort);
  const connection = settings?.chatgpt;
  return <div className="ai-settings">
    {error && <p className="error" role="alert">{error}</p>}
    {message && <p className="ai-notice" role="status">{message}</p>}
    {!settings || !preference ? <p className="muted">{error ? "Reload this page to try again." : "Loading AI settings…"}</p> : <>
      <section className="settings-account" aria-labelledby="analysis-heading">
        <span className="eyebrow">BOOK ANALYSIS</span>
        <h2 id="analysis-heading">Choose your default model</h2>
        <p className="muted">Astra high is the starting default. Choose the model and reasoning effort you prefer.</p>
        <div className="ai-analysis-layout">
          <div className="ai-analysis-choice">
            <form onSubmit={e => { e.preventDefault(); void action(async () => {
              const saved = await api<{ preference: AnalysisPreference }>("/settings/ai", { method: "PUT", body: JSON.stringify(preference) });
              setSettings(current => current ? { ...current, preference: saved.preference } : current);
              setMessage("Default model saved.");
            }); }}>
              <div className="ai-model-fields">
                <label>Analysis model<select value={preference.model} disabled={busy} onChange={e => setPreference({ ...preference, model: e.target.value as AnalysisPreference["model"] })}>
                  {analysisModels.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
                </select></label>
                <label>Reasoning effort<select value={preference.effort} disabled={busy} onChange={e => setPreference({ ...preference, effort: e.target.value as AnalysisPreference["effort"] })}>
                  {analysisEfforts.map(effort => <option key={effort.id} value={effort.id}>{effort.label}</option>)}
                </select></label>
              </div>
              <p className="muted">Compare time and token use before choosing. Higher effort did not consistently improve results in this sample.</p>
              <button className="primary" type="submit" disabled={busy || !changed}>Save default model</button>
            </form>
            <p className="ai-footnote">Saved for future analyses. Uploaded books are currently stored only; analysis from the app is not available yet.</p>
          </div>
          <AnalysisComparison preference={preference} />
        </div>
      </section>
      <section className="settings-account" aria-labelledby="chatgpt-heading">
        <span className="eyebrow">CONNECTED ACCOUNTS</span>
        <h2 id="chatgpt-heading">ChatGPT</h2>
        <p className="muted">Connect your ChatGPT plan to this Lorefold account. Signing in to Lorefold with Google or email does not connect your subscription.</p>
        <div className="ai-connection-status"><Link2 size={18} /><strong>{connection?.connected ? (connection.planEnabled ? "Connected · plan access enabled" : "Connected · plan access needed") : "Not connected"}</strong></div>
        {connection?.email && <p>{connection.email}{!connection.connected && " · previously connected account"}</p>}
        <p className="muted">Eligible requests share your ChatGPT allowance. Plan limits and optional credit use are controlled in ChatGPT.</p>
        <a className="ai-external" href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage ChatGPT usage <ExternalLink size={14} /></a>
        {!connection?.enabled && <p className="ai-notice">Connecting is available in configured personal development installations. Hosted subscription access requires separate OpenAI setup.</p>}
        {attempt ? <div className="ai-connect-steps" aria-label="Connect ChatGPT">
          <h3>Finish connecting</h3>
          {attempt.tunnelCommand ? <>
            <p>On the computer with your browser, open a terminal, run this command and leave it open. It lets ChatGPT return to this personal Lorefold installation.</p>
            <pre><code>{attempt.tunnelCommand}</code></pre>
            <p className="muted">If this tunnel is already running, keep using it. Then continue below.</p>
          </> : <p>Continue in a browser on this installation’s computer so the localhost callback can reach Lorefold.</p>}
          <a className="ai-chatgpt-button" href={attempt.authorizationUrl} target="_blank" rel="noreferrer">Continue with ChatGPT <ExternalLink size={15} /></a>
          <p className="muted">Return here after approving access. This page checks the result automatically. The connection request expires after 20 minutes.</p>
          <button className="secondary" disabled={busy} onClick={() => void action(async () => {
            const result = await api<{ revoked: boolean }>("/connections/chatgpt/attempt", { method: "DELETE" }); setAttempt(null);
            const current = await api<AISettings>("/settings/ai"); setSettings(current);
            setMessage(!result.revoked ? "Connection cancelled locally. Also disconnect Lorefold in ChatGPT settings because remote revocation could not be confirmed."
              : current.chatgpt.connected ? "ChatGPT finished connecting before cancellation. Use Disconnect ChatGPT to remove it." : "Connection request cancelled.");
          })}>Cancel connection</button>
        </div> : <div className="ai-connection-actions">
          {(!connection?.connected || !connection.planEnabled) && <button className="ai-chatgpt-button" disabled={busy || !connection?.enabled || connection.pending} onClick={() => void action(async () => {
            setAttempt(await api<ConnectionAttempt>("/connections/chatgpt", { method: "POST" }));
          })}>Continue with ChatGPT</button>}
          {(connection?.connected || connection?.pending) && <button className="secondary" disabled={busy} onClick={() => void action(async () => {
            const result = await api<{ revoked: boolean }>("/connections/chatgpt", { method: "DELETE" });
            setAttempt(null); setSettings(await api<AISettings>("/settings/ai"));
            setMessage(result.revoked ? "ChatGPT disconnected from this Lorefold account." : "Local connection removed. OpenAI revocation could not be confirmed; also disconnect Lorefold in ChatGPT Settings → Security and login → Sign in with ChatGPT.");
          })}><Unplug size={16} />Disconnect ChatGPT</button>}
        </div>}
        {connection?.registered && !connection.connected && <p className="ai-footnote">Continue reconnects the same ChatGPT account and workspace.</p>}
        <p className="ai-footnote">The separate connection used by the command-line book tests is not linked to your Lorefold login. These controls manage only this account’s connection.</p>
      </section>
    </>}
  </div>;
}
