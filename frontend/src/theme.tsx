import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { defaultTheme, resolveTheme, themeFonts, type ThemeConfig, type ThemeLibrary } from "../../shared/themes.js";
import { api } from "./api.js";

const ConfigContext = createContext<ThemeConfig>(defaultTheme);
const LibraryContext = createContext<{ library: ThemeLibrary; refresh: () => void } | null>(null);
export const useTheme = () => useContext(ConfigContext);
export function useThemes() {
  const value = useContext(LibraryContext);
  if (!value) throw new Error("Theme library is unavailable.");
  return value;
}
export function themeVariables(config: ThemeConfig): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(config.colors).map(([key, value]) => [`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value])),
    "--font-body": themeFonts[config.typography.body].family,
    "--font-heading": themeFonts[config.typography.heading].family,
    "--font-reading": themeFonts[config.typography.reading].family,
    "--ui-size": `${config.typography.size}px`, "--reading-size": `${config.typography.readingSize}px`,
    "--reading-line-height": String(config.typography.readingLineHeight),
    "--radius": `${config.radius}px`, "--spacing": String(config.spacing), "color-scheme": config.mode,
  };
}
export function applyDocumentTheme(config: ThemeConfig) {
  for (const [name, value] of Object.entries(themeVariables(config))) document.documentElement.style.setProperty(name, value);
}
export function ThemeSurface({ config, children }: { config: ThemeConfig; children: ReactNode }) {
  const variables = themeVariables(config);
  delete variables["color-scheme"];
  return <ConfigContext.Provider value={config}><div className="theme-surface" style={{ ...variables, colorScheme: config.mode } as CSSProperties}>{children}</div></ConfigContext.Provider>;
}

export function ThemeProvider({ path, children }: { path: string; children: ReactNode }) {
  const pathname = new URL(path, window.location.origin).pathname;
  const endpoint = useMemo(() => {
    const universe = pathname.match(/^\/universes\/([^/]+)$/);
    const book = pathname.match(/^\/books\/([^/]+)$/);
    const params = new URLSearchParams();
    if (universe) params.set("universeId", decodeURIComponent(universe[1]));
    if (book) params.set("bookId", decodeURIComponent(book[1]));
    return `/themes?${params}`;
  }, [pathname]);
  const [state, setState] = useState<{ endpoint: string; library: ThemeLibrary } | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<ThemeLibrary>(endpoint, { signal: controller.signal }).then((library) => {
      if (!controller.signal.aborted) setState({ endpoint, library });
    }).catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [endpoint, revision]);
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  const library = state?.endpoint === endpoint ? state.library : null;
  // Keep the previous palette on the loading screen instead of flashing light
  // between dark universes. Route content waits for its authorized context.
  const config = useMemo(() => state ? resolveTheme(state.library) : defaultTheme, [state]);
  useLayoutEffect(() => {
    applyDocumentTheme(config);
    return () => applyDocumentTheme(defaultTheme);
  }, [config]);
  if (!library) return <div className="loading">{error ? <div><p role="alert">{error}</p><button className="secondary" onClick={refresh}>Try again</button><a href="/">Back to universes</a></div> : <p role="status">Opening your space…</p>}</div>;
  return <LibraryContext.Provider value={{ library, refresh }}><ConfigContext.Provider value={config}>
    {error && <p className="error" role="alert">Theme settings could not be refreshed. <button onClick={refresh}>Try again</button></p>}
    {children}
  </ConfigContext.Provider></LibraryContext.Provider>;
}

export function ThemePicker({ universeId }: { universeId?: string }) {
  const { library, refresh } = useThemes();
  const value = universeId ? library.universeThemes.find((entry) => entry.universeId === universeId)?.themeId ?? "" : library.defaultThemeId ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function change(themeId: string) {
    setBusy(true); setError("");
    try {
      await api(universeId ? `/universes/${encodeURIComponent(universeId)}/theme` : "/preferences/theme", {
        method: "PUT", body: JSON.stringify({ themeId: themeId || null }),
      });
      refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="theme-picker"><label>{universeId ? "Universe theme" : "Main page & library"}
    <select aria-label={universeId ? "Universe theme" : "Main page & library"} value={value} disabled={busy} onChange={(event) => void change(event.target.value)}>
      <option value="">{universeId ? "Use my default theme" : "Lorefold default"}</option>
      {library.themes.map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
    </select></label>{error && <p role="alert" className="error">{error}</p>}
  </div>;
}
