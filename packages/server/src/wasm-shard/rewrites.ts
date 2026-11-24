import { command, str } from "../protocol/resp";
import type { Replicator } from "./replication/replicator";
import { AOF_REWRITER_RETRY_MS, AOF_REWRITE_CAP, AOF_REWRITE_IDLE_MS, AOF_REWRITE_MIN } from "./config";
import type { WasmHost } from "./host/wasm-host";
import { infoFields } from "../protocol/info";
import { rewriteOnRewriter } from "./rewriter/client";
import type { RewriteLog } from "../shard/types";
import type { RewriterStub } from "./types";
import { messageOf } from "../shared";

export class Rewrites {
  last: RewriteLog | null = null;
  #host: WasmHost;
  #repl: Replicator;
  #sync: () => Promise<void>;
  #inlineUntil = 0;

  constructor(host: WasmHost, repl: Replicator, rewriter: RewriterStub, sync: () => Promise<void>) {
    this.#host = host;
    this.#repl = repl;
    this.#sync = sync;
    host.onRewrite = (tmp: string, rdb: boolean) =>
      this.#useRewriter() ? () => this.#byRewriter(rewriter, tmp, rdb) : null;
  }

  #useRewriter(): boolean {
    return Date.now() >= this.#inlineUntil;
  }

  async #byRewriter(rewriter: RewriterStub, tmp: string, rdb: boolean): Promise<boolean> {
    const log: RewriteLog = { at: Date.now(), rdb };
    this.last = log;

    try {
      await rewriteOnRewriter(this.#host, rewriter(), tmp, rdb, this.#sync, log);
      log.ms = Date.now() - log.at;

      return true;
    } catch (e) {
      this.#inlineUntil = Date.now() + AOF_REWRITER_RETRY_MS;
      log.ms = Date.now() - log.at;
      log.error = messageOf(e);
      console.log(`rewrite by rewriter failed after ${log.ms} ms: ${log.error}`);

      return false;
    }
  }

  async check(): Promise<boolean> {
    if (this.#repl.copying || this.#host.rewriting) return true; // a replica copy needs the files to only grow
    const info = infoFields(str(await this.#host.execBatch(command(["INFO", "persistence"]), 1)));
    const base = Number(info.aof_base_size ?? "0");
    const incr = Number(info.aof_current_size ?? "0") - base;
    const due = incr >= Math.max(AOF_REWRITE_MIN, base) || this.#repl.rdbDue;
    const quiet = Date.now() - this.#host.lastActive >= AOF_REWRITE_IDLE_MS;

    if (incr >= Math.max(AOF_REWRITE_CAP, 2 * base) || (due && (this.#useRewriter() || quiet))) {
      await this.#host.execBatch(command(["BGREWRITEAOF"]), 1);
      this.#repl.rdbDue = false;

      return false;
    }

    return due;
  }
}
