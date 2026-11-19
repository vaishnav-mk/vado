// One Valkey shard: a Durable Object running valkey.wasm with its AOF in the object's SQLite.
import { DurableObject } from "cloudflare:workers";
import valkeyWasm from "../vendor/valkey.wasm";
import { ValkeyHost } from "./valkey-host.js";
import { command, concat, decodeAll } from "./resp.js";

// Valkey's own config. appendfsync always + the write-through Vfs: a reply leaves only after the
// AOF bytes behind it are in SQLite (the output gate holds it until then).
const valkeyArgs = (env) => [
  "--port", "6379", "--bind", "127.0.0.1", "--protected-mode", "no", "--daemonize", "no",
  "--io-threads", "1", "--logfile", "", "--loglevel", env.VALKEY_LOGLEVEL || "warning",
  "--dir", "/data", "--save", "",
  "--appendonly", "yes", "--appendfsync", "always", "--appenddirname", "aof",
  "--aof-use-rdb-preamble", "yes", "--aof-timestamp-enabled", "no",
  "--auto-aof-rewrite-percentage", "100", "--auto-aof-rewrite-min-size", env.VALKEY_AOF_REWRITE_MIN || "8mb",
  "--maxmemory", env.VALKEY_MAXMEMORY || "64mb", "--maxmemory-policy", env.VALKEY_MAXMEMORY_POLICY || "noeviction",
  // Every RPC batch and router socket is a new Valkey connection. The default accepts 10 per event
  // loop cycle, which queued hundreds of RPC batches until callers gave up (seen at 96 x 4 load).
  "--max-new-connections-per-cycle", "1000",
];

export class ValkeyShard extends DurableObject {
  #host;
  #bornAt = Date.now();
  #instance = crypto.randomUUID();

  constructor(ctx, env) {
    super(ctx, env);
    this.#host = new ValkeyHost(valkeyWasm, ctx.storage.sql, { args: valkeyArgs(env) });
  }

  // TCP: one connection = one Valkey client. Routers dial "router:6379" and get this instance's id
  // as the first frame, so they know exactly which instance accepted the socket (see Upstream.check).
  async connect(socket) {
    const { localAddress } = await socket.opened;
    await this.#host.serve(socket, localAddress?.startsWith("router") ? `+${this.#instance}\r\n` : null);
  }

  /** Runs commands on a pooled internal client and returns the decoded (RESP2) replies. For fan-out/admin. */
  async run(cmds) {
    return decodeAll(await this.#host.execBatch(concat(cmds.map(command)), cmds.length));
  }

  /** The router's RPC mode: `count` raw RESP requests in, their raw replies out (pooled client).
   *  Without `count` (an older router mid-deploy) it falls back to a throwaway client. */
  async execRaw(bytes, count, proto = 2) {
    return count ? await this.#host.execBatch(bytes, count, proto) : await this.#host.exec(bytes);
  }

  /** Like run, but returns the raw reply bytes. */
  async runRaw(cmds) {
    return await this.#host.execBatch(concat(cmds.map(command)), cmds.length);
  }

  /** Identifies this in-memory instance; a reset, eviction or isolate move gives a new one. */
  instance() {
    return this.#instance;
  }

  /** Test hook: hard-reset this object (as a crash or deploy would). */
  abort(reason = "test abort") {
    this.ctx.abort(new Error(reason));
  }

  stats() {
    return { ...this.#host.stats(), instance: this.#instance, aliveSeconds: (Date.now() - this.#bornAt) / 1000, files: this.#host.files() };
  }
}
