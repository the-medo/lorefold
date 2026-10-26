type FontKind = "sans" | "serif" | "mono";
type FontChoice = { label: string; family: string; kind: FontKind; source?: string };

function bundled(label: string, id: string, kind: FontKind, variable = true): FontChoice {
  return {
    label, kind,
    family: `"${label}${variable ? " Variable" : ""}", ${kind === "sans" ? "sans-serif" : kind === "mono" ? "monospace" : "serif"}`,
    source: `@fontsource${variable ? "-variable" : ""}/${id}`,
  };
}

// Stable keys are stored in saved themes. All three roles share the full catalog.
// New bundled families also need fonts.css imports and their original license.
export const themeFonts = {
  inter: bundled("Inter", "inter", "sans"),
  dmSans: bundled("DM Sans", "dm-sans", "sans"),
  figtree: bundled("Figtree", "figtree", "sans"),
  nunitoSans: bundled("Nunito Sans", "nunito-sans", "sans"),
  workSans: bundled("Work Sans", "work-sans", "sans"),
  publicSans: bundled("Public Sans", "public-sans", "sans"),
  sourceSans: bundled("Source Sans 3", "source-sans-3", "sans"),
  notoSans: bundled("Noto Sans", "noto-sans", "sans"),
  rubik: bundled("Rubik", "rubik", "sans"),
  lora: bundled("Lora", "lora", "serif"),
  sourceSerif: bundled("Source Serif 4", "source-serif-4", "serif"),
  literata: bundled("Literata", "literata", "serif"),
  merriweather: bundled("Merriweather", "merriweather", "serif"),
  crimsonPro: bundled("Crimson Pro", "crimson-pro", "serif"),
  ebGaramond: bundled("EB Garamond", "eb-garamond", "serif"),
  libreBaskerville: bundled("Libre Baskerville", "libre-baskerville", "serif"),
  fraunces: bundled("Fraunces", "fraunces", "serif"),
  notoSerif: bundled("Noto Serif", "noto-serif", "serif"),
  newsreader: bundled("Newsreader", "newsreader", "serif"),
  jetbrains: bundled("JetBrains Mono", "jetbrains-mono", "mono"),
  robotoMono: bundled("Roboto Mono", "roboto-mono", "mono"),
  sourceCode: bundled("Source Code Pro", "source-code-pro", "mono"),
  ibmPlexMono: bundled("IBM Plex Mono", "ibm-plex-mono", "mono", false),
  system: { label: "System sans", family: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', kind: "sans" },
  humanist: { label: "Humanist sans", family: '"Trebuchet MS", "Segoe UI", sans-serif', kind: "sans" },
  serif: { label: "Classic serif", family: 'Georgia, "Times New Roman", serif', kind: "serif" },
  book: { label: "Book serif", family: '"Palatino Linotype", "Book Antiqua", Palatino, serif', kind: "serif" },
  mono: { label: "Monospace", family: 'ui-monospace, "Cascadia Code", "Courier New", monospace', kind: "mono" },
} satisfies Record<string, FontChoice>;
export type ThemeFont = keyof typeof themeFonts;

export const themeFontGroups = [
  { key: "sans", label: "Sans serif" }, { key: "serif", label: "Serif" },
  { key: "mono", label: "Monospace" }, { key: "system", label: "System fonts" },
].map(({ key, label }) => ({
  label,
  fonts: (Object.entries(themeFonts) as [ThemeFont, FontChoice][])
    .filter(([, font]) => (font.source ? font.kind : "system") === key)
    .sort(([, a], [, b]) => a.label.localeCompare(b.label)),
}));

export type FontPairing = { name: string; fonts: { body: ThemeFont; heading: ThemeFont; reading: ThemeFont } };

// Pair quiet interface faces with a heading and reading face that share a mood.
// The order deliberately changes every role between neighbors, including wraparound.
// Keep each reading face once per style so cycling explores the full collection.
export const themeFontPairings = {
  literary: [
    { name: "Fireside", fonts: { body: "inter", heading: "lora", reading: "lora" } },
    { name: "Library", fonts: { body: "sourceSans", heading: "literata", reading: "sourceSerif" } },
    { name: "Sunday edition", fonts: { body: "workSans", heading: "fraunces", reading: "newsreader" } },
    { name: "Classic volume", fonts: { body: "publicSans", heading: "libreBaskerville", reading: "libreBaskerville" } },
    { name: "Old world", fonts: { body: "dmSans", heading: "ebGaramond", reading: "ebGaramond" } },
    { name: "Storybook", fonts: { body: "nunitoSans", heading: "merriweather", reading: "merriweather" } },
    { name: "Atlas", fonts: { body: "notoSans", heading: "notoSerif", reading: "notoSerif" } },
    { name: "Manuscript", fonts: { body: "figtree", heading: "crimsonPro", reading: "crimsonPro" } },
    { name: "Reading room", fonts: { body: "rubik", heading: "newsreader", reading: "literata" } },
    { name: "Folktale", fonts: { body: "sourceSans", heading: "fraunces", reading: "fraunces" } },
  ],
  modern: [
    { name: "Clear space", fonts: { body: "inter", heading: "inter", reading: "inter" } },
    { name: "Field notes", fonts: { body: "sourceSans", heading: "sourceSans", reading: "sourceSans" } },
    { name: "Studio", fonts: { body: "dmSans", heading: "rubik", reading: "dmSans" } },
    { name: "Civic", fonts: { body: "publicSans", heading: "workSans", reading: "publicSans" } },
    { name: "Daybreak", fonts: { body: "figtree", heading: "dmSans", reading: "figtree" } },
    { name: "Soft focus", fonts: { body: "nunitoSans", heading: "nunitoSans", reading: "nunitoSans" } },
    { name: "Workshop", fonts: { body: "workSans", heading: "figtree", reading: "workSans" } },
    { name: "Wayfinder", fonts: { body: "notoSans", heading: "notoSans", reading: "notoSans" } },
    { name: "Playful geometry", fonts: { body: "rubik", heading: "publicSans", reading: "rubik" } },
  ],
  terminal: [
    { name: "Night console", fonts: { body: "inter", heading: "jetbrains", reading: "jetbrains" } },
    { name: "Source notes", fonts: { body: "sourceSans", heading: "sourceCode", reading: "sourceCode" } },
    { name: "Archive terminal", fonts: { body: "publicSans", heading: "ibmPlexMono", reading: "ibmPlexMono" } },
    { name: "Orbital log", fonts: { body: "rubik", heading: "robotoMono", reading: "robotoMono" } },
  ],
} as const satisfies Record<string, readonly FontPairing[]>;
