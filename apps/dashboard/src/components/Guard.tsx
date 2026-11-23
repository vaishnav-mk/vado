import { createContext, useContext, type ReactElement } from "react";
import { Tooltip } from "@cloudflare/kumo";

export const SignedIn = createContext<string | null>(null);
export const useSignedIn = () => useContext(SignedIn);

export function Guard({
  action,
  className = "inline-flex",
  children,
}: {
  action: string;
  className?: string;
  children: (disabled: boolean) => ReactElement;
}) {
  if (useSignedIn()) return children(false);

  // A disabled button gets no pointer events, so the tooltip hangs on a wrapper.
  return (
    <Tooltip content={`Sign in to ${action}`} render={<span className={className} tabIndex={0} />}>
      {children(true)}
    </Tooltip>
  );
}
