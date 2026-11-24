import { REPL_RETRY_MS } from "../wasm-shard/replication/config";
import { ISOLATE_HIGH, ISOLATE_LOW, SOCKET_BUDGET } from "./config";
import type { UpstreamOwner } from "./types";

let socketsOpen = 0;
let socketBudget = SOCKET_BUDGET;
let isolateBytes = 0;
const waiting = new Set<Pick<UpstreamOwner, "wake">>();

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

export const socketsLeft = () => socketsOpen < socketBudget;

export function isolateAdd(n: number): void {
  isolateBytes += n;

  if (n < 0 && isolateBytes <= ISOLATE_LOW && waiting.size) {
    const all = [...waiting];
    waiting.clear();

    for (const w of all) w.wake();
  }
}

export function isolateFull(waiter: Pick<UpstreamOwner, "wake">): boolean {
  if (isolateBytes <= ISOLATE_HIGH) return false;
  waiting.add(waiter);

  return true;
}

export const replicaFailed = (db: string, shard: number) => {
  replicaDown.set(`${db}/${shard}`, Date.now() + REPL_RETRY_MS);
};

export const replicaResting = (db: string, shard: number, now: number) =>
  (replicaDown.get(`${db}/${shard}`) ?? 0) > now;
