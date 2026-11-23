// The sharding proxy, one per client connection: parses each request, routes it by key slot to a shard, and writes
// the replies back in request order. Clients see one ordinary Valkey.
import { keyIndexes } from "../protocol/commands";
import { request } from "../protocol/request";
import { arrayOf, bulk, error, integer, lower, str } from "../protocol/resp";
import type { CommandEntry, RequestResume } from "../protocol/types";
import { login } from "./auth";
import { BEFORE_AUTH, PUBSUB, TX_CONTROL, UNSUPPORTED } from "./command-sets";
import { DRAIN_MS, MAX_REQUEST, MAX_UNAUTHED, WATCHDOG_MS } from "./config";
import { Conn } from "./conn";
import { append } from "./buffer";
import { config, dbsize, flush, info, keys, scriptOrFunction } from "./fanout";
import { passRequest, pubsub } from "./pubsub";
import { badArity, NOAUTH, OK, PONG, unknownCommand, unsupported, wrongArity } from "./replies-text";
import { getkeys, routeKeys } from "./routing";
import { randomkey, scan, wait } from "./rpc-commands";
import { client, cluster, hello, reset, select } from "./session";
import { discard, exec, multi, queue, unwatch, watch } from "./transaction";
import { messageOf } from "../shared";

const WAITAOF = arrayOf([integer(1), integer(0)]);

export class Router extends Conn {
  async run(): Promise<void> {
    const reader = this.socket.readable.getReader(),
      watchdog = setInterval(() => this.#tick(), WATCHDOG_MS),
      // how far request() got into a request that is still arriving
      parsing: RequestResume = {};

    let buf: Uint8Array = new Uint8Array(0),
      start = 0;

    try {
      for (;;) {
        while (this.blocked() && !this.closed) await this.paused();
        const { value, done } = await reader.read();

        if (done) break;
        buf = start < buf.length ? append(buf.subarray(start), value) : value;
        start = 0;

        while (!this.closed) {
          // before parsing: an AUTH in flight changes the size limit
          if (this.replies.pending) await this.replies.pending;
          const r = request(buf, start, buf.length, this.authed ? MAX_REQUEST : MAX_UNAUTHED, parsing);

          if (!r) break;

          if (r.argv.length) this.#handle(r.argv, buf.subarray(start, r.end));
          start = r.end;
        }

        if (this.closed) break;
      }
    } catch (cause) {
      // after the replies to earlier requests, then close
      this.replies.reply(error(`ERR ${messageOf(cause)}`));
    }

    await this.replies.drain(DRAIN_MS);
    clearInterval(watchdog);
    this.pool.closeAll();
    await this.replies.close();
  }

  #tick(): void {
    this.now = Date.now();
    // Idle sockets close, except the one holding a WATCH, and none inside MULTI.
    this.pool.tick(this.now, this.tx.multi ? Infinity : this.options.idleMs, this.tx.watch);
  }

  #handle(argv: Uint8Array[], raw: Uint8Array): void {
    this.commands++;

    if (this.pass) return passRequest(this, this.pass, argv, raw);
    const name = lower(argv[0]);

    if (!this.authed && !BEFORE_AUTH.has(name)) return this.replies.reply(NOAUTH);

    const entry = this.target.table.get(name),
      m = this.tx.multi;

    if (m && !TX_CONTROL.has(name)) return queue(this, m, name, entry, argv, raw);

    if (this.#answer(name, entry, argv, raw)) return;

    if (UNSUPPORTED.has(name)) return this.replies.reply(unsupported(name));

    if (PUBSUB.has(name)) return pubsub(this, name, argv, raw);

    if (!entry) return this.replies.reply(unknownCommand(argv));

    if (badArity(entry, argv)) return this.replies.reply(wrongArity(name));
    const idx = keyIndexes(this.target.table, name, argv);

    if (idx === null) return getkeys(this, entry, argv, raw);
    routeKeys(this, name, entry, argv, raw, idx);
  }

  // The commands the router answers itself, or sends somewhere other than their key's shard; false for the rest.
  #answer(name: string, entry: CommandEntry | undefined, argv: Uint8Array[], raw: Uint8Array): boolean {
    switch (name) {
      case "ping":
        this.replies.reply(argv.length > 1 ? bulk(argv[1]) : PONG);
        break;
      case "echo":
        this.replies.reply(argv.length === 2 ? bulk(argv[1]) : wrongArity("echo"));
        break;
      case "quit":
        this.replies.reply(OK);
        this.close();
        break;
      case "select":
        select(this, entry, argv);
        break;
      case "auth":
        if (argv.length !== 2 && argv.length !== 3) this.replies.reply(wrongArity("auth"));
        else login(this, argv.length === 3 ? str(argv[1]) : null, str(argv[argv.length - 1]), this.#authed);
        break;
      case "readonly":
      case "readwrite":
        this.replies.reply(OK);
        break;
      case "hello":
        hello(this, argv);
        break;
      case "client":
        client(this, argv);
        break;
      case "reset":
        reset(this);
        break;
      case "multi":
        multi(this);
        break;
      case "exec":
        exec(this);
        break;
      case "discard":
        discard(this);
        break;
      case "watch":
        watch(this, argv, raw);
        break;
      case "unwatch":
        unwatch(this, raw);
        break;
      case "wait":
        wait(this, argv);
        break;
      case "waitaof":
        this.replies.reply(WAITAOF);
        break;
      case "cluster":
        cluster(this, argv);
        break;
      case "dbsize":
        dbsize(this, entry, argv);
        break;
      case "keys":
        keys(this, entry, argv);
        break;
      case "flushall":
      case "flushdb":
        flush(this, entry, argv);
        break;
      case "scan":
        scan(this, argv);
        break;
      case "randomkey":
        randomkey(this);
        break;
      case "info":
        info(this, argv);
        break;
      case "script":
      case "function":
        scriptOrFunction(this, name, entry, argv, raw);
        break;
      case "config":
        config(this, entry, argv, raw);
        break;
      default:
        return false;
    }

    return true;
  }

  readonly #authed = () => this.replies.reply(OK);
}
