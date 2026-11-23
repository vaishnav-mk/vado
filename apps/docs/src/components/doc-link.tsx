import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

interface Props {
  slug: string;
  hash?: string;
  className?: string;
  current?: boolean;
  onClick?: () => void;
  children: ReactNode;
}

/** A link to a documentation page. The introduction lives at `/`. */
export function DocLink({ slug, hash, className, current, onClick, children }: Props) {
  const aria = current ? "page" : undefined;

  if (slug === "introduction") {
    return (
      <Link to="/" hash={hash} className={className} aria-current={aria} onClick={onClick}>
        {children}
      </Link>
    );
  }

  return (
    <Link to="/docs/$slug" params={{ slug }} hash={hash} className={className} aria-current={aria} onClick={onClick}>
      {children}
    </Link>
  );
}
