import { contrastRatio } from "./theme-colors.js";
import { themeFontPairings, themeFonts, type FontPairing } from "./theme-fonts.js";
import type { ThemeConfig } from "./themes.js";

export const themeStyles = {
  literary: { label: "Literary", description: "Bookish serifs, generous reading space, soft corners." },
  modern: { label: "Modern", description: "Clean sans-serif type and balanced spacing." },
  terminal: { label: "Terminal", description: "Monospaced reading, compact spacing, crisp corners." },
} as const satisfies Record<keyof typeof themeFontPairings, { label: string; description: string }>;
export type ThemeStyle = keyof typeof themeStyles;
export type GeneratorOptions = { mode: ThemeConfig["mode"]; seed: string; style: ThemeStyle };

const styleSettings: Record<ThemeStyle, {
  typography: Omit<ThemeConfig["typography"], keyof FontPairing["fonts"]>; radius: number; spacing: number;
}> = {
  literary: { typography: { size: 14, readingSize: 22, readingLineHeight: 1.9 }, radius: 12, spacing: 1.1 },
  modern: { typography: { size: 14, readingSize: 20, readingLineHeight: 1.7 }, radius: 8, spacing: 1 },
  terminal: { typography: { size: 14, readingSize: 19, readingLineHeight: 1.8 }, radius: 3, spacing: .9 },
};

export function inferThemeStyle({ typography }: ThemeConfig): ThemeStyle {
  const reading = themeFonts[typography.reading].kind, heading = themeFonts[typography.heading].kind;
  if (reading === "mono" || heading === "mono") return "terminal";
  return reading === "serif" || heading === "serif" ? "literary" : "modern";
}
const rgb = (hex: string) => [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
const hex = (channels: number[]) => `#${channels.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;

function hueAndSaturation(color: string) {
  const [r, g, b] = rgb(color).map((value) => value / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  if (!delta) return { hue: 260, saturation: 0 };
  const hue = (max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60;
  return { hue: (hue + 360) % 360, saturation: delta / (1 - Math.abs(max + min - 1)) };
}
function hsl(hue: number, saturation: number, lightness: number) {
  const h = ((hue % 360) + 360) % 360 / 60;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(h % 2 - 1)), m = lightness - c / 2;
  const channels = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return hex(channels.map((value) => (value + m) * 255));
}

function readable(color: string, backgrounds: string[], minimum: number, softSurface?: string) {
  const score = (candidate: string) => {
    // Accent/status text is also used on the CSS 12% tinted surface.
    const soft = softSurface ? hex(rgb(candidate).map((value, i) => value * .12 + rgb(softSurface)[i] * .88)) : null;
    return Math.min(...[...backgrounds, ...(soft ? [soft] : [])].map((background) => contrastRatio(candidate, background)));
  };
  if (score(color) >= minimum) return color;
  const target = score("#000000") > score("#ffffff") ? 0 : 255;
  const channels = rgb(color);
  // Check the rounded sRGB result, not the floating-point candidate. A small
  // margin above the target leaves room for subtle differences in rendering.
  for (let step = 1; step <= 100; step++) {
    const candidate = hex(channels.map((channel) => channel + (target - channel) * step / 100));
    if (score(candidate) >= minimum) return candidate;
  }
  throw new Error("Unable to generate readable colors.");
}

// The browser supplies a fresh variation for each click. Keeping the random
// sequence explicit makes palette/contrast regressions reproducible in tests.
function variationRandom(variation: number) {
  let state = variation;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ state >>> 15, state | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export function generateTheme({ mode, seed, style }: GeneratorOptions, variation = 0): ThemeConfig {
  if (!/^#[\da-f]{6}$/i.test(seed) || !["light", "dark"].includes(mode) || !Object.hasOwn(themeStyles, style)) {
    throw new Error("Choose a six-digit base color, light or dark mode, and a theme style.");
  }
  if (!Number.isInteger(variation) || variation < 0 || variation > 0xffffffff) throw new Error("Choose a valid theme variation.");
  const dark = mode === "dark";
  const { hue, saturation } = hueAndSaturation(seed);
  const random = variationRandom(variation);
  const vary = (original: number, min: number, max: number) => variation ? min + random() * (max - min) : original;
  const paletteHue = hue + vary(0, -55, 55);
  const tint = Math.min(saturation * vary(.18, .08, .3), .25);
  const background = hsl(paletteHue, tint, dark ? vary(.075, .04, .12) : vary(.965, .94, .985));
  const surface = hsl(paletteHue, tint, dark ? vary(.115, .13, .18) : vary(.995, .985, 1));
  const surfaceAlt = hsl(paletteHue, tint, dark ? vary(.16, .19, .23) : vary(.925, .90, .935));
  const mapBackground = hsl(paletteHue, tint, dark ? vary(.095, .06, .14) : vary(.95, .935, .975));
  const surfaces = [background, surface, surfaceAlt, mapBackground];
  const accent = readable(seed.toLowerCase(), surfaces, 4.8, surface);
  const settings = styleSettings[style];
  const mapHue = hue + vary(0, -25, 25);
  const mapSaturation = vary(Math.max(.42, Math.min(saturation, .72)), .42, .75);
  const mapLightness = dark ? vary(.68, .6, .76) : vary(.45, .35, .52);
  const harmonies = [[0, 95, 210, 45], [0, 150, 210, 60], [0, 120, 240, 45], [0, 60, 180, 270]];
  const offsets = harmonies[variation ? Math.floor(random() * harmonies.length) : 0];
  const mapColor = (offset: number) => readable(hsl(mapHue + offset, mapSaturation, mapLightness), [mapBackground], 3.2);
  // Cycle curated triples independently of palette randomness. Consecutive
  // clicks always change fonts, and each style visits every pairing before repeating.
  const pairings = themeFontPairings[style];
  const typography = { ...settings.typography, ...pairings[variation % pairings.length].fonts };
  let { radius, spacing } = settings;
  if (variation) {
    // Consecutive variations also differ in shape, even for neutral base colors.
    radius = style === "terminal" ? variation % 6 : (style === "literary" ? 8 : 4) + variation % 9;
    spacing = Number((settings.spacing + (Math.floor(random() * 4) - 1) * .05).toFixed(2));
    typography.readingSize += Math.floor(random() * 5) - 2;
    typography.readingLineHeight = Number((typography.readingLineHeight + (Math.floor(random() * 4) - 1) * .1).toFixed(1));
  }
  return {
    version: 1, mode,
    colors: {
      background, surface, surfaceAlt, mapBackground, accent,
      accentText: contrastRatio("#ffffff", accent) >= contrastRatio("#000000", accent) ? "#ffffff" : "#000000",
      text: readable(hsl(paletteHue, tint, dark ? .93 : .12), surfaces, 7),
      muted: readable(hsl(paletteHue, tint, dark ? .66 : .4), surfaces, 4.8),
      border: readable(hsl(paletteHue, tint, dark ? .4 : .65), surfaces, 3.1),
      success: readable(hsl(vary(145, 135, 155), .45, dark ? .65 : .34), surfaces, 4.8, surface),
      danger: readable(hsl(vary(5, -3, 13), .65, dark ? .72 : .4), surfaces, 4.8, surface),
      mapEdge: readable(hsl(paletteHue, tint, .5), [mapBackground], 3.2),
      mapSelection: readable(accent, [mapBackground], 3.2),
      character: mapColor(offsets[0]), location: mapColor(offsets[1]), faction: mapColor(offsets[2]), object: mapColor(offsets[3]),
    },
    radius, spacing, typography,
  };
}
