import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Moon, Sparkles, Sun } from "lucide-react";
import { generateTheme, inferThemeStyle, themeStyles, type GeneratorOptions, type ThemeStyle } from "../../shared/theme-generator.js";
import type { ThemeConfig } from "../../shared/themes.js";

function startingOptions(config: ThemeConfig): GeneratorOptions {
  return { mode: config.mode, seed: config.colors.accent, style: inferThemeStyle(config) };
}
export function ThemeGenerator({ initialConfig, busy, onGenerate }: {
  initialConfig: ThemeConfig;
  busy: boolean;
  onGenerate: (config: ThemeConfig) => boolean;
}) {
  const [options, setOptions] = useState(() => startingOptions(initialConfig));
  const [firstVariation] = useState(() => crypto.getRandomValues(new Uint32Array(1))[0] || 1);
  const [variation, setVariation] = useState(0);
  useEffect(() => setOptions(startingOptions(initialConfig)), [initialConfig]);
  const validSeed = /^#[\da-f]{6}$/i.test(options.seed);
  const generated = useMemo(() => validSeed ? generateTheme(options, variation) : null, [options, variation, validSeed]);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!generated) return;
    const nextVariation = variation ? (variation + 1) >>> 0 || 1 : firstVariation;
    if (onGenerate(generateTheme(options, nextVariation))) setVariation(nextVariation);
  }
  return <form className="theme-generator" aria-label="Theme generator" onSubmit={submit}>
    <fieldset disabled={busy}>
      <legend><Sparkles size={18} />Theme generator</legend>
      <p className="muted">A fresh variation with every click. Keep your mood and base color, explore a new look.</p>
      <fieldset className="generator-mode"><legend>Appearance</legend>
        {(["light", "dark"] as const).map((mode) => <label key={mode}>
          <input type="radio" name="generator-mode" value={mode} checked={options.mode === mode} onChange={() => setOptions((value) => ({ ...value, mode }))} />
          {mode === "light" ? <Sun size={16} /> : <Moon size={16} />}{mode === "light" ? "Light" : "Dark"}
        </label>)}
      </fieldset>
      <div className="generator-inputs">
        <div className="theme-color-field"><label htmlFor="generator-seed">Base color</label><div>
          <input type="color" aria-label="Base color picker" value={validSeed ? options.seed : initialConfig.colors.accent} onChange={(event) => setOptions((value) => ({ ...value, seed: event.target.value }))} />
          <input id="generator-seed" value={options.seed} pattern="#[0-9a-fA-F]{6}" required maxLength={7} spellCheck={false} title="Use a six-digit hex color, such as #6b5b99" onChange={(event) => setOptions((value) => ({ ...value, seed: event.target.value }))} />
        </div></div>
        <label className="generator-style">Style<select aria-label="Style" value={options.style} onChange={(event) => setOptions((value) => ({ ...value, style: event.target.value as ThemeStyle }))}>
          {Object.entries(themeStyles).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}
        </select></label>
      </div>
      <p className="generator-description">{themeStyles[options.style].description} Your base color may be lightened or darkened for readability.</p>
      {generated && <div className="generator-swatches" aria-label="Generated palette">
        {(["background", "surface", "text", "accent", "character", "location", "faction", "object"] as const).map((key) => <span key={key} style={{ background: generated.colors[key] }} title={`${key}: ${generated.colors[key]}`} />)}
      </div>}
      <button className="secondary" disabled={!generated}><Sparkles size={16} />Generate theme</button>
      <p className="generator-note">Each variation pairs a new set of interface, heading, and reading fonts. Review the preview, then save when you’re ready.</p>
    </fieldset>
  </form>;
}
