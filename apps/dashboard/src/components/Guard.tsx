import { createContext, useContext, type ReactElement } from "react";
import { Tooltip } from "@cloudflare/kumo";

// signIn is false when this deploy has no sign-in set up, so the dashboard only watches.
export const Viewer = createContext<{ user: string | null; signIn: boolean }>({ user: null, signIn: false });
export const useViewer = () => useContext(Viewer);

export function Guard({
  action,
  className = "inline-flex",
  children,
}: {
  action: string;
  className?: string;
  children: (disabled: boolean) => ReactElement;
}) {
  const { user, signIn } = useViewer();

  if (user) return children(false);

  // A disabled button gets no pointer events, so the tooltip hangs on a wrapper.
  return (
    <Tooltip
      content={signIn ? `Sign in to ${action}` : "This dashboard only watches"}
      render={<span className={className} tabIndex={0} />}
    >
      {children(true)}
    </Tooltip>
  );
}
