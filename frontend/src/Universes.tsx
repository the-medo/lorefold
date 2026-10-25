import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronRight, Download, FileText, Globe2, Library, Plus, Search, Upload, X } from "lucide-react";
import type { Book, Universe, UniverseWorkspace } from "../../shared/contracts.js";
import { api } from "./api.js";
import { UniverseMap } from "./UniverseMap.js";
import { BookCard } from "./Books.js";

function ErrorNote({ error }: { error: string }) {
  return error ? <p className="error" role="alert">{error}</p> : null;
}
function Modal({ title, close, children, busy = false }: { title: string; close: () => void; children: ReactNode; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className="editor-dialog" aria-labelledby="dialog-title"
    onCancel={(event) => { event.preventDefault(); if (!busy) close(); }}>
    <div className="dialog-heading"><h2 id="dialog-title">{title}</h2>
      <button className="icon-button" aria-label="Close dialog" onClick={close} disabled={busy}><X size={19} /></button>
    </div>{children}
  </dialog>;
}
function CreateUniverse({ close, created }: { close: () => void; created: (id: string) => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      const { universe } = await api<{ universe: Universe }>("/universes", { method: "POST", body: JSON.stringify({ name: form.get("name"), description: form.get("description") }) });
      created(universe.id);
    } catch (error) { setError((error as Error).message); setBusy(false); }
  }
  return <Modal title="Create a universe" close={close} busy={busy}>
    <p className="muted">A home for the books and sources that share a world.</p>
    <form className="editor-form" onSubmit={submit}>
      <label>Universe name<input name="name" autoFocus required maxLength={120} placeholder="e.g. Star Wars or Middle-earth" /></label>
      <label>Description <span className="muted">(optional)</span><textarea name="description" maxLength={2000} rows={3} placeholder="What connects the stories in this universe?" /></label>
      <ErrorNote error={error} />
      <div className="form-actions"><button type="button" className="secondary" onClick={close} disabled={busy}>Cancel</button>
        <button className="primary" disabled={busy}>{busy ? "Creating…" : "Create universe"}<ArrowRight size={16} /></button>
      </div>
    </form>
  </Modal>;
}
export function UniversesPage({ navigate }: { navigate: (path: string) => void }) {
  const [universes, setUniverses] = useState<Universe[] | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setError("");
    api<{ universes: Universe[] }>("/universes", { signal: controller.signal }).then((r) => setUniverses(r.universes))
      .catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [revision]);
  const matches = universes?.filter((u) => `${u.name} ${u.description}`.toLowerCase().includes(search.toLowerCase()));
  return <main className="library-page universes-page">
    <div className="section-toolbar collection-toolbar"><h1>Your universes <span className="count">{universes?.length ?? "—"}</span></h1>
      <div className="collection-actions">
        <label className="search"><Search size={17} /><input aria-label="Search universes" placeholder="Find a world…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <button className="primary" onClick={() => setCreating(true)}><Plus size={17} />Create universe</button>
      </div>
    </div>
    {error ? <><ErrorNote error={error} /><button className="secondary" onClick={() => setRevision((n) => n + 1)}>Try again</button></>
      : !universes ? <p role="status" className="loading">Opening your universes…</p>
      : <div className="universe-grid">
        {matches?.map((universe, index) => <button className="universe-card" key={universe.id} onClick={() => navigate(`/universes/${encodeURIComponent(universe.id)}`)}>
          <div className={`universe-art world-${index % 3}`} aria-hidden="true"><span className="world-orbit" /><span className="world-moon" /><span className="world-hills" /><Globe2 size={25} strokeWidth={1} /></div>
          <div className="universe-card-body"><h2>{universe.name}</h2><p>{universe.description || "A new world, ready for your stories."}</p>
            <div className="universe-card-footer"><span><BookOpen size={14} />{universe.bookCount} {universe.bookCount === 1 ? "book" : "books"}</span><span><FileText size={14} />{universe.resourceCount} {universe.resourceCount === 1 ? "resource" : "resources"}</span><ArrowRight size={18} /></div>
          </div>
        </button>)}
        {!search && <button className="create-universe-card" onClick={() => setCreating(true)}><span><Plus size={26} /></span><strong>A world of your own</strong><p>Create a universe and start collecting its stories.</p></button>}
        {search && !matches?.length && <div className="empty"><Globe2 size={32} /><h2>No universes found.</h2><p>Try another name or create a new universe.</p></div>}
      </div>}
    <div className="universe-footnote"><Globe2 size={20} /><p>Universes bring related sources together. <button className="inline-link" onClick={() => navigate("/library")}>My library</button> keeps all your books in one place.</p></div>
    {creating && <CreateUniverse close={() => setCreating(false)} created={(id) => navigate(`/universes/${encodeURIComponent(id)}`)} />}
  </main>;
}

function UploadResource({ universeId, close, saved }: { universeId: string; close: () => void; saved: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState("book");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    if (!file || !file.size) { setError("Choose a nonempty file to upload."); return; }
    if (file.size > 25 * 1024 * 1024) { setError("Files can be up to 25 MB."); return; }
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try { await api(`/universes/${encodeURIComponent(universeId)}/resources`, { method: "POST", body: form }); saved(); }
    catch (error) { setError((error as Error).message); setBusy(false); }
  }
  return <Modal title="Upload a resource" close={close} busy={busy}>
    <p className="muted">Add a book or a reference document to this universe.</p>
    <form className="editor-form" onSubmit={submit}>
      <label>Resource type<select name="kind" value={kind} onChange={(e) => { setKind(e.target.value); setFile(null); }}><option value="book">Book</option><option value="document">Reference document</option></select></label>
      <label className="file-picker"><Upload size={27} /><strong>{file?.name ?? "Choose a file"}</strong>
        <span>{kind === "book" ? "EPUB, PDF, TXT, or Markdown" : "PDF, TXT, or Markdown"} · up to 25 MB</span>
        <input key={kind} aria-label="File to upload" type="file" name="file" required accept={kind === "book" ? ".epub,.pdf,.txt,.md" : ".pdf,.txt,.md"} onChange={(e) => {
          const chosen = e.target.files?.[0] ?? null; setFile(chosen);
          if (chosen && !title) setTitle(chosen.name.replace(/\.[^.]+$/, "").slice(0, 200));
        }} />
      </label>
      <label>Title<input name="title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} /></label>
      {kind === "book" && <label>Author <span className="muted">(optional)</span><input name="author" maxLength={200} /></label>}
      <p className="upload-explanation">Your original file will be saved privately. Chapter extraction and AI analysis are not available yet.</p>
      <ErrorNote error={error} />
      <div className="form-actions"><button type="button" className="secondary" disabled={busy} onClick={close}>Cancel</button><button className="primary" disabled={busy}>{busy ? "Uploading…" : "Upload resource"}<Upload size={16} /></button></div>
    </form>
  </Modal>;
}
function AddFromLibrary({ universeId, close, saved }: { universeId: string; close: () => void; saved: () => void }) {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api<{ books: Book[] }>("/books", { signal: controller.signal }).then((r) => setBooks(r.books.filter((b) => !b.universeId)))
      .catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try { await api(`/universes/${encodeURIComponent(universeId)}/books`, { method: "POST", body: JSON.stringify({ bookId: new FormData(event.currentTarget).get("bookId") }) }); saved(); }
    catch (error) { setError((error as Error).message); setBusy(false); }
  }
  return <Modal title="Add from My library" close={close} busy={busy}>
    <p className="muted">Choose a book that doesn’t belong to a universe yet.</p>
    <form className="editor-form" onSubmit={submit}>
      {books?.length ? <label>Book<select name="bookId" required>{books.map((book) => <option key={book.id} value={book.id}>{book.title}</option>)}</select></label>
        : <p>{books ? "All your books already have a universe. You can upload a new book instead." : "Loading your books…"}</p>}
      <ErrorNote error={error} /><div className="form-actions"><button type="button" className="secondary" onClick={close} disabled={busy}>Cancel</button><button className="primary" disabled={busy || !books?.length}>{busy ? "Adding…" : "Add book"}</button></div>
    </form>
  </Modal>;
}
export function UniversePage({ id, navigate }: { id: string; navigate: (path: string) => void }) {
  const [data, setData] = useState<UniverseWorkspace | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [modal, setModal] = useState<"upload" | "library" | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setError(""); setData(null);
    api<UniverseWorkspace>(`/universes/${encodeURIComponent(id)}`, { signal: controller.signal }).then(setData)
      .catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [id, revision]);
  const saved = () => { setNotice(modal === "upload" ? "Resource uploaded. Your original file is saved." : "Book added to this universe."); setModal(null); setRevision((n) => n + 1); };
  const documents = data?.resources.filter((r) => r.kind === "document") ?? [];
  return <main className="library-page universe-page">
    <div className="universe-toolbar">
      <div className="universe-breadcrumb">
        <button className="back-link" onClick={() => navigate("/")}><ArrowLeft size={16} />Universes</button>
        {data && <><ChevronRight size={14} aria-hidden="true" /><h1>{data.universe.name}</h1></>}
      </div>
      {data && <button className="primary" aria-label="Upload resource" onClick={() => setModal("upload")}><Upload size={17} />Upload</button>}
    </div>
    <ErrorNote error={error} />
    {error && <button className="secondary" onClick={() => setRevision((n) => n + 1)}>Try again</button>}
    {!data ? !error && <p className="loading" role="status">Opening this universe…</p> : <>
      {notice && <p className="success-note" role="status"><Check size={16} />{notice}</p>}
      <UniverseMap key={data.universe.id} data={data} />
      <div className="section-toolbar"><h2>Books <span className="count">{data.books.length}</span></h2><button className="text-button" onClick={() => setModal("library")}><Library size={16} />Add from My library</button></div>
      {data.books.length ? <div className="books-grid">{data.books.map((book) => <BookCard key={book.id} book={book} openBook={(id) => navigate(`/books/${encodeURIComponent(id)}`)} />)}</div>
        : <div className="collection-empty"><BookOpen size={28} /><div><h3>The first story starts here.</h3><p>Upload a book or add one from your library.</p></div><button className="secondary" onClick={() => setModal("upload")}>Upload a book</button></div>}
      <div className="section-toolbar"><h2>Other resources <span className="count">{documents.length}</span></h2></div>
      {documents.length ? <div className="resource-list">{documents.map((resource) => <article className="resource-row" key={resource.id}><span className="resource-icon"><FileText size={23} /></span><div><h3>{resource.title}</h3><p>{resource.filename} · {resource.byteSize < 1024 * 1024 ? `${Math.max(1, Math.round(resource.byteSize / 1024))} KB` : `${(resource.byteSize / 1024 / 1024).toFixed(1)} MB`} · Uploaded</p></div><a className="secondary download-link" href={`/api/resources/${resource.id}/download`} aria-label={`Download ${resource.title}`}><Download size={16} />Download</a></article>)}</div>
        : <div className="collection-empty"><FileText size={28} /><div><h3>A place for the bigger picture.</h3><p>Add notes, guides, or other reference documents.</p></div></div>}
    </>}
    {modal === "upload" && <UploadResource universeId={id} close={() => setModal(null)} saved={saved} />}
    {modal === "library" && <AddFromLibrary universeId={id} close={() => setModal(null)} saved={saved} />}
  </main>;
}
