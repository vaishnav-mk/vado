import type { ReactNode } from "react";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { TooltipProvider } from "@cloudflare/kumo";
import { SignedIn } from "../components/Guard";
import { me } from "../server/access";
import css from "../styles.css?url";

// The docs site's mark, inlined so the Worker serves no extra file.
const FAVICON = `data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"%3E%3Crect width="32" height="32" rx="8" fill="%23e3f4f1"/%3E%3Crect x="7" y="7" width="8" height="8" rx="2" fill="none" stroke="%230f766e" stroke-width="2"/%3E%3Crect x="17" y="7" width="8" height="8" rx="2" fill="none" stroke="%230f766e" stroke-width="2"/%3E%3Crect x="7" y="17" width="8" height="8" rx="2" fill="none" stroke="%230f766e" stroke-width="2"/%3E%3Crect x="17" y="17" width="8" height="8" rx="2" fill="%230f766e"/%3E%3C/svg%3E`;

// Kumo reads light or dark from data-mode; set it before the first paint, and follow the system after.
const MODE = `(()=>{const q=matchMedia("(prefers-color-scheme: dark)"),s=()=>document.documentElement.dataset.mode=q.matches?"dark":"light";s();q.addEventListener("change",s)})()`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "vado" },
    ],
    links: [
      { rel: "stylesheet", href: css },
      { rel: "icon", type: "image/svg+xml", href: FAVICON },
    ],
  }),
  loader: async () => ({ user: await me() }),
  shellComponent: Shell,
  component: Root,
});

function Shell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: MODE }} />
        <HeadContent />
      </head>
      <body className="bg-kumo-canvas text-kumo-default">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function Root() {
  const { user } = Route.useLoaderData();

  return (
    <SignedIn.Provider value={user}>
      <TooltipProvider>
        <div className="min-h-screen bg-kumo-canvas text-kumo-default">
          <Outlet />
        </div>
      </TooltipProvider>
    </SignedIn.Provider>
  );
}
