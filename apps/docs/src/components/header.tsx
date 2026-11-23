import { GithubLogoIcon, ListIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { REPO } from "../content/sources";
import { ThemeToggle } from "./theme-toggle";

interface Props {
  onSearch: () => void;
  onMenu: () => void;
}

const TOP_LINKS = [
  { slug: "architecture", label: "Architecture" },
  { slug: "operations", label: "Run it" },
  { slug: "measurements", label: "Limits" },
];

function Logo() {
  return (
    <svg viewBox="0 0 28 28" className="size-7 max-md:size-6" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="10" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="15" y="3" width="10" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="3" y="15" width="10" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="15" y="15" width="10" height="10" rx="2.5" fill="var(--accent)" />
    </svg>
  );
}

export function Header({ onSearch, onMenu }: Props) {
  return (
    <header className="sticky top-0 z-30 h-[72px] border-b border-line bg-paper/95 backdrop-blur-md max-md:h-[62px]">
      <div className="mx-auto flex h-full max-w-[1536px] items-center gap-9 px-10 max-lg:px-6 max-md:gap-3 max-md:px-[18px]">
        <Link
          to="/"
          className="flex shrink-0 items-center gap-2.5 text-base font-semibold tracking-[-.6px] text-ink no-underline max-md:gap-2 max-md:text-sm"
          aria-label="vado documentation home"
        >
          <Logo />
          <span>
            vado<span className="font-normal text-deep"> / docs</span>
          </span>
        </Link>
        <div className="flex items-center gap-6 text-[13px] text-muted max-lg:hidden">
          <Link to="/" className="text-ink no-underline">
            Documentation
          </Link>
          {TOP_LINKS.map((link) => (
            <Link key={link.slug} to="/docs/$slug" params={{ slug: link.slug }} className="no-underline">
              {link.label}
            </Link>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-4 max-md:gap-1">
          <button
            type="button"
            className="flex min-w-[166px] items-center gap-2 rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs text-muted hover:border-accent/40 max-md:min-w-0 max-md:border-0 max-md:bg-transparent max-md:p-2"
            onClick={onSearch}
            aria-label="Search documentation"
          >
            <MagnifyingGlassIcon size={14} />
            <span className="max-md:hidden">Search docs</span>
            <kbd className="ml-auto rounded border border-line px-1 text-[10px] max-md:hidden">⌘ K</kbd>
          </button>
          <a href={REPO} className="flex items-center gap-1.5 text-xs text-ink no-underline max-md:hidden">
            <GithubLogoIcon size={15} />
            <span>GitHub</span>
          </a>
          <ThemeToggle />
          <button type="button" className="rounded-md p-2 md:hidden" aria-label="Open navigation" onClick={onMenu}>
            <ListIcon size={18} />
          </button>
        </div>
      </div>
    </header>
  );
}
