import { themeFonts, type ThemeFont } from "./theme-fonts.js";
export { themeFonts, type ThemeFont } from "./theme-fonts.js";

// Themes are data, never arbitrary CSS, URLs, or executable content.
export const colorLabels = {
  background: "Page background", surface: "Cards & panels", surfaceAlt: "Secondary surface",
  text: "Text", muted: "Secondary text", border: "Borders", accent: "Accent",
  accentText: "Text on accent", success: "Success", danger: "Errors",
  mapBackground: "Map background", mapEdge: "Connections", mapSelection: "Map selection",
  character: "Characters", location: "Locations", faction: "Factions", object: "Objects",
} as const;
export type ThemeColor = keyof typeof colorLabels;
export type ThemeConfig = {
  version: 1;
  mode: "light" | "dark";
  colors: Record<ThemeColor, string>;
  typography: { body: ThemeFont; heading: ThemeFont; reading: ThemeFont; size: number; readingSize: number; readingLineHeight: number };
  radius: number;
  spacing: number;
};
export type SavedTheme = { id: string; name: string; config: ThemeConfig };
export type ThemeLibrary = {
  themes: SavedTheme[];
  defaultThemeId: string | null;
  universeThemes: { universeId: string; themeId: string }[];
  contextUniverseId: string | null;
};
export const defaultTheme: ThemeConfig = {
  version: 1, mode: "light",
  colors: {
    background: "#f6f5f1", surface: "#fffefa", surfaceAlt: "#efedf3",
    text: "#302e35", muted: "#746e7c", border: "#e6e3e9", accent: "#6b5b99", accentText: "#ffffff",
    success: "#527051", danger: "#a34148", mapBackground: "#f3f0f7", mapEdge: "#aaa1b7", mapSelection: "#79669f",
    character: "#7970b5", location: "#4d8b80", faction: "#bd914e", object: "#bc7e6d",
  },
  typography: { body: "system", heading: "serif", reading: "serif", size: 14, readingSize: 21, readingLineHeight: 1.8 },
  radius: 8, spacing: 1,
};
export const midnightTheme: ThemeConfig = {
  ...defaultTheme, mode: "dark",
  colors: {
    background: "#171922", surface: "#222532", surfaceAlt: "#2a2e3d", text: "#eeeef4", muted: "#b2b4c5",
    border: "#42475c", accent: "#b5a0ed", accentText: "#211832", success: "#94cba1", danger: "#f39ba6",
    mapBackground: "#1b1e2a", mapEdge: "#858ca9", mapSelection: "#d2b8ff",
    character: "#b6a3ee", location: "#83c9b7", faction: "#e4be7f", object: "#e5a293",
  },
};

function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function between(value: unknown, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
export function isThemeConfig(value: unknown): value is ThemeConfig {
  if (!object(value, ["version", "mode", "colors", "typography", "radius", "spacing"]) || value.version !== 1 ||
      !["light", "dark"].includes(value.mode as string)) return false;
  if (!object(value.colors, Object.keys(colorLabels)) ||
      !Object.values(value.colors).every((color) => typeof color === "string" && /^#[\da-f]{6}$/i.test(color))) return false;
  const t = value.typography;
  return object(t, ["body", "heading", "reading", "size", "readingSize", "readingLineHeight"]) &&
    [t.body, t.heading, t.reading].every((font) => typeof font === "string" && Object.hasOwn(themeFonts, font)) &&
    between(t.size, 12, 20) && between(t.readingSize, 16, 32) && between(t.readingLineHeight, 1.4, 2.2) &&
    between(value.radius, 0, 20) && between(value.spacing, 0.8, 1.3);
}
export function resolveTheme(library: ThemeLibrary): ThemeConfig {
  const id = library.universeThemes.find((item) => item.universeId === library.contextUniverseId)?.themeId ?? library.defaultThemeId;
  return library.themes.find((theme) => theme.id === id)?.config ?? defaultTheme;
}
