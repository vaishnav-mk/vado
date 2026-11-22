// /signin is the path a Cloudflare Access application protects, so a visit gets here signed in and goes back to the
// page it came from.
import { createFileRoute, redirect } from "@tanstack/react-router";
import * as v from "valibot";

export const Route = createFileRoute("/signin")({
  // Only a path on this site ("/...", not "//host"), so a link can't send someone elsewhere after signing in.
  validateSearch: v.object({ to: v.fallback(v.pipe(v.string(), v.regex(/^\/(?![/\\])/)), "/") }),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => {
    throw redirect({ href: deps.to });
  },
});
