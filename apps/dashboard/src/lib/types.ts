import type { Flavour } from "@vado/server/catalog/types.ts";
import type { CommandResult, LiveSnapshot, ReplicaState } from "@vado/server/admin/live-types.ts";

export type {
  CommandResult,
  Database,
  EventKind,
  EventLevel,
  LiveEvent,
  LiveSnapshot,
  LiveState,
  Place,
  Point,
  Replica,
  ReplicaState,
  Shard,
  TestView,
  Tick,
  TypedReply,
} from "@vado/server/admin/live-types.ts";

export interface Options {
  regions: Record<string, string>;
  flavours: Flavour[];
}

export interface LastCommand extends CommandResult {
  at: number;
  argv: string[];
  before: ReplicaState[] | null;
}

export type Connection = "connecting" | "open" | "retrying";

export interface Live extends LiveSnapshot {
  connection: Connection;
}

export interface Arg {
  name: string;
  placeholder: string;
  many?: boolean;
}
