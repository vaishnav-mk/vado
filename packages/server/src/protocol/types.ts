export interface ReplyError {
  err: string;
}

export type Reply = string | number | bigint | boolean | null | ReplyError | Reply[] | Map<Reply, Reply>;

export type TypedReply =
  | { type: "status" | "error" | "bulk"; value: string }
  | { type: "integer"; value: number }
  | { type: "nil" }
  | { type: "array"; value: TypedReply[] };

export interface FrameResume {
  k?: number;
  rel?: number;
}

export interface RequestResume {
  argv?: Uint8Array[] | null;
  k?: number;
  rel?: number;
}

export interface ParsedRequest {
  argv: Uint8Array[];
  end: number;
}

export interface CommandEntry {
  name: string;
  arity: number;
  flags: Set<string>;
  first: number;
  last: number;
  step: number;
  sub: CommandTable | null;
}

// Keyed by lowercase name; a subcommand without its container's prefix.
export type CommandTable = Map<string, CommandEntry>;

export interface RespSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

export type CommandArg = string | number | Uint8Array;
