import { CaretRightIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { docs } from "../content";
import { DocLink } from "./doc-link";

interface Entry {
  slug: string;
  title: string;
  section: string;
  context: string;
  match: string;
}

const ENTRIES: Entry[] = docs.flatMap((doc) => [
  {
    slug: doc.slug,
    title: doc.navTitle ?? doc.title,
    section: "",
    context: doc.description,
    match: `${doc.title} ${doc.description} ${doc.keywords}`.toLowerCase(),
  },
  ...doc.sections.map((section) => ({
    slug: doc.slug,
    title: section.title,
    section: section.id,
    context: doc.navTitle ?? doc.title,
    match: `${section.title} ${doc.title}`.toLowerCase(),
  })),
]);

export function SearchDialog({ dialog }: { dialog: RefObject<HTMLDialogElement | null> }) {
  const [query, setQuery] = useState("");
  const words = query.trim().toLowerCase().split(/\s+/);
  const results = ENTRIES.filter((entry) => words.every((word) => entry.match.includes(word)));
  const close = () => dialog.current?.close();

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        dialog.current?.showModal();
      }
    };

    document.addEventListener("keydown", keyboard);

    return () => document.removeEventListener("keydown", keyboard);
  }, [dialog]);

  return (
    <dialog
      ref={dialog}
      className="search-dialog"
      aria-labelledby="search-title"
      onClose={() => setQuery("")}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="flex items-center gap-3 border-b border-line px-5 py-3">
        <MagnifyingGlassIcon size={17} className="shrink-0 text-muted" />
        <label id="search-title" htmlFor="docs-search" className="sr-only">
          Search documentation
        </label>
        <input
          id="docs-search"
          type="search"
          autoFocus
          autoComplete="off"
          placeholder="Search commands, shards, replicas, limits..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1 border-0 bg-transparent text-sm text-ink outline-none"
        />
        <button type="button" aria-label="Close search" onClick={close} className="rounded p-1 text-muted">
          <XIcon size={15} />
        </button>
      </div>
      <div className="max-h-[50dvh] overflow-y-auto p-2" aria-live="polite">
        <p className="px-3 py-1 text-[10px] text-muted">
          {query.trim() === "" ? "Browse topics or type to search" : `${results.length} matching topics`}
        </p>
        {results.length === 0 && (
          <p className="px-3 py-3 text-sm">No matching topic. Try "replica", "CROSSSLOT" or "deploy".</p>
        )}
        {results.map((result) => (
          <DocLink
            key={`${result.slug}-${result.section}`}
            slug={result.slug}
            hash={result.section === "" ? undefined : result.section}
            onClick={close}
            className="block rounded-md px-3 py-2.5 text-[13px] text-ink no-underline hover:bg-wash focus:bg-wash"
          >
            <span className="flex items-center justify-between gap-3">
              {result.title}
              <CaretRightIcon size={12} className="shrink-0 text-muted" />
            </span>
            <span className="mt-1 block text-[11px] leading-relaxed text-muted">{result.context}</span>
          </DocLink>
        ))}
      </div>
      <div className="flex justify-between border-t border-line px-5 py-2 text-[10px] text-muted">
        <span>Local search. Nothing is sent to a server.</span>
        <span>Esc to close</span>
      </div>
    </dialog>
  );
}
