import { lazy, Suspense, useEffect, useState, type FormEvent } from "react";
import { Check, Copy, Palette, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { colorLabels, defaultTheme, isThemeConfig, midnightTheme, type SavedTheme, type ThemeColor, type ThemeConfig, type ThemeFont } from "../../shared/themes.js";
import { themeFontGroups, themeFontPairings } from "../../shared/theme-fonts.js";
import type { Entity, Relationship } from "../../shared/contracts.js";
import { api } from "./api.js";
import { ThemePicker, ThemeSurface, useThemes } from "./theme.js";
import { GraphBoundary } from "./GraphBoundary.js";
import { ThemeGenerator } from "./ThemeGenerator.js";
import { contrastRatio } from "../../shared/theme-colors.js";

const StoryGraph = lazy(() => import("./Graph.js").then((module) => ({ default: module.StoryGraph })));
const previewEntities: Entity[] = [
  { id: "reader", label: "Mira", kind: "character", aliases: [], facts: [] },
  { id: "harbor", label: "The harbor", kind: "location", aliases: [], facts: [] },
  { id: "guild", label: "Explorers", kind: "faction", aliases: [], facts: [] },
  { id: "compass", label: "The compass", kind: "object", aliases: [], facts: [] },
];
const previewRelationships: Relationship[] = previewEntities.slice(1).map((entity, i) => ({
  id: entity.id, source: "reader", target: entity.id, label: ["visits", "joins", "carries"][i], chapter: 1,
  evidence: { id: entity.id, chapter: 1, quote: "An original example for your theme preview." },
}));

function ColorField({ colorKey, value, change }: { colorKey: ThemeColor; value: string; change: (value: string) => void }) {
  const [hex, setHex] = useState(value);
  useEffect(() => setHex(value), [value]);
  const label = colorLabels[colorKey];
  return <div className="theme-color-field">
    <label htmlFor={`theme-${colorKey}`}>{label}</label>
    <div><input aria-label={`${label} picker`} type="color" value={value} onChange={(e) => change(e.target.value)} />
      <input id={`theme-${colorKey}`} value={hex} pattern="#[0-9a-fA-F]{6}" required maxLength={7} spellCheck={false} title="Use a six-digit hex color, such as #6b5b99" onChange={(e) => {
        setHex(e.target.value);
        if (/^#[\da-f]{6}$/i.test(e.target.value)) change(e.target.value);
      }} />
    </div>
  </div>;
}
function Range({ label, value, min, max, step = 1, unit, change }: { label: string; value: number; min: number; max: number; step?: number; unit: string; change: (value: number) => void }) {
  return <label className="theme-range"><span>{label}<output>{value}{unit}</output></span>
    <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={(e) => change(Number(e.target.value))} />
  </label>;
}
function Preview({ config }: { config: ThemeConfig }) {
  const [selected, setSelected] = useState<string | null>(null);
  return <aside id="theme-preview" className="theme-preview" aria-label="Live theme preview">
    <div className="theme-preview-heading"><span className="eyebrow">LIVE PREVIEW</span><span>Changes stay here until saved.</span><button className="text-button theme-preview-jump" type="button" onClick={() => document.getElementById("theme-editor")?.scrollIntoView()}>Edit theme</button></div>
    <ThemeSurface config={config}>
      <div className="theme-preview-content">
        <span className="eyebrow">A WORLD OF YOUR OWN</span>
        <h2>Every story, in your colors.</h2>
        <p className="muted">A small glimpse of your library, reading space, and story map.</p>
        <article className="theme-preview-card">
          <span className="eyebrow">CHAPTER ONE · THE DEPARTURE</span>
          <h3>The horizon is calling</h3>
          <p className="theme-reading">Mira unfolded the map. Beyond the harbor, a thousand stories were waiting to be found.</p>
          <div className="theme-preview-buttons"><button className="primary" type="button" onClick={() => setSelected("reader")}>Explore the map</button><button className="secondary" type="button" onClick={() => setSelected(null)}>Reset selection</button></div>
          <label className="theme-preview-input">A note to remember<input placeholder="Where will the story take you?" /></label>
        </article>
        <GraphBoundary><Suspense fallback={<p role="status">Opening the preview map…</p>}><StoryGraph entities={previewEntities} relationships={previewRelationships} selectedId={selected} onSelect={setSelected} /></Suspense></GraphBoundary>
        <div className="entity-list" aria-label="Preview entities">{previewEntities.map((entity) => <button type="button" key={entity.id} aria-pressed={entity.id === selected} onClick={() => setSelected(entity.id)}><i style={{ background: config.colors[entity.kind] }} />{entity.label}</button>)}</div>
      </div>
    </ThemeSurface>
  </aside>;
}

export function ThemesSettings() {
  const { library, refresh } = useThemes();
  const [id, setId] = useState<string | null>(null);
  const [name, setName] = useState("My theme");
  const [config, setConfig] = useState<ThemeConfig>(defaultTheme);
  const [baseline, setBaseline] = useState({ name: "My theme", config: defaultTheme });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [lastGenerated, setLastGenerated] = useState<ThemeConfig | null>(null);
  const dirty = JSON.stringify({ name, config }) !== JSON.stringify(baseline);
  useEffect(() => {
    if (!dirty && !busy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const beforeNavigate = (event: Event) => {
      if (busy || !window.confirm("Discard your unsaved theme changes?")) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("lorefold:navigate", beforeNavigate);
    return () => { window.removeEventListener("beforeunload", beforeUnload); window.removeEventListener("lorefold:navigate", beforeNavigate); };
  }, [dirty, busy]);
  function load(theme?: SavedTheme) {
    if (dirty && !window.confirm("Discard your unsaved theme changes?")) return;
    const next = theme ?? { id: null, name: "My theme", config: defaultTheme };
    setId(next.id); setName(next.name); setConfig(next.config); setBaseline({ name: next.name, config: next.config });
    setError(""); setNotice(""); setDeleting(false); setLastGenerated(null);
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      if (!isThemeConfig(config)) throw new Error("Check your theme settings before saving.");
      const { theme } = await api<{ theme: SavedTheme }>(id ? `/themes/${encodeURIComponent(id)}` : "/themes", {
        method: id ? "PUT" : "POST", body: JSON.stringify({ name, config }),
      });
      setId(theme.id); setName(theme.name); setConfig(theme.config); setBaseline({ name: theme.name, config: theme.config });
      setNotice("Theme saved. Select it for the main page or inside a universe."); refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!id) return;
    setBusy(true); setError("");
    try {
      await api(`/themes/${encodeURIComponent(id)}`, { method: "DELETE" });
      setId(null); setName("My theme"); setConfig(defaultTheme); setBaseline({ name: "My theme", config: defaultTheme });
      setDeleting(false); setLastGenerated(null); setNotice("Theme deleted. Its assignments now use their default."); refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const updateTypography = <K extends keyof ThemeConfig["typography"]>(key: K, value: ThemeConfig["typography"][K]) => setConfig((current) => ({ ...current, typography: { ...current.typography, [key]: value } }));
  const textContrast = Math.min(contrastRatio(config.colors.text, config.colors.background), contrastRatio(config.colors.text, config.colors.surface));
  const buttonContrast = contrastRatio(config.colors.accentText, config.colors.accent);
  const useCount = library.universeThemes.filter((entry) => entry.themeId === id).length;
  const fontPairing = Object.values(themeFontPairings).flat().find(({ fonts }) =>
    fonts.body === config.typography.body && fonts.heading === config.typography.heading && fonts.reading === config.typography.reading);
  return <section aria-labelledby="themes-heading">
    <div className="themes-heading"><div><h2 id="themes-heading">Your themes</h2><p className="muted">Create a look you love. Give each universe its own atmosphere.</p></div><Palette size={32} strokeWidth={1.3} /></div>
    <section className="theme-assignment" aria-label="Default theme"><div><h2>Your everyday theme</h2><p className="muted">Used on the main page, in My library, and by universes without their own theme.</p></div><ThemePicker /></section>
    <div className="theme-workbench">
      <section id="theme-editor" className="theme-editor" aria-label="Theme editor">
        <div className="theme-library-bar"><label>Saved themes<select aria-label="Saved themes" value={id ?? ""} disabled={busy} onChange={(e) => load(library.themes.find((theme) => theme.id === e.target.value))}><option value="">New theme</option>{library.themes.map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}</select></label><button className="secondary" type="button" disabled={busy} onClick={() => load()}><Plus size={16} />New</button></div>
        <ThemeGenerator initialConfig={baseline.config} busy={busy} onGenerate={(generated) => {
          const manuallyEdited = JSON.stringify(config) !== JSON.stringify(baseline.config) && JSON.stringify(config) !== JSON.stringify(lastGenerated);
          if (manuallyEdited && !window.confirm("Replace your unsaved theme settings with a generated theme?")) return false;
          setConfig(generated); setLastGenerated(generated); setError(""); setDeleting(false);
          setNotice("Theme generated. Fine-tune the settings below, then save when you’re ready.");
          return true;
        }} />
        <form onSubmit={save} className="theme-editor-form">
          <fieldset disabled={busy} className="theme-fields">
            <label className="theme-name">Theme name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></label>
            <div className="theme-edit-note"><span>{id ? `Used by ${useCount} ${useCount === 1 ? "universe" : "universes"}${library.defaultThemeId === id ? " and your main page" : ""}. Saving updates every use.` : "A new theme, ready to make your own."}</span>{dirty && <strong>Unsaved changes</strong>}</div>
            <div className="theme-starters"><span>Start with a palette</span><button type="button" className="secondary" onClick={() => setConfig((current) => ({ ...current, mode: "light", colors: defaultTheme.colors }))}>Paper</button><button type="button" className="secondary" onClick={() => setConfig((current) => ({ ...current, mode: "dark", colors: midnightTheme.colors }))}>Midnight</button></div>
            <fieldset className="theme-section"><legend>Colors</legend><div className="theme-colors">{(Object.keys(colorLabels) as ThemeColor[]).filter((key) => !["mapBackground", "mapEdge", "mapSelection", "character", "location", "faction", "object"].includes(key)).map((key) => <ColorField key={key} colorKey={key} value={config.colors[key]} change={(value) => setConfig((current) => ({ ...current, colors: { ...current.colors, [key]: value } }))} />)}</div>
              <label className="theme-mode">Control appearance<select aria-label="Control appearance" value={config.mode} onChange={(e) => setConfig((current) => ({ ...current, mode: e.target.value as ThemeConfig["mode"] }))}><option value="light">Light</option><option value="dark">Dark</option></select></label>
              <p className={`theme-contrast ${Math.min(textContrast, buttonContrast) < 4.5 ? "low-contrast" : ""}`} role="status">Text contrast {textContrast.toFixed(1)}:1 · Button contrast {buttonContrast.toFixed(1)}:1{Math.min(textContrast, buttonContrast) < 4.5 ? ". Aim for at least 4.5:1 for comfortable reading." : " · Good contrast for regular text."}</p>
            </fieldset>
            <fieldset className="theme-section"><legend>Typography</legend>
              <p className="theme-font-note">{fontPairing ? <>Curated pairing: <strong>{fontPairing.name}</strong>. Make it your own below.</> : "Mix fonts freely, or generate a theme to try a curated pairing."}</p>
              <div className="theme-fonts">{(["body", "heading", "reading"] as const).map((key) => {
                const label = { body: "Interface font", heading: "Heading font", reading: "Reading font" }[key];
                return <label key={key}>{label}<select aria-label={label} value={config.typography[key]} onChange={(e) => updateTypography(key, e.target.value as ThemeFont)}>
                  {themeFontGroups.map((group) => <optgroup label={group.label} key={group.label}>
                    {group.fonts.map(([font, choice]) => <option value={font} key={font}>{choice.label}</option>)}
                  </optgroup>)}
                </select></label>;
              })}</div>
              <Range label="Interface text size" value={config.typography.size} min={12} max={20} unit="px" change={(value) => updateTypography("size", value)} />
              <Range label="Reading text size" value={config.typography.readingSize} min={16} max={32} unit="px" change={(value) => updateTypography("readingSize", value)} />
              <Range label="Reading line spacing" value={config.typography.readingLineHeight} min={1.4} max={2.2} step={0.1} unit="×" change={(value) => updateTypography("readingLineHeight", value)} />
            </fieldset>
            <fieldset className="theme-section"><legend>Shape & spacing</legend>
              <Range label="Rounded corners" value={config.radius} min={0} max={20} unit="px" change={(radius) => setConfig((current) => ({ ...current, radius }))} />
              <Range label="Interface spacing" value={config.spacing} min={0.8} max={1.3} step={0.05} unit="×" change={(spacing) => setConfig((current) => ({ ...current, spacing }))} />
            </fieldset>
            <fieldset className="theme-section"><legend>Story maps</legend><div className="theme-colors">{(["mapBackground", "mapEdge", "mapSelection", "character", "location", "faction", "object"] as ThemeColor[]).map((key) => <ColorField key={key} colorKey={key} value={config.colors[key]} change={(value) => setConfig((current) => ({ ...current, colors: { ...current.colors, [key]: value } }))} />)}</div></fieldset>
          </fieldset>
          {error && <p className="error" role="alert">{error}</p>}
          {notice && <p className="success-note" role="status"><Check size={16} />{notice}</p>}
          <div className="theme-save-bar"><button className="primary" disabled={busy || (id !== null && !dirty)}><Save size={16} />{busy ? "Saving…" : "Save theme"}</button><button type="button" className="secondary" disabled={busy || !dirty} onClick={() => { setName(baseline.name); setConfig(baseline.config); setError(""); }}><RotateCcw size={15} />Revert changes</button><button className="secondary theme-preview-jump" type="button" onClick={() => document.getElementById("theme-preview")?.scrollIntoView()}>View preview</button></div>
          <div className="theme-management"><button type="button" className="text-button" disabled={busy} onClick={() => { setId(null); setName(`${name.slice(0, 75)} copy`); setNotice(""); setDeleting(false); }}><Copy size={15} />Duplicate as new</button>{id && <button type="button" className="theme-delete" disabled={busy} onClick={() => setDeleting(!deleting)}><Trash2 size={15} />Delete theme</button>}</div>
          {deleting && <div className="theme-delete-confirm" role="group" aria-label="Confirm theme deletion"><p>Delete “{name}”? Universes using it will return to your default. If it is your default, Lorefold’s original theme will take its place.</p><button className="secondary" type="button" disabled={busy} onClick={() => setDeleting(false)}>Keep theme</button><button className="theme-delete" type="button" disabled={busy} onClick={() => void remove()}>Confirm delete</button></div>}
        </form>
      </section>
      <Preview config={config} />
    </div>
  </section>;
}
