export type Model = {
  key: string;
  id: string;
  format: "responses" | "messages" | "chat/completions";
  inputUSD: number;
  outputUSD: number;
  context: number;
  reasoning?: "low";
};

// USD / million tokens, uncached standard inference. Versioned in every run.
// Sources and limitations: docs/book-benchmark.md.
export const PRICE_DATE = "2026-10-25";
export const MODELS: Model[] = [
  { key: "gpt", id: "openai/gpt-6.1-sol", format: "responses", inputUSD: 2, outputUSD: 10, context: 272000, reasoning: "low" },
  { key: "claude", id: "anthropic/claude-sonnet-5.5", format: "messages", inputUSD: 2, outputUSD: 10, context: 1000000 },
  { key: "glm", id: "@cf/zai-org/glm-5.3-flash", format: "chat/completions", inputUSD: .15, outputUSD: .5, context: 1048576, reasoning: "low" },
  { key: "deepseek", id: "@cf/deepseek-ai/deepseek-v4.1-flash-1017", format: "chat/completions", inputUSD: .3, outputUSD: 1.2, context: 1048576, reasoning: "low" },
  { key: "oss", id: "@cf/openai/gpt-oss-120b", format: "chat/completions", inputUSD: .35, outputUSD: .75, context: 128000, reasoning: "low" },
  { key: "gemma", id: "@cf/google/gemma-4-26b-a4b-it", format: "chat/completions", inputUSD: .1, outputUSD: .3, context: 256000 },
];

export function selectModels(value: string): Model[] {
  const keys = value.split(",");
  if (!keys.length || new Set(keys).size !== keys.length || keys.some(k => !MODELS.some(m => m.key === k)))
    throw new Error(`Models must be unique keys from: ${MODELS.map(m => m.key).join(",")}`);
  return keys.map(key => MODELS.find(m => m.key === key)!);
}
