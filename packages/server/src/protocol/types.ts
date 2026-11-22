/** An error reply, decoded. */
export interface ReplyError {
  err: string;
}

/** A decoded RESP2/RESP3 reply: bulk strings as strings, errors as `{ err }`, maps as Maps. */
export type Reply = string | number | bigint | boolean | null | ReplyError | Reply[] | Map<Reply, Reply>;

/** A RESP2 reply with its type kept, so it can be shown as valkey-cli does. */
export type TypedReply =
  | { type: "status" | "error" | "bulk"; value: string }
  | { type: "integer"; value: number }
  | { type: "nil" }
  | { type: "array"; value: TypedReply[] };

/** How far frameEnd() got into an aggregate still arriving, relative to its start. */
export interface FrameResume {
  k?: number;
  rel?: number;
}

/** How far request() got into a request still arriving. */
export interface RequestResume {
  argv?: Uint8Array[] | null;
  k?: number;
  rel?: number;
}

export interface ParsedRequest {
  argv: Uint8Array[];
  end: number;
}

/** One command of Valkey's COMMAND reply: arity, flags and key positions. */
export interface CommandEntry {
  name: string;
  arity: number;
  flags: Set<string>;
  first: number;
  last: number;
  step: number;
  sub: CommandTable | null;
}

/** Command name (lowercase; a subcommand without its container's prefix) to its entry. */
export type CommandTable = Map<string, CommandEntry>;

/** What a RespClient talks over: a TCP socket, a service binding's socket or a router's stream pair. */
export interface RespSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

/** One argument of a command to encode: bytes as they are, anything else as its decimal or UTF-8 text. */
export type CommandArg = string | number | Uint8Array;
