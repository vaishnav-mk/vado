import type { Flavour } from "@vado/server/catalog/types.ts";
import type { CommandResult, ReplicaState } from "@vado/server/admin/live-types.ts";

export type {
  CommandResult,
  Database,
  Entry,
  EventKind,
  EventLevel,
  Health,
  LiveEvent,
  LiveSnapshot,
  LiveState,
  Place,
  Point,
  Replica,
  ReplicaState,
  Shard,
  ShardDown,
  ShardUp,
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
