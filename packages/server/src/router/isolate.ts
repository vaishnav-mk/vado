// State every router in this isolate shares.
import { REPL_RETRY_MS } from "../replication/config";
import { ISOLATE_HIGH, ISOLATE_LOW, SOCKET_BUDGET } from "./config";

interface Waiter {
  wake(): void;
}

let socketsOpen = 0;
let socketBudget = SOCKET_BUDGET;
let isolateBytes = 0;
const waiting = new Set<Waiter>();

// "<db>/<shard>" -> until (ms): a replica that just failed a read (not ready, or reset) isn't tried for a while.
const replicaDown = new Map<string, number>();

export const setSocketBudget = (n: number) => {
  socketBudget = n;
};

export const socketOpened = () => {
  socketsOpen++;
};

export const socketClosed = () => {
  socketsOpen--;
};

/** Whether a new upstream may be a socket; past the budget it carries RPC batches instead. */
export const socketsLeft = () => socketsOpen < socketBudget;

/** Counts shard-bound bytes in flight; draining below ISOLATE_LOW wakes every router that waited. */
export function isolateAdd(n: number): void {
  isolateBytes += n;

  if (n < 0 && isolateBytes <= ISOLATE_LOW && waiting.size) {
    const all = [...waiting];
    waiting.clear();

    for (const w of all) w.wake();
  }
}

/** Past ISOLATE_HIGH, `waiter` is woken once the isolate drains. */
export function isolateFull(waiter: Waiter): boolean {
  if (isolateBytes <= ISOLATE_HIGH) return false;
  waiting.add(waiter);

  return true;
}

export const replicaFailed = (db: string, shard: number) => {
  replicaDown.set(`${db}/${shard}`, Date.now() + REPL_RETRY_MS);
};

export const replicaResting = (db: string, shard: number, now: number) =>
  (replicaDown.get(`${db}/${shard}`) ?? 0) > now;
