import { createContext, use, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { SERVERS } from "../content/servers";
import type { Server } from "../content/servers";

export const SERVER_KEY = "vado-docs-server";

// Runs in <head> before the first paint, like the theme script, so a stored Redis choice never flashes Valkey.
export const SERVER_SCRIPT = `(()=>{let s="valkey";try{if(localStorage.getItem("${SERVER_KEY}")==="redis")s="redis"}catch{}document.documentElement.dataset.server=s})()`;

interface ServerChoice {
  server: Server;
  choose: (server: Server) => void;
}

const ServerContext = createContext<ServerChoice>({ server: "valkey", choose: () => undefined });

const ORDER: Server[] = ["valkey", "redis"];

export function ServerProvider({ children }: { children: ReactNode }) {
  const [server, setServer] = useState<Server>("valkey");

  useEffect(() => setServer(document.documentElement.dataset.server === "redis" ? "redis" : "valkey"), []);

  const choose = (next: Server) => {
    setServer(next);
    document.documentElement.dataset.server = next;

    try {
      localStorage.setItem(SERVER_KEY, next);
    } catch {
      // Private browsing can refuse storage; the choice still applies to this page.
    }
  };

  return <ServerContext value={{ server, choose }}>{children}</ServerContext>;
}

/** Renders both and lets CSS show one, so server-rendered HTML matches whatever the head script picked. */
export function ByServer({ valkey, redis }: { valkey: ReactNode; redis: ReactNode }) {
  return (
    <>
      <span className="by-valkey">{valkey}</span>
      <span className="by-redis">{redis}</span>
    </>
  );
}

export function ServerName() {
  return <ByServer valkey={SERVERS.valkey.name} redis={SERVERS.redis.name} />;
}

/** A blue or red pill: the given server, or the one picked in the header. */
export function ServerBadge({ server }: { server?: Server }) {
  return (
    <span className="server-badge" data-server={server}>
      {server === undefined ? <ServerName /> : SERVERS[server].name}
    </span>
  );
}

export function ServerSwitch() {
  const { server, choose } = use(ServerContext);

  return (
    <div className="server-switch" role="group" aria-label="Server shown in the docs">
      {ORDER.map((option) => (
        <button
          key={option}
          type="button"
          data-option={option}
          aria-pressed={server === option}
          onClick={() => choose(option)}
        >
          <ServerBadge server={option} />
        </button>
      ))}
    </div>
  );
}
