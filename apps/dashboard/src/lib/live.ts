// The live feed: the database's Watcher at /live?db=<name>, a durability socket that sends a tick a second.
import { useEffect, useState } from "react";
import { DurabilitySocketClient } from "durability/client";
import type { Watcher } from "@vado/server/admin/watcher/watcher.ts";
import { EVENTS_KEPT, WATCH_HISTORY } from "./config";
import type { LiveEvent, LiveSnapshot, LiveState, Point, Tick } from "./types";

export type Connection = "connecting" | "open" | "retrying";

export interface Live {
  state: LiveState | null;
  history: Point[];
  events: LiveEvent[];
  connection: Connection;
}

const EMPTY: Live = { state: null, history: [], events: [], connection: "connecting" };

/** Events newest first, a repeat replacing the earlier copy (same id). */
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

/** The live picture of database `name`. Reconnects when `signedIn` changes: the Watcher measures writes only
 *  for signed-in watchers, and learns who is when the socket opens. */
export function useLive(name: string, signedIn = false): Live {
  const [live, setLive] = useState<Live>(EMPTY);

  useEffect(() => {
    setLive(EMPTY);
    const conn = new DurabilitySocketClient<Watcher["socket"]>({ url: liveUrl }).connect(name);

    // Fires on the first subscription and after every gap the socket can't replay. If the snapshot call is
    // lost, the next ticks still bring the state.
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
