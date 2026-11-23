// What the router writes itself, byte for byte as Valkey would, and the requests it makes up.
import { bulk, command, error, lineEnd, simple, str } from "../protocol/resp";
import type { CommandEntry } from "../protocol/types";
import { encoder } from "../shared";

export const OK = simple("OK");
export const QUEUED = simple("QUEUED");
export const PONG = simple("PONG");
export const RESET = simple("RESET");
export const NULL_BULK = bulk(null);
export const NULL_ARRAY = encoder.encode("*-1\r\n");
export const NULL3 = encoder.encode("_\r\n");
export const CROSSSLOT = error("CROSSSLOT Keys in request don't hash to the same slot");

/** Compared by identity: only a reply that is this object means the shard never answered. */
export const LOST = error("ERR shard connection lost; the command may or may not have run");
export const NOAUTH = error("NOAUTH Authentication required.");
export const WRONGPASS = error("WRONGPASS invalid username-password pair or user is disabled.");
export const TOO_MANY = error("ERR too many failed AUTH attempts from this address; try again in a minute");
export const EXECABORT = error("EXECABORT Transaction discarded because of previous errors.");
export const NOT_INTEGER = error("ERR value is not an integer or out of range");

export const HELLO_NOAUTH = error(
  "NOAUTH HELLO must be called with the client already authenticated, otherwise the HELLO <proto> AUTH <user> <pass> option can be used to authenticate the client and select the RESP protocol version at the same time",
);

// Compared by identity in the socket upstream: MULTI and EXEC mark where a transaction runs on the shard.
export const MULTI = command(["MULTI"]);
export const EXEC = command(["EXEC"]);
export const UNWATCH = command(["UNWATCH"]);

/** What a dropped shard's methods throw (ValkeyShard #live). */
export const DROPPED = /database dropped/;

/** A bulk string frame's bytes (none for a null one). */
export const bulkBytes = (f: Uint8Array) => f.subarray(lineEnd(f, 1, f.length) + 2, f.length - 2);

/** A bulk string frame's text; "" for any other frame. */
export const bulkText = (f: Uint8Array) => (f[0] === 36 ? str(bulkBytes(f)) : "");

export const unsupported = (name: string) => error(`ERR '${name}' is not supported by the sharded router`);
export const wrongArity = (name: string) => error(`ERR wrong number of arguments for '${name}' command`);
export const droppedDatabase = (name: string) => error(`ERR database ${name} was dropped`);

export const notWhileSubscribed = (name: string) =>
  error(
    `ERR Can't execute '${name}': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context`,
  );

/** Valkey's addReplySubcommandSyntaxError, with the subcommand as the client spelled it. */
export const unknownSubcommand = (sub: Uint8Array, command: string) =>
  error(`ERR unknown subcommand or wrong number of arguments for '${str(sub).slice(0, 128)}'. Try ${command} HELP.`);

/** Valkey's processCommand wording: original spelling, each argument quoted plus a space, up to 128 characters. */
export function unknownCommand(argv: Uint8Array[]): Uint8Array {
  let args = "";

  for (let i = 1; i < argv.length && args.length < 128; i++) args += `'${str(argv[i]).slice(0, 128 - args.length)}' `;

  return error(`ERR unknown command '${str(argv[0]).slice(0, 128)}', with args beginning with: ${args}`);
}

export const badArity = (entry: CommandEntry, argv: Uint8Array[]) =>
  (entry.arity > 0 && argv.length !== entry.arity) || (entry.arity < 0 && argv.length < -entry.arity);

/** Valkey's error for an unknown command or a wrong argument count, or null. */
export function arityError(entry: CommandEntry | undefined, name: string, argv: Uint8Array[]): Uint8Array | null {
  if (!entry) return unknownCommand(argv);

  return badArity(entry, argv) ? wrongArity(name) : null;
}
