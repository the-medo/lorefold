import { test } from "node:test";
import assert from "node:assert/strict";
import { contrastRatio } from "../shared/theme-colors.js";
import { generateTheme, inferThemeStyle, themeStyles, type ThemeStyle } from "../shared/theme-generator.js";
import { themeFontPairings, themeFonts } from "../shared/theme-fonts.js";
import { defaultTheme, isThemeConfig } from "../shared/themes.js";

test("contrast calculation matches reference sRGB pairs", () => {
  assert.equal(contrastRatio("#000000", "#ffffff"), 21);
  assert.equal(contrastRatio("#abcdef", "#abcdef"), 1);
  assert.equal(contrastRatio("#123456", "#abcdef"), contrastRatio("#abcdef", "#123456"));
  assert.ok(Math.abs(contrastRatio("#777777", "#ffffff") - 4.478) < .001);
});

test("generated palettes remain valid and readable across light, dark, saturated, and neutral seeds", () => {
  const channel = [0, 64, 128, 192, 255];
  for (const r of channel) for (const g of channel) for (const b of channel) {
    const seed = `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    for (const mode of ["light", "dark"] as const) for (const style of Object.keys(themeStyles) as ThemeStyle[]) for (const variation of [0, 1, 2, 57, 0xffffffff]) {
      const theme = generateTheme({ mode, seed, style }, variation);
      assert.ok(isThemeConfig(theme), `${seed} ${mode} ${style}`);
      assert.equal(theme.mode, mode);
      const c = theme.colors;
      for (const background of [c.background, c.surface, c.surfaceAlt, c.mapBackground]) {
        assert.ok(contrastRatio(c.text, background) >= 7, `${seed}: reading contrast`);
        for (const foreground of [c.muted, c.accent, c.success, c.danger]) assert.ok(contrastRatio(foreground, background) >= 4.5, `${seed}: UI text contrast`);
        assert.ok(contrastRatio(c.border, background) >= 3, `${seed}: control borders`);
      }
      assert.ok(contrastRatio(c.accentText, c.accent) >= 4.5, `${seed}: button text`);
      for (const foreground of [c.accent, c.success, c.danger]) {
        const tintedSurface = `#${[1, 3, 5].map((start) => Math.round(parseInt(foreground.slice(start, start + 2), 16) * .12 + parseInt(c.surface.slice(start, start + 2), 16) * .88).toString(16).padStart(2, "0")).join("")}`;
        assert.ok(contrastRatio(foreground, tintedSurface) >= 4.5, `${seed}: tinted status text`);
      }
      for (const foreground of [c.mapEdge, c.mapSelection, c.character, c.location, c.faction, c.object]) {
        assert.ok(contrastRatio(foreground, c.mapBackground) >= 3, `${seed}: map palette`);
      }
      assert.equal(new Set([c.character, c.location, c.faction, c.object]).size, 4);
    }
  }
});

test("mode, base color, and style produce deterministic, independent drafts", () => {
  const options = { mode: "light", seed: "#2255cc", style: "literary" } as const;
  const original = generateTheme(options);
  const copy = generateTheme(options);
  assert.deepEqual(original, copy);
  assert.deepEqual(generateTheme({ ...options, seed: "#2255CC" }), original);
  const dark = generateTheme({ ...options, mode: "dark" });
  assert.ok(contrastRatio(original.colors.background, "#000000") > 15);
  assert.ok(contrastRatio(dark.colors.background, "#ffffff") > 15);
  assert.notEqual(original.colors.accent, dark.colors.accent);
  assert.notEqual(original.colors.background, generateTheme({ ...options, seed: "#cc5522" }).colors.background);
  const modern = generateTheme({ ...options, style: "modern" });
  const terminal = generateTheme({ ...options, style: "terminal" });
  assert.equal(original.typography.reading, "lora");
  assert.equal(modern.typography.reading, "inter");
  assert.equal(terminal.typography.reading, "jetbrains");
  assert.ok(original.spacing > terminal.spacing);
  assert.ok(original.radius > terminal.radius);
  copy.typography.readingSize = 32;
  copy.colors.background = "#000000";
  assert.deepEqual(generateTheme(options), original);
});

test("invalid generator options are rejected before producing a theme", () => {
  const valid = { mode: "light", seed: "#2255cc", style: "modern" } as const;
  for (const seed of ["#fff", "red", "#zzzzzz", "#112233; color:red", "url(example.test)"]) {
    assert.throws(() => generateTheme({ ...valid, seed }));
  }
  for (const variation of [-1, .5, NaN, Infinity, 0x100000000]) assert.throws(() => generateTheme(valid, variation));
});

test("successive variations change colors, fonts, and shape while retaining mode and style", () => {
  for (const seed of ["#000000", "#ffffff", "#2255cc"]) for (const mode of ["light", "dark"] as const) for (const style of Object.keys(themeStyles) as ThemeStyle[]) {
    const options = { mode, seed, style };
    const palettes = new Set<string>();
    let previous = generateTheme(options, 1);
    for (let variation = 2; variation <= 30; variation++) {
      const next = generateTheme(options, variation);
      assert.deepEqual(generateTheme(options, variation), next, "explicit variations are reproducible");
      assert.equal(next.mode, mode);
      for (const role of ["body", "heading", "reading"] as const) assert.notEqual(next.typography[role], previous.typography[role]);
      assert.equal(inferThemeStyle(next), style);
      assert.notDeepEqual(next.colors, previous.colors);
      assert.notEqual(next.radius, previous.radius);
      palettes.add(JSON.stringify(next.colors));
      previous = next;
    }
    assert.equal(palettes.size, 29);
  }
});

test("font generation explores every curated pairing in either mode before repeating", () => {
  const usedFonts = new Set<string>();
  for (const style of Object.keys(themeStyles) as ThemeStyle[]) for (const mode of ["light", "dark"] as const) {
    const expected = themeFontPairings[style].map(({ fonts }) => JSON.stringify(fonts));
    const seen = new Set<string>();
    const options = { style, mode, seed: "#2255cc" };
    for (let variation = 0; variation < expected.length; variation++) {
      const { body, heading, reading } = generateTheme(options, variation).typography;
      const fonts = JSON.stringify({ body, heading, reading });
      assert.ok(expected.includes(fonts));
      assert.ok(!seen.has(fonts));
      seen.add(fonts);
      for (const font of [body, heading, reading]) {
        usedFonts.add(font);
        assert.ok("source" in themeFonts[font], "generated pairings use bundled fonts");
      }
      assert.equal(themeFonts[reading].kind, { literary: "serif", modern: "sans", terminal: "mono" }[style]);
    }
    assert.equal(seen.size, expected.length);
    const afterCycle = generateTheme(options, expected.length).typography;
    for (const role of ["body", "heading", "reading"] as const) {
      assert.equal(afterCycle[role], generateTheme(options, 0).typography[role]);
      assert.notEqual(afterCycle[role], generateTheme(options, expected.length - 1).typography[role]);
      assert.notEqual(generateTheme(options, 0xffffffff).typography[role], generateTheme(options, 1).typography[role], "browser variation wraparound changes fonts");
    }
  }
  for (const [id, font] of Object.entries(themeFonts)) if ("source" in font) assert.ok(usedFonts.has(id), `${id} is reachable through generation`);
});

test("style inference recognizes custom and legacy saved font choices", () => {
  assert.equal(inferThemeStyle(defaultTheme), "literary");
  for (const [reading, font] of Object.entries(themeFonts)) {
    const config = { ...defaultTheme, typography: { ...defaultTheme.typography, heading: "system", reading } };
    assert.ok(isThemeConfig(config));
    assert.equal(inferThemeStyle(config), { serif: "literary", sans: "modern", mono: "terminal" }[font.kind]);
  }
});
