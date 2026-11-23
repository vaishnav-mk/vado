import { ArrowLeftIcon, ArrowRightIcon, ArrowSquareOutIcon } from "@phosphor-icons/react";
import { docs } from "../content";
import type { Doc } from "../content/types";
import { DocLink } from "./doc-link";

const CARD = "rounded-lg border border-line px-4 py-3.5 text-ink no-underline hover:border-accent/50";

function Pager({ doc }: { doc: Doc }) {
  const index = docs.indexOf(doc);
  const previous = index > 0 ? docs.at(index - 1) : undefined;
  const next = docs.at(index + 1);

  return (
    <nav className="grid grid-cols-2 gap-3" aria-label="Previous and next pages">
      {previous === undefined ? (
        <div />
      ) : (
        <DocLink className={CARD} slug={previous.slug}>
          <span className="mb-1 flex items-center gap-1.5 text-[10px] text-muted">
            <ArrowLeftIcon size={10} /> Previous
          </span>
          <span className="text-[13px]">{previous.navTitle ?? previous.title}</span>
        </DocLink>
      )}
      {next === undefined ? (
        <div />
      ) : (
        <DocLink className={`${CARD} text-right`} slug={next.slug}>
          <span className="mb-1 flex items-center justify-end gap-1.5 text-[10px] text-muted">
            Next <ArrowRightIcon size={10} />
          </span>
          <span className="text-[13px]">{next.navTitle ?? next.title}</span>
        </DocLink>
      )}
    </nav>
  );
}

export function DocPage({ doc }: { doc: Doc }) {
  return (
    <>
      <article className="doc">
        <header className="mb-8 border-b border-line pb-7 max-md:mb-6">
          <p className="mt-0! mb-2.5! text-xs! font-medium text-deep!">{doc.group}</p>
          <h1>{doc.title}</h1>
          <p className="mt-3! mb-0! max-w-[66ch] text-lg! leading-relaxed! text-soft max-md:text-base!">
            {doc.description}
          </p>
        </header>
        {doc.intro}
        {doc.sections.map((section) => (
          <section id={section.id} key={section.id}>
            <h2>
              <a className="heading-link" href={`#${section.id}`}>
                {section.title}
                <span className="heading-hash" aria-hidden="true">
                  #
                </span>
              </a>
            </h2>
            {section.content}
          </section>
        ))}
        <div className="source-list">
          <p className="font-medium text-soft!">Source</p>
          <ul>
            {doc.sources.map((item) => (
              <li key={item.href}>
                <a href={item.href} className="inline-flex items-start gap-1.5">
                  {item.label}
                  <ArrowSquareOutIcon className="mt-1 shrink-0" size={10} />
                </a>
              </li>
            ))}
          </ul>
        </div>
      </article>
      <footer className="mt-12">
        <Pager doc={doc} />
        <div className="mt-6 flex justify-between gap-3 text-[10px] text-muted max-md:flex-col">
          <span>vado · Valkey and Redis on Durable Objects · Apache-2.0</span>
          <span>Independent and experimental. Not an official Cloudflare, Valkey or Redis product.</span>
        </div>
      </footer>
    </>
  );
}
