export const analysisModels = [
  { id: "gpt-6-astra", label: "Astra" },
  { id: "gpt-6.1-sol", label: "Sol 6.1" },
] as const;
export const analysisEfforts = [
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
] as const;
export type AnalysisPreference = {
  model: typeof analysisModels[number]["id"];
  effort: typeof analysisEfforts[number]["id"];
};
export const defaultAnalysisPreference: AnalysisPreference = { model: "gpt-6-astra", effort: "high" };
export type ChatGPTConnection = {
  enabled: boolean;
  connected: boolean;
  planEnabled: boolean;
  email: string | null;
  registered: boolean;
  pending: boolean;
};
export type ConnectionAttempt = { authorizationUrl: string; expiresAt: string; tunnelCommand: string | null };
export type ConnectionProgress = { state: "pending"; attempt: ConnectionAttempt } | { state: "complete" | "failed" | "none" };
export type AISettings = { preference: AnalysisPreference; chatgpt: ChatGPTConnection };
