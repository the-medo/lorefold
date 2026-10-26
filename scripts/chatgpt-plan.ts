import { parseArgs } from "node:util";
import { PlanAuth } from "./chatgpt-plan/auth.js";
import { listPlanModels, PLAN_MODELS, planProvider } from "./chatgpt-plan/provider.js";

const HELP = `Usage: npm run chatgpt:plan -- <login|status|models|smoke|logout> [options]
  --profile NAME      Separate account/workspace registration (default: personal)
  --port 15190        Login callback on 127.0.0.1; only ports 15184–15190
  --smoke             After login, check Sol/Astra with at most two tiny AI calls

login opens a separate Lorefold authorization. It never reads Codex credentials.
smoke uses shared ChatGPT/Codex plan allowance and requires LOREFOLD_BENCHMARK_LIVE=1.
No API key, Cloudflare credits, or automatic fallback is used.
Manage weekly app limits and optional credit use: https://chatgpt.com/settings/usage
See docs/book-benchmark.md for sign-in from another computer.`;

async function smoke(auth: PlanAuth, profile: string, signal: AbortSignal) {
  const models = await listPlanModels(auth, profile);
  const { fingerprint } = await auth.access(profile);
  const provider = planProvider(auth, profile, fingerprint, signal);
  let checked = 0;
  for (const model of PLAN_MODELS) {
    if (!models.some(m => m.slug === model.id)) { console.log(`${model.id}: not offered by this account's catalog.`); continue; }
    checked++;
    const result = await provider({ model, prompt: { system: 'Return exactly {"ok":true}.', user: "Check the Lorefold connection." }, maxOutput: 0, runId: "connection-check", chapter: 1 });
    let valid = false;
    try { valid = JSON.parse(result.text).ok === true; } catch { /* Report, never echo arbitrary model output. */ }
    console.log(JSON.stringify({ model: model.id, completed: !result.truncated, valid, usage: result.usage }));
    if (!valid || result.truncated) { process.exitCode = 2; break; }
  }
  if (!checked) process.exitCode = 2;
}
async function main() {
  const { values, positionals } = parseArgs({ options: { profile: { type: "string" }, port: { type: "string" }, smoke: { type: "boolean" }, help: { type: "boolean" } }, allowPositionals: true, strict: true });
  if (values.help || !positionals.length) { console.log(HELP); return; }
  const [command] = positionals;
  if (positionals.length !== 1 || !["login", "status", "models", "smoke", "logout"].includes(command) || (values.port && command !== "login") || (values.smoke && command !== "login")) throw new Error("Invalid command/options. Use --help.");
  if (process.env.NODE_ENV === "production") throw new Error("ChatGPT plan tooling is for personal development use.");
  if ((command === "smoke" || values.smoke) && process.env.LOREFOLD_BENCHMARK_LIVE !== "1") throw new Error("The connection test requires LOREFOLD_BENCHMARK_LIVE=1; it consumes plan allowance.");
  const profile = values.profile ?? "personal", auth = new PlanAuth();
  const controller = new AbortController(), stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    if (command === "status") { const entries = await auth.status(); if (entries.length) console.table(entries); else console.log("No ChatGPT accounts connected. Run npm run chatgpt:plan -- login."); }
    if (command === "models") console.table(await listPlanModels(auth, profile));
    if (command === "login") {
      const result = await auth.login(profile, Number(values.port ?? "15190"), url => {
        console.log("Continue with ChatGPT:"); console.log(url);
        console.log("Callback must reach this machine's loopback listener. For a remote browser, first use the SSH tunnel described in docs/book-benchmark.md.");
      }, controller.signal);
      console.log(JSON.stringify(result));
      console.log(result.planEnabled ? "You're using your ChatGPT plan. Manage usage: https://chatgpt.com/settings/usage" : "Identity connected, but ChatGPT plan permission was not granted. Inference is disabled.");
      if (!result.planEnabled) process.exitCode = 2;
      if (values.smoke && result.planEnabled) await smoke(auth, profile, controller.signal);
    }
    if (command === "smoke") await smoke(auth, profile, controller.signal);
    if (command === "logout") {
      const result = await auth.logout(profile);
      console.log(result.revoked ? "Signed out; registration retained for later sign-in." : "Local credentials cleared; remote revocation was not confirmed. Disconnect Lorefold in ChatGPT Settings > Security and login > Sign in with ChatGPT.");
    }
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "ChatGPT plan operation failed."); process.exitCode = 1; });
