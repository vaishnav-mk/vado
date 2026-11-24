import { LinkButton, Tooltip } from "@cloudflare/kumo";
import { SignInIcon, SignOutIcon } from "@phosphor-icons/react";
import { useLocation } from "@tanstack/react-router";
import { useViewer } from "./Guard";

// Cloudflare Access owns sign-in: it protects /signin (routes/signin.tsx), and /cdn-cgi/access/logout signs out.
export function SignIn() {
  const { user, signIn } = useViewer(),
    here = useLocation().pathname;

  if (!signIn) return null;

  if (user) {
    return (
      <Tooltip content={`Signed in as ${user}`}>
        <LinkButton href="/cdn-cgi/access/logout" variant="ghost" icon={SignOutIcon}>
          Sign out
        </LinkButton>
      </Tooltip>
    );
  }

  return (
    <LinkButton href={`/signin?to=${encodeURIComponent(here)}`} variant="secondary" icon={SignInIcon}>
      Sign in
    </LinkButton>
  );
}
