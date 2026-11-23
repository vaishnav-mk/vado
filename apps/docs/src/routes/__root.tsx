import type { ReactNode } from "react";
import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import { DocsLayout } from "../components/layout";
import { THEME_SCRIPT } from "../components/theme-toggle";
import stylesheet from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "vado · Valkey on Durable Objects" },
      {
        name: "description",
        content:
          "Real Valkey, compiled to WebAssembly, in Cloudflare Durable Objects behind a sharding router. How it works, how to run it, and what it measures.",
      },
    ],
    links: [
      { rel: "stylesheet", href: stylesheet },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    ],
  }),
  shellComponent: Shell,
  component: () => <Outlet />,
  notFoundComponent: NotFound,
});

function Shell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <HeadContent />
      </head>
      <body>
        <DocsLayout>{children}</DocsLayout>
        <Scripts />
      </body>
    </html>
  );
}

function NotFound() {
  return (
    <div className="doc py-20">
      <h1>Page not found</h1>
      <p>This page does not exist. Choose a topic in the sidebar.</p>
      <Link to="/">Go to the introduction</Link>
    </div>
  );
}
