import { useEffect, useState } from "react";
import { DurabilitySocketClient } from "durability/client";
import { EVENTS_KEPT, WATCH_HISTORY } from "@vado/server/admin/config.ts";
import type { Watcher } from "@vado/server/admin/watcher/watcher.ts";
import type { Live, LiveEvent, LiveSnapshot, Tick } from "./types";

const EMPTY: Live = { state: null, history: [], events: [], connection: "connecting" };

function mergeEvents(old: LiveEvent[], fresh: LiveEvent[]): LiveEvent[] {
  if (!fresh.length) return old;
  const byId = new Map(old.map((e) => [e.id, e]));

  for (const e of fresh) byId.set(e.id, e);

  return [...byId.values()].sort((a, b) => b.t - a.t || b.id - a.id).slice(0, EVENTS_KEPT);
}

const fromSnapshot = (s: LiveSnapshot): Live => ({
  state: s.state,
  history: s.history.slice(-WATCH_HISTORY),
  events: mergeEvents([], s.events),
  connection: "open",
});

function applyTick(live: Live, tick: Tick): Live {
  const last = live.history.at(-1);

  const history =
    last && last.t >= tick.point.t ? live.history : [...live.history.slice(-(WATCH_HISTORY - 1)), tick.point];

  return { state: tick.state, history, events: mergeEvents(live.events, tick.events), connection: "open" };
}

const liveUrl = (name: string) => {
  const url = new URL(`/live?db=${encodeURIComponent(name)}`, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return url.href;
};

// Reconnects on sign-in: the Watcher learns who watches when the socket opens, and times writes only for them.
export function useLive(name: string, signedIn: boolean): Live {
  const [live, setLive] = useState<Live>(EMPTY);

  useEffect(() => {
    setLive(EMPTY);
    const conn = new DurabilitySocketClient<Watcher["socket"]>({ url: liveUrl }).connect(name);

    // If the snapshot is lost, the next ticks still bring the state.
    conn.on.resync(() => {
      conn.rpc.snapshot().then(
        (s) => {
          if (conn.status !== "closed") setLive(fromSnapshot(s));
        },
        () => undefined,
      );
    });
    conn.on.tick((tick) => setLive((l) => applyTick(l, tick)));
    // After tick: subscribing starts connecting, so this first sees "connecting", not the initial "disconnected".
    conn.on.status((status) => {
      if (status === "disconnected") setLive((l) => ({ ...l, connection: "retrying" }));
    });

    return () => conn.close();
  }, [name, signedIn]);

  return live;
}
