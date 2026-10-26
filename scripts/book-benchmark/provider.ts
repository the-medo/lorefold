import type { Model } from "./models.js";
import type { prompt } from "./analysis.js";

export type Prompt = ReturnType<typeof prompt>;
export type Usage = { inputTokens: number; outputTokens: number; reasoningTokens: number | null; cacheWriteTokens: number };
export type ProviderResult = { text: string; usage: Usage | null; reportedModel: string | null; truncated: boolean };
export type Call = { model: Model; prompt: Prompt; maxOutput: number; runId: string; chapter: number };
export type Provider = (call: Call) => Promise<ProviderResult>;
export type Credentials = { accountId: string; gatewayId: string; token: string };

export function credentials(env: NodeJS.ProcessEnv): Credentials {
  if (env.LOREFOLD_BENCHMARK_LIVE !== "1" || env.NODE_ENV === "production")
    throw new Error("Live benchmarks require LOREFOLD_BENCHMARK_LIVE=1 in a development environment.");
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const gatewayId = env.CLOUDFLARE_AI_GATEWAY_ID ?? "";
  const token = env.CLOUDFLARE_API_TOKEN ?? "";
  if (!/^[a-f0-9]{32}$/.test(accountId) || !/^[a-z0-9_]+(?:-[a-z0-9_]+)*$/.test(gatewayId) || gatewayId.length > 64 || !token.trim())
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_AI_GATEWAY_ID and CLOUDFLARE_API_TOKEN privately. Credentials are never CLI arguments.");
  return { accountId, gatewayId, token };
}

export function requestBody(call: Call): Record<string, unknown> {
  const { model, prompt: p, maxOutput } = call;
  if (model.format === "responses") return {
    model: model.id, instructions: p.system, input: p.user,
    max_output_tokens: maxOutput, reasoning: { effort: model.reasoning }, store: false,
  };
  if (model.format === "messages") return {
    model: model.id, system: p.system, messages: [{ role: "user", content: p.user }], max_tokens: maxOutput,
  };
  return { model: model.id, messages: [{ role: "system", content: p.system }, { role: "user", content: p.user }],
    max_tokens: maxOutput, ...(model.reasoning ? { reasoning_effort: model.reasoning } : {}) };
}

const obj = (v: unknown): Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const count = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

export function parseResponse(format: Model["format"], raw: unknown): ProviderResult {
  const envelope = obj(raw);
  if (envelope.success === false || envelope.error) throw new Error("Provider returned an error envelope.");
  const body = obj(envelope.result ?? raw);
  if (body.error || body.type === "error") throw new Error("Provider returned an error envelope.");
  const usage = obj(body.usage);
  let text = "", truncated = false;
  if (format === "responses") {
    text = list(body.output).filter(v => obj(v).type === "message").flatMap(v => list(obj(v).content))
      .filter(v => obj(v).type === "output_text").map(v => obj(v).text).filter(v => typeof v === "string").join("");
    truncated = body.status !== "completed";
  } else if (format === "messages") {
    text = list(body.content).filter(v => obj(v).type === "text").map(v => obj(v).text).filter(v => typeof v === "string").join("");
    truncated = body.stop_reason !== "end_turn";
  } else {
    const choice = obj(list(body.choices)[0]);
    const message = obj(choice.message);
    text = typeof message.content === "string" ? message.content : "";
    truncated = choice.finish_reason !== "stop";
  }
  const input = count(usage.input_tokens ?? usage.prompt_tokens);
  const output = count(usage.output_tokens ?? usage.completion_tokens);
  const cachedRead = format === "messages" ? count(usage.cache_read_input_tokens ?? 0) : 0;
  const cachedWrite = format === "messages" ? count(usage.cache_creation_input_tokens ?? 0) : 0;
  const normalized = input !== null && output !== null && cachedRead !== null && cachedWrite !== null ? {
    inputTokens: input + cachedRead + cachedWrite, outputTokens: output,
    // Reasoning is a subset of output usage, never added to it again.
    reasoningTokens: count(obj(usage.output_tokens_details ?? usage.completion_tokens_details).reasoning_tokens),
    cacheWriteTokens: cachedWrite,
  } : null;
  return { text, usage: normalized, reportedModel: typeof body.model === "string" ? body.model : null, truncated };
}

export function costUSD(model: Model, usage: Usage): number {
  // Cache reads are deliberately charged at uncached rates in this estimate.
  // Anthropic cache creation (if reported) receives its 1.25x write rate.
  return ((usage.inputTokens + usage.cacheWriteTokens * .25) * model.inputUSD + usage.outputTokens * model.outputUSD) / 1e6;
}

export function reservation(call: Call) {
  // Conservative planning proxy, not an exact tokenizer or a billing guarantee.
  const inputTokens = Buffer.byteLength(JSON.stringify(requestBody(call)), "utf8") + 1024;
  if (inputTokens + call.maxOutput > call.model.context)
    throw new Error(`Request exceeds the conservative context allowance for ${call.model.key}. Select shorter chapters or reduce --context-chars.`);
  return { inputTokens, costUSD: costUSD(call.model, { inputTokens, outputTokens: call.maxOutput, reasoningTokens: null, cacheWriteTokens: 0 }) };
}

export function liveProvider(config: Credentials, fetcher: typeof fetch = fetch, signal?: AbortSignal): Provider {
  return async (call) => {
    let response: Response;
    try {
      response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/v1/${call.model.format}`, {
        method: "POST", redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(180000), ...(signal ? [signal] : [])]),
        headers: {
          authorization: `Bearer ${config.token}`, "content-type": "application/json",
          "cf-aig-gateway-id": config.gatewayId, "cf-aig-skip-cache": "true",
          "cf-aig-collect-log": "false", "cf-aig-collect-log-payload": "false",
          "cf-aig-max-attempts": "1", "cf-aig-request-timeout": "180000",
          "cf-aig-metadata": JSON.stringify({ benchmark: call.runId, model: call.model.key, chapter: call.chapter }),
        }, body: JSON.stringify(requestBody(call)),
      });
    } catch { throw new Error("Gateway connection interrupted or timed out; billing is unknown. No automatic retry."); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Gateway HTTP ${response.status}; check account access, model availability, credits and limits. No automatic retry.`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Gateway returned an empty response.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error("Response too large"); }
        chunks.push(value);
      }
      return parseResponse(call.model.format, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch { throw new Error("Gateway response was interrupted, oversized or invalid; billing is unknown. No automatic retry."); }
  };
}
