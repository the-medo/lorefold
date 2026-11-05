import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Chapter, Paragraph } from "../../scripts/book-benchmark/source.js";
const execute = promisify(execFile);
const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();
export const MAX_PART_CHARS = 24000;
// Every source character is retained; oversized paragraphs are sliced at safe Unicode boundaries.
export function splitParts(chapter: Chapter): Chapter[] {
  const paragraphs: Paragraph[] = chapter.paragraphs.flatMap(p => {
    const chars = Array.from(p.text); const result: Paragraph[] = [];
    for (let i = 0; i < chars.length; i += 8000) result.push({ id: `${p.id}x${i / 8000}`, text: chars.slice(i, i + 8000).join("") });
    return result;
  });
  const parts: Chapter[] = []; let current: Paragraph[] = [], size = 0;
  for (const p of paragraphs) {
    if (size + p.text.length > MAX_PART_CHARS && current.length) { parts.push({ ...chapter, paragraphs: current }); current = []; size = 0; }
    current.push(p); size += p.text.length;
  }
  if (current.length) parts.push({ ...chapter, paragraphs: current });
  return parts;
}
function plainChapters(text: string): Chapter[] {
  if (text.includes("\0")) throw new Error("Invalid text encoding.");
  const groups: { title: string; lines: string[] }[] = []; let group = { title: "Beginning", lines: [] as string[] };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(?:#{1,2}\s+\S|(?:chapter|prologue|epilogue|part)\b)/i.test(line) && line.trim().length < 200) {
      if (group.lines.some(l => l.trim())) groups.push(group);
      group = { title: line.replace(/^\s*#+\s*/, "").trim(), lines: [line] };
    } else group.lines.push(line);
  }
  if (group.lines.some(l => l.trim())) groups.push(group);
  return groups.map((g, i) => ({ number: i + 1, index: i + 1, title: g.title, navigationTitle: g.title,
    source: "text", fragmented: false, paragraphs: g.lines.join("\n").split(/\n\s*\n/).map(normalize).filter(Boolean).map((text, j) => ({ id: `s${i + 1}p${j + 1}`, text })) }));
}
export async function extractBook(bytes: Buffer, filename: string, signal?: AbortSignal): Promise<Chapter[]> {
  const extension = extname(filename).toLowerCase();
  const directory = await mkdtemp(join(tmpdir(), "lorefold-import-"));
  try {
    const input = join(directory, `source${extension}`); await writeFile(input, bytes, { mode: 0o600 });
    let chapters: Chapter[];
    if (extension === ".epub") {
      const { stdout } = await execute("python3", [fileURLToPath(new URL("../../scripts/book-benchmark/extract_epub.py", import.meta.url)), input, "--chapters"], { signal, timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
      chapters = JSON.parse(stdout).sections.map((s: Chapter, i: number) => ({ ...s, number: i + 1, title: s.title.slice(0, 200) }));
    } else if (extension === ".pdf") {
      const { stdout } = await execute("pdftotext", ["-enc", "UTF-8", "-nopgbrk", input, "-"], { signal, timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
      chapters = plainChapters(stdout);
    } else if (extension === ".txt" || extension === ".md") {
      chapters = plainChapters(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } else throw new Error("Unsupported format.");
    if (!chapters.length || chapters.length > 1500 || chapters.reduce((n, c) => n + c.paragraphs.reduce((n, p) => n + p.text.length, 0), 0) > 24 * 1024 * 1024)
      throw new Error("Empty or oversized extracted book.");
    return chapters;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
