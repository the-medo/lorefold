import { accountAuth, personalConnectionConfiguration } from "../chatgpt/connections.js";
import { planProvider, PLAN_MODELS } from "../../scripts/chatgpt-plan/provider.js";
import { liveProvider, reservation } from "../../scripts/book-benchmark/provider.js";
import type { AnalysisPreference } from "../../shared/ai.js";
import type { ImportMode } from "../../shared/imports.js";
import { importPrompt, mockImport, type ImportRequest } from "./analysis.js";
import { isInstallationOwner } from "../personal-installation.js";
export function importMode(env = process.env): ImportMode {
  const mode = env.LOREFOLD_AI_MODE ?? "mock";
  if (!["mock", "chatgpt-plan", "gateway"].includes(mode)) throw new Error("Unknown import provider.");
  return mode as ImportMode;
}
export async function importProvider(ownerId: string, mode: ImportMode, preference: AnalysisPreference, signal?: AbortSignal) {
  const model = { ...PLAN_MODELS.find(m => m.id === preference.model)!, reasoning: preference.effort };
  if (!model.id) throw new Error("Unsupported analysis model.");
  if (mode === "mock") return async (request: ImportRequest) => mockImport(request);
  if (process.env.LOREFOLD_IMPORT_LIVE !== "1") throw new Error("Live imports are not enabled.");
  let provider;
  if (mode === "chatgpt-plan") {
    if (!personalConnectionConfiguration(process.env).enabled) throw new Error("Personal ChatGPT connection is disabled.");
    if (!await isInstallationOwner(ownerId)) throw new Error("Personal ChatGPT imports are restricted to the installation owner.");
    const auth = accountAuth(ownerId);
    const status = (await auth.status()).find(s => s.profile === "account" && s.connected && s.planEnabled);
    if (!status) throw new Error("Connect ChatGPT in your AI settings first.");
    const { fingerprint } = await auth.access("account");
    provider = planProvider(auth, "account", fingerprint, signal, 900);
  } else {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "", gatewayId = process.env.CLOUDFLARE_AI_GATEWAY_ID ?? "", token = process.env.CLOUDFLARE_API_TOKEN ?? "";
    if (!/^[a-f0-9]{32}$/.test(accountId) || !/^[a-z0-9_-]{1,64}$/.test(gatewayId) || !token) throw new Error("Gateway import credentials are missing.");
    model.id = `openai/${preference.model}`;
    provider = liveProvider({ accountId, gatewayId, token }, fetch, signal);
  }
  return (request: ImportRequest) => {
    const call = { model, prompt: importPrompt(request), maxOutput: request.phase === "identity" ? 16000 : 50000,
      runId: `import-${request.chapter.source}`, chapter: request.chapter.number };
    reservation(call); // Check a conservative context bound before making an external call.
    return provider(call);
  };
}
