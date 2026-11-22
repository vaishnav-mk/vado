// /signin is the path a Cloudflare Access application protects, so a visit gets here signed in and goes back to the
// page it came from.
import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

export const Route = createFileRoute("/signin")({
  // Only a path on this site ("/...", not "//host"), so a link can't send someone elsewhere after signing in.
  validateSearch: z.object({ to: z.string().regex(/^\/(?!\/)/).catch("/") }),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => {
    throw redirect({ href: deps.to });
  },
});
