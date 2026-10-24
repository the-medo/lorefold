import {
  StrictMode,
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  Compass,
  Download,
  Globe2,
  Library,
  LockKeyhole,
  LogOut,
  Network,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type {
  Book,
  EntityKind,
  GraphMode,
  Workspace,
} from "../../shared/contracts.js";
import { api } from "./api.js";
import { EntityDetails } from "./EntityDetails.js";
import { GraphBoundary } from "./GraphBoundary.js";
import { entityColors } from "./graph-theme.js";
import { BookCard, Cover } from "./Books.js";
import { UniversesPage, UniversePage } from "./Universes.js";
import "./style.css";

const StoryGraph = lazy(() => import("./Graph.js").then((module) => ({ default: module.StoryGraph })));

type User = { name: string; email: string };
function Brand() {
  return (
    <span className="brand">
      <span className="brand-icon">
        <img src="/brand/lorefold.svg" alt="" width={36} height={36} />
      </span>
      lorefold<span className="brand-dot">.</span>
    </span>
  );
}
function ErrorMessage({ message }: { message: string }) {
  return (
    <p role="alert" className="error">
      {message}
    </p>
  );
}
function Loading() {
  return (
    <div className="loading" role="status">
      <span className="loading-dot" /> Opening your story…
    </div>
  );
}

function SignIn({ onSignIn }: { onSignIn: () => void }) {
  const [error, setError] = useState(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    if (!code) return "";
    if (code === "access_denied") return "Google sign-in was cancelled. Try again or use email.";
    if (code === "signup_disabled" || code === "account_not_linked") return "Use the Google account with the same email as your Lorefold invitation, or sign in with email.";
    if (code === "google_email_unverified") return "Use a Google account with a verified email address, or sign in with email.";
    return "Google sign-in could not be completed. Please try again or use email.";
  });
  const [busy, setBusy] = useState<"email" | "google" | null>(null);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api<{ google: boolean }>("/auth/providers", { signal: controller.signal })
      .then((providers) => setGoogleEnabled(providers.google))
      .catch(() => { /* Email remains available if provider discovery fails. */ });
    return () => controller.abort();
  }, []);
  async function signInWithGoogle() {
    setBusy("google");
    setError("");
    try {
      const result = await api<{ url: string }>("/auth/sign-in/social", {
        method: "POST",
        body: JSON.stringify({
          provider: "google",
          callbackURL: "/",
          errorCallbackURL: "/sign-in",
          disableRedirect: true,
        }),
      });
      window.location.assign(result.url);
    } catch {
      setError("Google sign-in could not be started. Please try again or use email.");
      setBusy(null);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("email");
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await api("/auth/sign-in/email", {
        method: "POST",
        body: JSON.stringify({
          email: form.get("email"),
          password: form.get("password"),
        }),
      });
      onSignIn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="signin-page">
      <section className="signin-story">
        <Brand />
        <div>
          <span className="eyebrow">YOUR STORY, UNFOLDING</span>
          <h1>
            Every story leaves
            <br />a thread.
          </h1>
          <p>
            Find your way back to the people, places, and moments that matter.
            One chapter at a time.
          </p>
          <div className="thread-art" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
        <span className="quiet">
          A little less remembering. A little more wonder.
        </span>
      </section>
      <section className="signin-form">
        <div className="signin-box">
          <span className="eyebrow">A PLACE FOR YOUR STORIES</span>
          <h2>Welcome back.</h2>
          <p className="muted">Sign in to your private reading space.</p>
          {googleEnabled && <div className="social-signin">
            <button type="button" className="google-signin" onClick={signInWithGoogle} disabled={busy !== null}>
              <svg aria-hidden="true" width="20" height="20" viewBox="0 0 48 48">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z" />
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65Z" />
                <path fill="#FBBC05" d="M10.53 28.59A14.41 14.41 0 0 1 9.75 24c0-1.59.27-3.13.78-4.59l-7.98-6.19A23.87 23.87 0 0 0 0 24c0 3.87.93 7.53 2.56 10.78l7.97-6.19Z" />
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.91-5.8l-7.73-6c-2.15 1.45-4.92 2.3-8.18 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z" />
              </svg>
              {busy === "google" ? "Opening Google…" : "Continue with Google"}
            </button>
            <div className="signin-divider">or use email</div>
          </div>}
          {error && <ErrorMessage message={error} />}
          <form onSubmit={submit}>
            <label>
              Email address
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
                placeholder="you@example.com"
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                placeholder="Your password"
              />
            </label>
            <button className="primary wide" disabled={busy !== null}>
              {busy === "email" ? "Signing in…" : "Open my space"}
              <ArrowRight size={17} />
            </button>
          </form>
          <p className="private-note">
            <LockKeyhole size={14} /> A private library. Access is by
            invitation.
          </p>
        </div>
      </section>
    </div>
  );
}

function LibraryPage({ openBook }: { openBook: (id: string) => void }) {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<{ books: Book[] }>("/books", { signal: controller.signal })
      .then((r) => setBooks(r.books))
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [attempt]);
  const matching = books?.filter((b) =>
    `${b.title} ${b.author}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <main className="library-page">
      <div className="page-intro">
        <span className="eyebrow">YOUR LIBRARY</span>
        <h1>Pick up the thread.</h1>
        <p className="muted">
          A familiar world is waiting. Return right where you left off.
        </p>
      </div>
      <div className="section-toolbar">
        <h2>
          Your books <span className="count">{books?.length ?? "—"}</span>
        </h2>
        <label className="search">
          <Search size={17} />
          <input
            aria-label="Search your library"
            placeholder="Find a story…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>
      {error ? (
        <div>
          <ErrorMessage message={error} />
          <button
            className="secondary"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Try again
          </button>
        </div>
      ) : !books ? (
        <Loading />
      ) : (
        <>
          <div className="books-grid">
            {matching?.map((book) => (
              <BookCard key={book.id} book={book} openBook={openBook} />
            ))}
          </div>
          {!matching?.length && (
            <div className="empty">
              <BookOpen size={32} />
              <h2>
                {books.length
                  ? "No stories found."
                  : "Your next chapter starts here."}
              </h2>
              <p>
                {books.length
                  ? "Try a different title or author."
                  : "Your library is empty. Open Universes to add your first book."}
              </p>
            </div>
          )}
        </>
      )}
      <div className="library-footnote">
        <ShieldCheck size={21} />
        <div>
          <strong>Only as far as you’ve read.</strong>
          <p>
            Your reading progress sets the boundary. The rest of the story stays
            a mystery.
          </p>
        </div>
        <span className="sample-badge">CHAPTER BY CHAPTER</span>
      </div>
    </main>
  );
}

function BookPage({
  bookId,
  chapter,
  navigate,
}: {
  bookId: string;
  chapter?: number;
  navigate: (path: string) => void;
}) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<GraphMode>("story");
  const [tab, setTab] = useState<"recap" | "graph">("recap");
  const [selected, setSelected] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<EntityKind | "all">("all");
  useEffect(() => {
    const controller = new AbortController();
    setWorkspace(null);
    setSelected(null);
    setError("");
    const params = new URLSearchParams({ mode });
    if (chapter !== undefined) params.set("chapter", String(chapter));
    api<Workspace>(`/books/${encodeURIComponent(bookId)}/workspace?${params}`, {
      signal: controller.signal,
    })
      .then((data) => {
        setWorkspace(data);
        setProgress(data.book.completedChapter);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [bookId, chapter, mode, revision]);
  // Re-read the cutoff when returning from another tab; do not retain stale knowledge.
  useEffect(() => {
    const refresh = () => setRevision((r) => r + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const visible = useMemo(() => {
    const entities =
      workspace?.graph.entities.filter(
        (e) =>
          (kind === "all" || e.kind === kind) &&
          `${e.label} ${e.aliases.join(" ")}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ) ?? [];
    const ids = new Set(entities.map((e) => e.id));
    return {
      entities,
      relationships:
        workspace?.graph.relationships.filter(
          (e) => ids.has(e.source) && ids.has(e.target),
        ) ?? [],
    };
  }, [workspace, search, kind]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    setSelected(null);
    try {
      await api(`/books/${encodeURIComponent(bookId)}/progress`, {
        method: "PATCH",
        body: JSON.stringify({ completedChapter: progress }),
      });
      setWorkspace(null);
      setNotice("Reading progress saved.");
      navigate(`/books/${encodeURIComponent(bookId)}?chapter=${progress}`);
      setRevision((r) => r + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  if (!workspace)
    return (
      <main className="workspace-loading">
        <button className="back-link" onClick={() => navigate("/library")}>
          <ArrowLeft size={16} /> Your library
        </button>
        {error ? (
          <>
            <ErrorMessage message={error} />
            <button
              className="secondary"
              onClick={() => setRevision((r) => r + 1)}
            >
              Try again
            </button>
          </>
        ) : (
          <Loading />
        )}
      </main>
    );
  if (workspace.book.totalChapters === 0) return (
    <main className="library-page pending-book-page">
      <button className="back-link" onClick={() => navigate(workspace.book.universeId ? `/universes/${encodeURIComponent(workspace.book.universeId)}` : "/library")}><ArrowLeft size={16} />{workspace.book.universeId ? "Back to universe" : "Your library"}</button>
      <div className="pending-book"><Cover book={workspace.book} /><div className="page-intro">
        <span className="eyebrow">{workspace.book.resourceId ? "UPLOADED BOOK" : "BOOK"}</span><h1>{workspace.book.title}</h1><p className="muted">{workspace.book.author}</p>
        <h2>{workspace.book.resourceId ? "Your book is saved." : "No source file yet."}</h2><p>{workspace.book.resourceId ? "Chapter extraction and AI analysis are not available yet. Your original file is ready to download whenever you need it." : "This book is in your library, but no source file or chapters have been added yet."}</p>
        {workspace.book.resourceId && <a className="primary download-link" href={`/api/resources/${workspace.book.resourceId}/download`}><Download size={17} />Download original</a>}
      </div></div>
    </main>
  );
  const entity = workspace.graph.entities.find((e) => e.id === selected);
  return (
    <main className="book-page">
      <div className="book-topbar">
        <button className="back-link" onClick={() => navigate("/library")}>
          <ArrowLeft size={16} /> Your library
        </button>
        <span className="crumb">
          <span>/</span>
          {workspace.book.title}
        </span>
        <span className="spoiler-pill">
          <ShieldCheck size={14} /> Spoiler-safe through chapter{" "}
          {workspace.cutoff}
        </span>
      </div>
      <div className="workspace-layout">
        <aside className="chapter-sidebar">
          <div className="mini-book">
            <Cover book={workspace.book} small />
            <div>
              <span className="eyebrow">YOUR CURRENT STORY</span>
              <h2>{workspace.book.title}</h2>
              <span className="muted">{workspace.book.author}</span>
            </div>
          </div>
          <form className="progress-editor" onSubmit={save}>
            <label htmlFor="finished">I’ve finished</label>
            <div>
              <select
                id="finished"
                value={progress}
                onChange={(e) => setProgress(Number(e.target.value))}
              >
                <option value={0}>Not started</option>
                {workspace.chapters.map((c) => (
                  <option key={c.number} value={c.number}>
                    Chapter {c.number}
                  </option>
                ))}
              </select>
              <button
                className="primary"
                disabled={
                  saving || progress === workspace.book.completedChapter
                }
              >
                {saving ? "…" : "Save"}
              </button>
            </div>
            <p>This sets your spoiler boundary.</p>
          </form>
          <div className="chapter-list-heading">
            <span className="eyebrow">CHAPTERS</span>
            <span>
              {workspace.book.completedChapter}/{workspace.book.totalChapters}{" "}
              read
            </span>
          </div>
          <nav className="chapter-list" aria-label="Book chapters">
            {workspace.chapters.map((c) => (
              <button
                key={c.number}
                disabled={c.number > workspace.book.completedChapter}
                className={c.number === workspace.cutoff ? "active" : ""}
                onClick={() => {
                  setSelected(null);
                  navigate(
                    `/books/${encodeURIComponent(bookId)}?chapter=${c.number}`,
                  );
                }}
              >
                <span className="chapter-number">
                  {c.number > workspace.book.completedChapter ? (
                    <LockKeyhole size={14} />
                  ) : (
                    c.number.toString().padStart(2, "0")
                  )}
                </span>
                <span>
                  <strong>Chapter {c.number}</strong>
                  <small>
                    {c.title ??
                      (c.number <= workspace.book.completedChapter
                        ? "Browse chapter"
                        : "Waiting to unfold")}
                  </small>
                </span>
                {c.number === workspace.cutoff && <ChevronRight size={15} />}
              </button>
            ))}
          </nav>
          <div className="sidebar-note">
            <Sparkles size={17} />
            <p>
              {workspace.book.analyzedChapters}/{workspace.book.totalChapters}{" "}
              chapters analyzed.
              <br />
              Your reading progress is yours to set.
            </p>
          </div>
        </aside>
        <section className="workspace-main">
          {error && <ErrorMessage message={error} />}
          <span className="sr-only" role="status">
            {notice}
          </span>
          {workspace.cutoff === 0 ? (
            <div className="empty start-story">
              <Compass size={46} />
              <span className="eyebrow">
                THE STORY IS STILL YOURS TO DISCOVER
              </span>
              <h1>Begin at the beginning.</h1>
              <p>
                Set the last chapter you’ve finished to reveal its recap and
                connections.
              </p>
              <p className="muted">
                Exploring the sample? Choose Chapter 1 under “I’ve finished” and
                save.
              </p>
            </div>
          ) : (
            <>
              <div className="chapter-title">
                <span className="eyebrow">
                  CHAPTER {String(workspace.cutoff).padStart(2, "0")}{" "}
                  <span className="eyebrow-divider">/</span>{" "}
                  {workspace.book.totalChapters}
                </span>
                <h1>
                  {workspace.chapter?.title ?? "Chapter analysis pending"}
                </h1>
                <p className="muted">
                  A moment to remember. A world to reconnect.
                </p>
              </div>
              <div className="view-tabs" role="tablist" aria-label="Book views">
                <button
                  role="tab"
                  aria-selected={tab === "recap"}
                  className={tab === "recap" ? "active" : ""}
                  onClick={() => setTab("recap")}
                >
                  <BookOpen size={17} /> Recap
                </button>
                <button
                  role="tab"
                  aria-selected={tab === "graph"}
                  className={tab === "graph" ? "active" : ""}
                  onClick={() => setTab("graph")}
                >
                  <Network size={17} /> Story map
                </button>
              </div>
              {tab === "recap" ? (
                <div className="recap" role="tabpanel" aria-label="Recap">
                  <span className="eyebrow">THE CHAPTER, REVISITED</span>
                  <p className="recap-text">
                    {workspace.chapter?.recap ??
                      "This chapter has not been analyzed yet."}
                  </p>
                  {workspace.chapter && (
                    <>
                      <h3>What moved the story forward</h3>
                      <ul className="developments">
                        {workspace.chapter.developments.map((text, i) => (
                          <li key={text}>
                            <span>{String(i + 1).padStart(2, "0")}</span>
                            {text}
                          </li>
                        ))}
                      </ul>
                      <details className="source-chapter">
                        <summary>
                          Read the original sample chapter
                          <BookOpen size={15} />
                        </summary>
                        <p>{workspace.chapter.text}</p>
                      </details>
                    </>
                  )}
                  <div className="recap-map-link">
                    <Network size={22} />
                    <div>
                      <strong>Follow the connections.</strong>
                      <p>See how this corner of the story fits together.</p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => setTab("graph")}
                    >
                      Open map <ArrowRight size={16} />
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  className="graph-panel"
                  role="tabpanel"
                  aria-label="Story map"
                >
                  <div className="graph-toolbar">
                    <div className="segmented" aria-label="Graph scope">
                      <button
                        aria-pressed={mode === "chapter"}
                        className={mode === "chapter" ? "active" : ""}
                        onClick={() => setMode("chapter")}
                      >
                        This chapter
                      </button>
                      <button
                        aria-pressed={mode === "story"}
                        className={mode === "story" ? "active" : ""}
                        onClick={() => setMode("story")}
                      >
                        Story so far
                      </button>
                    </div>
                    <label className="search">
                      <Search size={16} />
                      <input
                        aria-label="Search story map"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Find someone or somewhere…"
                      />
                    </label>
                  </div>
                  <div className="entity-filters" aria-label="Entity type">
                    {(
                      [
                        "all",
                        "character",
                        "location",
                        "faction",
                        "object",
                      ] as const
                    ).map((value) => (
                      <button
                        key={value}
                        aria-pressed={kind === value}
                        className={kind === value ? "active" : ""}
                        onClick={() => setKind(value)}
                      >
                        {value !== "all" && (
                          <i style={{ background: entityColors[value] }} />
                        )}
                        {
                          {
                            all: "All",
                            character: "Characters",
                            location: "Locations",
                            faction: "Factions",
                            object: "Objects",
                          }[value]
                        }
                      </button>
                    ))}
                  </div>
                  <GraphBoundary>
                  <Suspense fallback={<div className="graph-wrap loading" role="status">Opening the 3D map…</div>}>
                  <StoryGraph
                    entities={visible.entities}
                    relationships={visible.relationships}
                    selectedId={selected}
                    onSelect={setSelected}
                  />
                  </Suspense>
                  </GraphBoundary>
                  <div className="graph-caption">
                    <span>
                      {visible.entities.length} entities ·{" "}
                      {visible.relationships.length} connections
                    </span>
                    <span>Select a node to see its story</span>
                  </div>
                  <div className="entity-list" aria-label="Map entities">
                    {visible.entities.map((e) => (
                      <button
                        key={e.id}
                        className={e.id === selected ? "active" : ""}
                        onClick={() => setSelected(e.id)}
                      >
                        <i style={{ background: entityColors[e.kind] }} />
                        {e.label}
                        <ChevronRight size={13} />
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="workspace-footer">
                <ShieldCheck size={15} />
                <span>
                  Everything here is known by chapter {workspace.cutoff}.
                  Browsing doesn’t change your progress.
                </span>
              </div>
            </>
          )}
        </section>
        {entity && (
          <EntityDetails
            entity={entity}
            graph={workspace.graph}
            cutoff={workspace.cutoff}
            close={() => setSelected(null)}
          />
        )}
      </div>
    </main>
  );
}

function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [path, setPath] = useState(
    window.location.pathname + window.location.search,
  );
  const [authRevision, setAuthRevision] = useState(0);
  useEffect(() => {
    const handler = () =>
      setPath(window.location.pathname + window.location.search);
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);
  useEffect(() => {
    let cancelled = false;
    setError("");
    api<{ user: User } | null>("/auth/get-session")
      .then((session) => {
        if (!cancelled) setUser(session?.user ?? null);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [authRevision]);
  function navigate(target: string) {
    window.history.pushState({}, "", target);
    setPath(target);
  }
  async function signOut() {
    try {
      await api("/auth/sign-out", { method: "POST", body: "{}" });
      setUser(null);
      navigate("/");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (user === undefined)
    return error ? (
      <div className="loading">
        <ErrorMessage message={error} />
        <button
          className="secondary"
          onClick={() => setAuthRevision((r) => r + 1)}
        >
          Try again
        </button>
      </div>
    ) : (
      <Loading />
    );
  if (!user) return <SignIn onSignIn={() => setAuthRevision((r) => r + 1)} />;
  const url = new URL(path, window.location.origin);
  const bookMatch = url.pathname.match(/^\/books\/([^/]+)$/);
  const universeMatch = url.pathname.match(/^\/universes\/([^/]+)$/);
  const inLibrary = url.pathname === "/library" || !!bookMatch;
  const chapter = url.searchParams.has("chapter")
    ? Number(url.searchParams.get("chapter"))
    : undefined;
  return (
    <div className="app-shell">
      <header className="app-header">
        <button
          className="brand-button"
          aria-label="Lorefold universes"
          onClick={() => navigate("/")}
        >
          <Brand />
        </button>
        <nav aria-label="Main navigation">
          <button className={`header-nav ${!inLibrary ? "active" : ""}`} aria-current={!inLibrary ? "page" : undefined} onClick={() => navigate("/")}>
            <Globe2 size={17} /> Universes
          </button>
          <button className={`header-nav ${inLibrary ? "active" : ""}`} aria-current={inLibrary ? "page" : undefined} onClick={() => navigate("/library")}>
            <Library size={17} /> My library
          </button>
        </nav>
        <div className="header-user">
          <span className="private-label">
            <LockKeyhole size={13} /> Private space
          </span>
          <span className="avatar" title={user.name}>
            {user.name.charAt(0).toUpperCase()}
          </span>
          <button
            className="icon-button"
            aria-label="Sign out"
            onClick={signOut}
          >
            <LogOut size={17} />
          </button>
        </div>
      </header>
      {error && <ErrorMessage message={error} />}
      {bookMatch ? (
        <BookPage
          key={bookMatch[1]}
          bookId={decodeURIComponent(bookMatch[1])}
          chapter={chapter}
          navigate={navigate}
        />
      ) : universeMatch ? (
        <UniversePage key={universeMatch[1]} id={decodeURIComponent(universeMatch[1])} navigate={navigate} />
      ) : inLibrary ? (
        <LibraryPage openBook={(id) => navigate(`/books/${encodeURIComponent(id)}`)} />
      ) : <UniversesPage navigate={navigate} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
