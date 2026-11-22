// Signing in belongs to Cloudflare Access: an Access application on /signin makes a visit there sign in and come
// back (routes/signin.tsx), and /cdn-cgi/access/logout signs out of Access on this host.
import { LinkButton, Tooltip } from "@cloudflare/kumo";
import { SignInIcon, SignOutIcon } from "@phosphor-icons/react";
import { useLocation } from "@tanstack/react-router";
import { useSignedIn } from "./Guard";

export function SignIn() {
  const user = useSignedIn(), here = useLocation().pathname;
  if (user) {
    return (
      <Tooltip content={`Signed in as ${user}`}>
        <LinkButton href="/cdn-cgi/access/logout" variant="ghost" icon={SignOutIcon}>Sign out</LinkButton>
      </Tooltip>
    );
  }
  return <LinkButton href={`/signin?to=${encodeURIComponent(here)}`} variant="secondary" icon={SignInIcon}>Sign in</LinkButton>;
}
