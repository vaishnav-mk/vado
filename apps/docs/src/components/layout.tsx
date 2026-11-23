import { XIcon } from "@phosphor-icons/react";
import { Link, useLocation } from "@tanstack/react-router";
import { useRef } from "react";
import type { ReactNode } from "react";
import { docs } from "../content";
import { SERVERS } from "../content/servers";
import { Header } from "./header";
import { Navigation } from "./navigation";
import { SearchDialog } from "./search";
import { ByServer, ServerBadge, ServerProvider } from "./server";
import { OnThisPage } from "./toc";

export function DocsLayout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const doc = docs.find((item) => pathname === `/docs/${item.slug}`) ?? docs[0];
  const search = useRef<HTMLDialogElement>(null);
  const menu = useRef<HTMLDialogElement>(null);

  return (
    <ServerProvider>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Header onSearch={() => search.current?.showModal()} onMenu={() => menu.current?.showModal()} />
      <div className="mx-auto grid max-w-[1536px] grid-cols-[216px_minmax(0,808px)_172px] items-start justify-center gap-14 px-10 max-[1250px]:grid-cols-[205px_minmax(0,808px)] max-[1250px]:gap-10 max-lg:grid-cols-[180px_minmax(0,1fr)] max-lg:gap-6 max-lg:px-6 max-md:block max-md:px-[22px]">
        <aside className="sticky top-[72px] max-h-[calc(100dvh-72px)] overflow-y-auto py-9 [scrollbar-width:thin] max-md:hidden">
          <Navigation />
          <div className="mx-3 border-t border-line pt-4 text-[11px] leading-relaxed text-muted">
            <span className="inline-flex items-center gap-1.5">
              <ServerBadge /> <ByServer valkey={SERVERS.valkey.version} redis={SERVERS.redis.version} />
            </span>
            <p className="mt-2! text-[11px]!">
              Experimental.
              <br />
              Not a managed service.
            </p>
            <Link to="/docs/$slug" params={{ slug: "measurements" }} className="mt-2 block text-[11px]">
              Limits and measurements
            </Link>
          </div>
        </aside>
        <main id="main" className="min-w-0 pt-9 pb-16 outline-none max-md:pt-7" tabIndex={-1}>
          {children}
        </main>
        <OnThisPage doc={doc} />
      </div>
      <SearchDialog dialog={search} />
      <dialog ref={menu} className="mobile-dialog" aria-labelledby="navigation-title">
        <div className="flex items-center justify-between px-3 pb-4">
          <span id="navigation-title" className="text-sm font-medium">
            Documentation
          </span>
          <button type="button" aria-label="Close navigation" onClick={() => menu.current?.close()} className="p-1">
            <XIcon size={17} />
          </button>
        </div>
        <Navigation onNavigate={() => menu.current?.close()} />
      </dialog>
    </ServerProvider>
  );
}
