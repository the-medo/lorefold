export type ImportMode = "mock" | "chatgpt-plan" | "gateway";
export type ImportStatus = "queued" | "extracting" | "analyzing" | "paused" | "failed" | "complete";
export type ImportProgress = {
  status: ImportStatus; mode: ImportMode; model: string; effort: string;
  totalParts: number; completedParts: number; inputTokens: number; outputTokens: number;
  error: string | null; retryable: boolean;
  retryCount: number; nextRetryAt: string | null;
};
