import type { Icon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

export interface Source {
  label: string;
  href: string;
}

export interface DocSection {
  id: string;
  title: string;
  content: ReactNode;
}

export interface Doc {
  slug: string;
  title: string;
  /** The sidebar, search and pager name, when the page title is a sentence. */
  navTitle?: string;
  group: string;
  description: string;
  icon: Icon;
  keywords: string;
  intro?: ReactNode;
  sections: DocSection[];
  sources: Source[];
}
