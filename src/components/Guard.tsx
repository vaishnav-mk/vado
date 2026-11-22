// Whether this page is signed in, and a wrapper that disables what needs it, saying why.
import { createContext, useContext, type ReactElement } from "react";
import { Tooltip } from "@cloudflare/kumo";

export const SignedIn = createContext(false);
export const useSignedIn = () => useContext(SignedIn);

/** Renders `children(disabled)`; when signed out, disabled and with a "Sign in to <action>" tooltip. */
export function Guard({ action, className = "inline-flex", children }: { action: string; className?: string; children: (disabled: boolean) => ReactElement }) {
  const signedIn = useSignedIn();
  if (signedIn) return children(false);
  // A disabled button gets no pointer events, so the tooltip hangs on a wrapper.
  return (
    <Tooltip content={`Sign in to ${action}`} render={<span className={className} tabIndex={0} />}>
      {children(true)}
    </Tooltip>
  );
}
