import { PlanAuth, RESOURCE } from "./auth.js";
import { parseResponse, type Call, type Provider, type ProviderResult } from "../book-benchmark/provider.js";
import type { Model } from "../book-benchmark/models.js";

// Zeroes are placeholders for the common Model type, not prices. The runner never
// computes dollar costs for this provider: plan allowance is shared with Codex.
export const PLAN_MODELS: Model[] = [
  { key: "sol", id: "gpt-6.1-sol", format: "responses", inputUSD: 0, outputUSD: 0, context: 272000, reasoning: "medium" },
  { key: "astra", id: "gpt-6-astra", format: "responses", inputUSD: 0, outputUSD: 0, context: 272000, reasoning: "medium" },
];
export const PLAN_REASONING = ["low", "medium", "high", "xhigh"] as const;
export function isPlanReasoning(value: unknown): value is typeof PLAN_REASONING[number] {
  return PLAN_REASONING.some(level => level === value);
}
export const DEFAULT_PLAN_TIMEOUT_SECONDS = 180;
export function isPlanTimeout(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 30 && value <= 900;
}
export function planModels(value: string, reasoning = "medium") {
  if (!isPlanReasoning(reasoning)) throw new Error(`ChatGPT reasoning must be ${PLAN_REASONING.join(", ")}.`);
  const keys = value.split(",");
  if (!keys.length || new Set(keys).size !== keys.length || keys.some(k => !PLAN_MODELS.some(m => m.key === k))) throw new Error("ChatGPT plan models: sol,astra.");
  return keys.map(key => ({ ...PLAN_MODELS.find(m => m.key === key)!, reasoning }));
}
export function planRequest(call: Call) {
  return { model: call.model.id, instructions: call.prompt.system,
    input: [{ role: "user", content: call.prompt.user }], reasoning: { effort: call.model.reasoning },
    store: false, stream: true };
}
export class PlanRequestError extends Error {}
function failed(code: unknown, status?: number) {
  if (code === "subscription_sharing_usage_limit_exceeded" || code === "subscription_sharing_usage_unavailable")
    return new PlanRequestError("Provider ChatGPT plan usage limit reached or unavailable. Manage usage at https://chatgpt.com/settings/usage. Remaining calls stopped; no paid API fallback.");
  return new PlanRequestError(`Provider ChatGPT request failed${status ? ` (HTTP ${status})` : ""}. Check account/model access and plan limits. No automatic retry.`);
}
export async function readPlanStream(response: Response): Promise<ProviderResult> {
  if (!response.ok) {
    // Do not persist arbitrary provider messages, which can contain prompt data.
    let code: unknown;
    try { const data = await response.json(); code = data?.error?.code; } catch { /* HTTP status is enough. */ }
    throw failed(code, response.status);
  }
  // Some plan responses omit Content-Type but still contain valid SSE. Require
  // a completed event below; never treat a missing header as inference success.
  const contentType = response.headers.get("content-type");
  if (contentType && contentType.split(";")[0].trim().toLowerCase() !== "text/event-stream") { await response.body?.cancel(); throw new PlanRequestError("Provider ChatGPT returned a non-stream response."); }
  const reader = response.body?.getReader();
  if (!reader) throw new PlanRequestError("Provider ChatGPT returned no response stream.");
  const decoder = new TextDecoder();
  let buffer = "", bytes = 0;
  const completedItems = new Map<number, unknown>();
  function event(block: string): ProviderResult | null {
    const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return null;
    let value;
    try { value = JSON.parse(data); } catch { throw new PlanRequestError("Provider ChatGPT returned malformed stream data."); }
    if (value.type === "response.failed" || value.type === "error") throw failed(value.response?.error?.code ?? value.code ?? value.error?.code);
    if (value.type === "response.incomplete") throw new PlanRequestError("Provider ChatGPT response was incomplete. No automatic retry.");
    if (value.type === "response.output_item.done") {
      if (!Number.isSafeInteger(value.output_index) || value.output_index < 0 || !value.item || typeof value.item !== "object" || Array.isArray(value.item))
        throw new PlanRequestError("Provider ChatGPT returned an invalid completed output item.");
      completedItems.set(value.output_index, value.item);
      return null;
    }
    if (value.type !== "response.completed") return null;
    if (value.response?.status !== "completed") throw new PlanRequestError("Provider ChatGPT did not complete the response.");
    // The plan route can leave the terminal output array empty after emitting
    // each completed item. Use those items only after response.completed.
    const output = Array.isArray(value.response.output) && value.response.output.length ? value.response.output :
      [...completedItems].sort(([a], [b]) => a - b).map(([, item]) => item);
    const result = parseResponse("responses", { ...value.response, output });
    if (!result.text.trim()) throw new PlanRequestError("Provider ChatGPT completed without output text. No automatic retry.");
    return result;
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4 * 1024 * 1024) throw new PlanRequestError("Provider ChatGPT stream exceeded the local size limit; consumed allowance is unknown.");
      buffer += decoder.decode(value, { stream: true });
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const result = event(buffer.slice(0, separator.index));
        buffer = buffer.slice(separator.index + separator[0].length);
        if (result) return result;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) { const result = event(buffer); if (result) return result; }
    throw new PlanRequestError("Provider ChatGPT stream ended before response.completed; consumed allowance is unknown. No automatic retry.");
  } catch (error) {
    if (error instanceof PlanRequestError) throw error;
    throw new PlanRequestError("Provider ChatGPT stream was interrupted; consumed allowance is unknown. No automatic retry.");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function listPlanModels(auth: PlanAuth, profile: string) {
  const { token } = await auth.access(profile);
  let response;
  try { response = await auth.send(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30000) }); }
  catch { throw new PlanRequestError("Provider ChatGPT model catalog connection failed."); }
  if (!response.ok) { await response.body?.cancel(); throw failed(undefined, response.status); }
  let data;
  try { data = await response.json(); } catch { throw new PlanRequestError("Provider ChatGPT model catalog is invalid."); }
  if (!Array.isArray(data.models)) throw new PlanRequestError("Provider ChatGPT model catalog is invalid.");
  return data.models.filter((m: Record<string, unknown>) => m.visibility === "list" && typeof m.slug === "string" && typeof m.display_name === "string")
    .map((m: { slug: string; display_name: string }) => ({ slug: m.slug, name: m.display_name })) as { slug: string; name: string }[];
}
export function planProvider(auth: PlanAuth, profile: string, fingerprint: string, signal?: AbortSignal,
  timeoutSeconds = DEFAULT_PLAN_TIMEOUT_SECONDS): Provider {
  if (!isPlanTimeout(timeoutSeconds)) throw new Error("ChatGPT timeout must be an integer from 30 to 900 seconds.");
  return async call => {
    try {
      const { token } = await auth.access(profile, fingerprint);
      const response = await auth.send(`${RESOURCE}/responses`, { method: "POST", redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(timeoutSeconds * 1000), ...(signal ? [signal] : [])]),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(planRequest(call)),
      });
      return await readPlanStream(response);
    } catch (error) {
      if (error instanceof PlanRequestError) throw error;
      throw new PlanRequestError("Provider ChatGPT session or connection failed; remaining calls stopped. Check sign-in. No automatic retry or paid API fallback.");
    }
  };
}
