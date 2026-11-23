import { useLocation } from "@tanstack/react-router";
import { groups } from "../content";
import { DocLink } from "./doc-link";

const pathOf = (slug: string) => (slug === "introduction" ? "/" : `/docs/${slug}`);

export function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useLocation();

  return (
    <nav aria-label="Documentation">
      {groups.map(([group, docs]) => (
        <div className="mb-7" key={group}>
          <p className="mb-2 px-3 text-xs font-medium text-muted">{group}</p>
          <ul className="m-0 list-none p-0">
            {docs.map((doc) => {
              const current = pathname === pathOf(doc.slug);
              const Icon = doc.icon;

              const tone = current
                ? "border-accent/40 bg-tint text-deep"
                : "border-transparent text-soft hover:bg-wash hover:text-ink";

              return (
                <li className="m-0 p-0" key={doc.slug}>
                  <DocLink
                    slug={doc.slug}
                    current={current}
                    onClick={onNavigate}
                    className={`my-0.5 flex items-center gap-2.5 rounded-lg border px-3 py-1.5 text-[13px] leading-snug no-underline transition-colors ${tone}`}
                  >
                    <Icon className="size-4 shrink-0" weight={current ? "fill" : "regular"} />
                    <span>{doc.navTitle ?? doc.title}</span>
                  </DocLink>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
