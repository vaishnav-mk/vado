import type { CommandEntry } from "../protocol/types";
import { bulk, command, EMPTY, error, integer, lower, str } from "../protocol/resp";
import { slotOf } from "../protocol/slots";
import { login } from "./auth";
import { CLIENT_UNSUPPORTED } from "./command-sets";
import type { Conn } from "./conn";
import { arityError, HELLO_NOAUTH, OK, RESET, unknownSubcommand, unsupported } from "./replies-text";
import { forward } from "./routing";

export function hello(c: Conn, argv: Uint8Array[]): void {
  let proto = c.proto;

  if (argv.length > 1) {
    const asked = Number(str(argv[1]));

    if (asked === 2 || asked === 3) proto = asked;
    else return c.replies.reply(error("NOPROTO unsupported protocol version"));
  }

  let user: string | null = null,
    pass: string | null = null,
    setname: string | null = null;

  for (let i = 2; i < argv.length; i++) {
    const option = lower(argv[i]);

    if (option === "auth") {
      user = str(argv[i + 1] ?? EMPTY);
      pass = str(argv[i + 2] ?? EMPTY);
      i += 2;
    } else if (option === "setname") setname = str(argv[++i] ?? EMPTY);
  }

  if (pass !== null) return login(c, user, pass, () => helloAs(c, proto, setname));

  if (!c.authed) return c.replies.reply(HELLO_NOAUTH);
  helloAs(c, proto, setname);
}

function helloAs(c: Conn, proto: 2 | 3, setname: string | null): void {
  if (setname !== null) c.name = setname;

  const changed = proto !== c.proto,
    request = command(["HELLO", String(proto)]);

  c.proto = proto;

  if (changed) c.pool.sendAll(request, 0);
  forward(c, 0, request);
}

export function client(c: Conn, argv: Uint8Array[]): void {
  const sub = lower(argv[1] ?? EMPTY);

  switch (sub) {
    case "setname":
      c.name = str(argv[2] ?? EMPTY);
      c.pool.sendAll(command(["CLIENT", "SETNAME", c.name]));

      return c.replies.reply(OK);
    case "getname":
      return c.replies.reply(bulk(c.name));
    case "id":
      return c.replies.reply(integer(c.id));
    case "setinfo":
      return c.replies.reply(OK);
    case "info":
      return c.replies.reply(
        bulk(`id=${c.id} name=${c.name ?? ""} db=0 resp=${c.proto} router=1 shards=${c.db.shards}\n`),
      );
  }

  if (CLIENT_UNSUPPORTED.has(sub)) return c.replies.reply(unsupported(`client ${sub}`));
  c.replies.reply(unknownSubcommand(argv[1] ?? EMPTY, "CLIENT"));
}

// After every earlier reply: closing upstreams first would lose them.
export function reset(c: Conn): void {
  c.replies.viaRpc(() => {
    c.tx.multi = null;
    c.tx.clearWatch();
    c.name = null;
    c.proto = 2;
    c.endPassthrough(false);
    c.pool.closeAll();

    return RESET;
  });
}

export function select(c: Conn, entry: CommandEntry | undefined, argv: Uint8Array[]): void {
  c.replies.reply(
    arityError(entry, "select", argv) ??
      (str(argv[1]) === "0"
        ? OK
        : error("ERR DB index is out of range (use one database name per connection address)")),
  );
}

export function cluster(c: Conn, argv: Uint8Array[]): void {
  const sub = lower(argv[1] ?? EMPTY);

  if (sub === "keyslot" && argv[2]) return c.replies.reply(integer(slotOf(argv[2])));

  if (sub === "info") return c.replies.reply(bulk(`cluster_enabled:0\r\nrouter_shards:${c.db.shards}\r\n`));
  c.replies.reply(error("ERR This instance has cluster support disabled (sharding is done by the router)"));
}
