// Colors shared by the dial, the globe, the charts and the legends.
import { ChartPalette } from "@cloudflare/kumo";
import type { ReplicaState } from "./types";

export const SHARD = "#F6821F";
export const HIGHLIGHT = "#E8649D";
export const traffic = (dark: boolean) => ChartPalette.categorical(0, dark);

export const REPLICA: Record<ReplicaState, string> = {
  ready: "#16A34A",
  copying: "#F59E0B",
  "catching up": "#F59E0B",
  asleep: "#9CA3AF",
  idle: "#DC2626",
};

/** What each replica state means, in plain words. */
const REPLICA_WORDS: Record<ReplicaState, string> = {
  ready: "Ready",
  copying: "Copying",
  "catching up": "Catching up",
  asleep: "Asleep",
  idle: "Lost its stream",
};

export const replicaColor = (s: string | undefined) => REPLICA[s as ReplicaState] ?? REPLICA.asleep;
export const replicaWords = (s: string | undefined) => REPLICA_WORDS[s as ReplicaState] ?? s ?? "Unknown";
