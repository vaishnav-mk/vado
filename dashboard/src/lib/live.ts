// The live feed: GET /live?db=<name> on this origin, a WebSocket the database's Watcher sends one message a
// second on (src/admin/watcher.js). Reconnects with backoff; merges init and ticks into one picture.
import { useEffect, useState } from "react";
import type { LiveEvent, LiveMessage, LiveState, Point } from "./types";

const HISTORY = 300; // points kept for the charts: five minutes
const EVENTS = 100;
const RETRY_MIN = 1_000, RETRY_MAX = 30_000;

export type Connection = "connecting" | "open" | "retrying";

export interface Live {
  state: LiveState | null;
  history: Point[];
  events: LiveEvent[];
  connection: Connection;
}

const EMPTY: Live = { state: null, history: [], events: [], connection: "connecting" };

/** Events newest first, a repeat replacing the earlier copy (same id). */
function mergeEvents(old: LiveEvent[], fresh: LiveEvent[]) {
  if (!fresh.length) return old;
  const byId = new Map(old.map((e) => [e.id, e]));
  for (const e of fresh) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.t - a.t || b.id - a.id).slice(0, EVENTS);
}

function apply(live: Live, msg: LiveMessage): Live {
  if (msg.type === "init") {
    return { state: msg.state ?? null, history: (msg.history ?? []).slice(-HISTORY), events: mergeEvents([], msg.events ?? []), connection: "open" };
  }
  const last = live.history.at(-1);
  const history = !msg.point || (last && last.t >= msg.point.t) ? live.history : [...live.history.slice(-(HISTORY - 1)), msg.point];
  return { state: msg.state ?? live.state, history, events: mergeEvents(live.events, msg.events ?? []), connection: "open" };
}

/** The live picture of database `name`, or EMPTY until the first message. Reconnects when `signedIn` changes:
 *  the Watcher measures writes only for signed-in watchers, and learns who is when the socket opens. */
export function useLive(name: string, signedIn = false): Live {
  const [live, setLive] = useState<Live>(EMPTY);
  useEffect(() => {
    let ws: WebSocket | null = null, timer: ReturnType<typeof setTimeout> | undefined, delay = RETRY_MIN, stopped = false;
    setLive(EMPTY);
    const connect = () => {
      const url = new URL(`/live?db=${encodeURIComponent(name)}`, location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(url);
      ws.onmessage = (m) => {
        delay = RETRY_MIN;
        let msg: LiveMessage;
        try { msg = JSON.parse(m.data); } catch { return; }
        if (msg?.type === "init" || msg?.type === "tick") setLive((l) => apply(l, msg));
      };
      ws.onclose = () => {
        if (stopped) return;
        setLive((l) => ({ ...l, connection: "retrying" }));
        timer = setTimeout(connect, delay * (0.75 + Math.random() / 2));
        delay = Math.min(RETRY_MAX, delay * 2);
      };
    };
    connect();
    return () => { stopped = true; clearTimeout(timer); ws?.close(); };
  }, [name, signedIn]);
  return live;
}
