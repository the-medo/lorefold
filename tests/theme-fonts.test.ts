import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { themeFontGroups, themeFonts } from "../shared/theme-fonts.js";

test("the shared font picker catalog includes at least twenty bundled families without duplicate choices", () => {
  assert.ok(Object.values(themeFonts).filter((font) => "source" in font).length >= 20);
  const choices = themeFontGroups.flatMap((group) => group.fonts.map(([id]) => id));
  assert.equal(new Set(choices).size, choices.length);
  assert.deepEqual(choices.sort(), Object.keys(themeFonts).sort());
});

test("every bundled choice has matching regular and italic faces, packaged assets, and its original license", async () => {
  const css = await readFile(new URL("../frontend/src/fonts.css", import.meta.url), "utf8");
  const imports = [...css.matchAll(/@import "([^"]+)"/g)].map((match) => match[1]);
  for (const font of Object.values(themeFonts)) {
    if (!("source" in font) || !font.source) continue;
    const root = new URL(`../node_modules/${font.source}/`, import.meta.url);
    const faces = imports.filter((path) => path.startsWith(`${font.source}/`));
    const styles = new Set<string>();
    for (const face of faces) {
      const faceCss: string = await readFile(new URL(face.slice(font.source.length + 1), root), "utf8");
      const family: string = font.family.split('"')[1];
      assert.ok(faceCss.includes(`font-family: '${family}'`), `${font.label}: CSS family matches saved configuration`);
      for (const [, style] of faceCss.matchAll(/font-style: (\w+);/g)) styles.add(style);
      for (const [, asset] of faceCss.matchAll(/url\(([^)]+)\)/g)) {
        const data = await readFile(new URL(asset, root));
        assert.equal(data.subarray(0, 4).toString(), asset.endsWith("woff2") ? "wOF2" : "wOFF");
      }
    }
    assert.deepEqual([...styles].sort(), ["italic", "normal"], `${font.label}: both styles are imported`);
    const license = new URL(`../frontend/public/fonts/licenses/${font.source.split("/")[1]}.txt`, import.meta.url);
    assert.equal(await readFile(license, "utf8"), await readFile(new URL("LICENSE", root), "utf8"));
  }
});
