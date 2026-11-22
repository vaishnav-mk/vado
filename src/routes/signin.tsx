// /signin is the path a Cloudflare Access application protects. A visit that gets here signed in goes back to the
// page it came from; one that isn't means Access isn't set up for this Worker yet.
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Empty, LinkButton } from "@cloudflare/kumo";
import { LockKeyIcon } from "@phosphor-icons/react";
import { me } from "../server/access";

export const Route = createFileRoute("/signin")({
  validateSearch: (s: Record<string, unknown>) => ({ to: typeof s.to === "string" && /^\/(?!\/)/.test(s.to) ? s.to : "/" }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    if (await me()) throw redirect({ href: deps.to });
  },
  head: () => ({ meta: [{ title: "Sign in · vado" }] }),
  component: NotSetUp,
});

function NotSetUp() {
  return (
    <main className="mx-auto max-w-xl px-6 py-24">
      <Empty icon={<LockKeyIcon size={32} />} title="Sign-in isn't set up"
        description="Protect /signin on this hostname with a Cloudflare Access application, then set ACCESS_TEAM_DOMAIN and ACCESS_AUD on the Worker. Until then the dashboard is read-only."
        contents={<LinkButton href="https://github.com/vaishnav-mk/vado#sign-in" external variant="secondary">How to set it up</LinkButton>} />
    </main>
  );
}
