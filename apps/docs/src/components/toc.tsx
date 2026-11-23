import { CaretRightIcon, GithubLogoIcon } from "@phosphor-icons/react";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { REPO } from "../content/sources";
import type { Doc } from "../content/types";

/** "On this page", with the section in view highlighted. */
export function OnThisPage({ doc }: { doc: Doc }) {
  const { pathname } = useLocation();
  const [active, setActive] = useState("");

  useEffect(() => {
    setActive("");

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.find((entry) => entry.isIntersecting);

        if (visible !== undefined) setActive(visible.target.id);
      },
      { rootMargin: "-85px 0px -60% 0px" },
    );

    document.querySelectorAll("article section[id]").forEach((section) => observer.observe(section));

    return () => observer.disconnect();
  }, [pathname]);

  return (
    <aside
      className="sticky top-[72px] max-h-[calc(100dvh-72px)] overflow-y-auto py-10 max-[1250px]:hidden"
      aria-label="On this page"
    >
      <p className="mb-3 text-xs font-medium text-muted">On this page</p>
      <ul className="m-0 list-none border-l border-line p-0">
        {doc.sections.map((section) => (
          <li key={section.id} className="m-0 p-0">
            <a
              href={`#${section.id}`}
              className={`-ml-px block border-l py-1 pl-3 text-xs leading-snug no-underline ${active === section.id ? "border-accent text-deep" : "border-transparent text-muted hover:text-ink"}`}
              aria-current={active === section.id ? "location" : undefined}
            >
              {section.title}
            </a>
          </li>
        ))}
      </ul>
      <div className="mt-6 border-t border-line pt-4 text-[11px] text-muted">
        <p className="text-[11px]!">Read the implementation</p>
        <a href={REPO} className="flex items-center gap-1.5 no-underline">
          <GithubLogoIcon size={12} /> Repository <CaretRightIcon size={11} />
        </a>
      </div>
    </aside>
  );
}
