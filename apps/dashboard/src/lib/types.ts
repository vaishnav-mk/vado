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

/** What a new database can be: the regions it can use, and the servers this build runs. */
export interface Options {
  regions: Record<string, string>;
  flavours: string[];
}

/** The last command run from this page, as the dial and the globe show it. */
export interface LastCommand extends CommandResult {
  at: number;
  argv: string[];
  /** The states of the key's shard's replicas when the command was sent, if the page knew them. */
  before: ReplicaState[] | null;
}
