import { ArrowRight, BookOpen, Check, FileCheck } from "lucide-react";
import type { Book } from "../../shared/contracts.js";

export function Cover({ book, small = false }: { book: Book; small?: boolean }) {
  const sample = book.id.startsWith("sample-");
  return (
    <div className={`book-cover ${small ? "small" : ""} ${sample ? "" : "uploaded-cover"}`} aria-hidden="true">
      <span className="cover-series">{sample ? "LOREFOLD ORIGINALS / 001" : "FROM YOUR LIBRARY"}</span>
      <div className="cover-orbit" />
      {sample ? <div className="lighthouse"><i /><i /><i /></div> : <BookOpen className="uploaded-book-symbol" size={48} strokeWidth={1} />}
      <div className="cover-title">{sample ? <>The Lantern<br /><em>at Bellweather</em></> : book.title}</div>
      <span className="cover-footer">{sample ? "A STORY IN THREE CHAPTERS" : book.author}</span>
    </div>
  );
}

export function BookCard({ book, openBook }: { book: Book; openBook: (id: string) => void }) {
  const ready = book.totalChapters > 0;
  return <article className="book-card">
    <button className="cover-button" aria-label={`Open ${book.title}`} onClick={() => openBook(book.id)}>
      <Cover book={book} />
    </button>
    <div className="book-card-body">
      <span className="eyebrow">{ready ? `${book.totalChapters} CHAPTERS` : book.resourceId ? "UPLOADED BOOK" : "BOOK"}</span>
      <h3>{book.title}</h3>
      <p className="book-author">{book.author}</p>
      {book.description && <p className="book-description">{book.description}</p>}
      {ready ? <>
        <div className="progress-label">
          <span>{book.completedChapter ? `Chapter ${book.completedChapter} of ${book.totalChapters} completed` : "A new story awaits"}</span>
          <span>{Math.round(book.completedChapter / book.totalChapters * 100)}%</span>
        </div>
        <progress value={book.completedChapter} max={book.totalChapters} />
      </> : <p className="upload-pending">{book.resourceId ? "Your original file is saved. Chapter extraction and analysis are not available yet." : "No source file has been added to this book yet."}</p>}
      <button className="primary wide" onClick={() => openBook(book.id)}>
        {ready ? book.completedChapter ? "Continue exploring" : "Open book" : "View book"}<ArrowRight size={17} />
      </button>
      <span className="analysis-note">{ready ? <Check size={13} /> : <FileCheck size={13} />}
        {ready ? `${book.analyzedChapters}/${book.totalChapters} chapters analyzed · separate from reading progress` : book.resourceId ? "Original file available to download" : "Waiting for source material"}
      </span>
    </div>
  </article>;
}
