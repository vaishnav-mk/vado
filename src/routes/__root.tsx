import type { ReactNode } from "react";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { TooltipProvider } from "@cloudflare/kumo";
import { SignedIn } from "../components/Guard";
import { me } from "../server/access";
import css from "../styles.css?url";

// Kumo reads light or dark from data-mode; set it before the first paint, and follow the system after.
const MODE = `(()=>{const q=matchMedia("(prefers-color-scheme: dark)"),s=()=>document.documentElement.dataset.mode=q.matches?"dark":"light";s();q.addEventListener("change",s)})()`;

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }, { title: "vado" }],
    links: [{ rel: "stylesheet", href: css }],
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
