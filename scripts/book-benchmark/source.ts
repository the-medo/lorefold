import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export type Paragraph = { id: string; text: string };
export type Section = { index: number; title: string; navigationTitle: string | null; source: string; fragmented: boolean; paragraphs: Paragraph[] };
export type Chapter = Section & { number: number };
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function readEpub(path: string): Section[] {
  const result = spawnSync("python3", [fileURLToPath(new URL("./extract_epub.py", import.meta.url)), path], {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 30000,
  });
  if (result.error || result.status !== 0)
    throw new Error("EPUB extraction failed. Requires Python 3 and an unencrypted EPUB with valid XHTML (25 MB maximum).");
  return JSON.parse(result.stdout).sections as Section[];
}

export function numbers(value: string): number[] {
  const values = value.split(",");
  if (!values.length || values.length > 24 || values.some(v => !/^[1-9]\d{0,3}$/.test(v)) || new Set(values).size !== values.length)
    throw new Error("Choose 1–24 distinct positive chapter/section numbers, separated by commas.");
  return values.map(Number);
}

export function selectChapters(sections: Section[], wanted: number[], explicitSections = false): Chapter[] {
  const chapters = wanted.map(number => {
    const found = sections.filter(s => explicitSections ? s.index === number : Number(/^chapter\s+(\d+)$/i.exec(s.navigationTitle ?? "")?.[1]) === number);
    if (found.length !== 1) throw new Error(`Chapter/section ${number} is missing or ambiguous. Use --list, then --sections for whole-document chapters.`);
    if (found[0].fragmented) throw new Error(`Section ${found[0].index} uses fragment navigation; split-document chapter extraction is not supported yet.`);
    return { ...found[0], number };
  });
  if (chapters.some((c, i) => i > 0 && (c.index <= chapters[i - 1].index || c.number <= chapters[i - 1].number)))
    throw new Error("Chapters must be selected in increasing reading order.");
  return chapters;
}

/** Whole paragraphs from earlier selected chapters only, bounded for every model. */
export function contextFor(chapters: Chapter[], position: number, maxChars: number): Chapter[] {
  let remaining = maxChars;
  const earlier: Chapter[] = [];
  let full = false;
  for (const chapter of chapters.slice(0, position).reverse()) {
    const selected: Paragraph[] = [];
    for (const p of [...chapter.paragraphs].reverse()) {
      if (p.text.length > remaining) { full = true; break; }
      selected.unshift(p); remaining -= p.text.length;
    }
    if (selected.length) earlier.unshift({ ...chapter, paragraphs: selected });
    if (full) break;
  }
  return [...earlier, chapters[position]];
}
