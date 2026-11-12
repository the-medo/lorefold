import type { ImportMode } from "./imports.js";

export type ScanStatus = "queued" | "running" | "ready" | "applied" | "failed";
export type MergeSuggestion = {
  number: number;
  first: { name: string; quote: string; chapter: number };
  second: { name: string; quote: string; chapter: number };
  reason?: string;
};
export type PointMergeReview = {
  bookTitle: string;
  nextMode: ImportMode;
  scan: {
    id: string; status: ScanStatus; mode: ImportMode;
    suggestions: MergeSuggestion[]; later: number; applied: number; error: string | null;
  } | null;
};
