// When to rewrite the AOF, and handing rewrites to the shard's ValkeyRewriter.
import { command, str } from "../protocol/resp";
import type { Replicator } from "../replication/replicator";
import { AOF_HELPER_RETRY_MS, AOF_REWRITE_CAP, AOF_REWRITE_IDLE_MS, AOF_REWRITE_MIN } from "./config";
import type { ValkeyHost } from "./host/valkey-host";
import { infoFields } from "./info";
import { rewriteByHelper } from "./rewriter/client";
import type { ValkeyRewriter } from "./rewriter/rewriter";
import type { RewriteLog } from "./types";

export class Rewrites {
  last: RewriteLog | null = null;
  #host: ValkeyHost;
  #repl: Replicator;
  #rewriter: (() => DurableObjectStub<ValkeyRewriter>) | null;
  #sync: () => Promise<void>;
  #inlineUntil = 0; // after a failed helper rewrite, rewrite inline until then

  constructor(
    host: ValkeyHost,
    repl: Replicator,
    rewriter: (() => DurableObjectStub<ValkeyRewriter>) | null,
    sync: () => Promise<void>,
  ) {
    this.#host = host;
    this.#repl = repl;
    this.#rewriter = rewriter;
    this.#sync = sync;

    if (rewriter)
      host.onRewrite = (tmp: string, rdb: boolean) =>
        this.#helper() ? () => this.#byHelper(rewriter, tmp, rdb) : null;
  }

  #helper(): boolean {
    return this.#rewriter !== null && Date.now() >= this.#inlineUntil;
  }

  async #byHelper(rewriter: () => DurableObjectStub<ValkeyRewriter>, tmp: string, rdb: boolean): Promise<boolean> {
    const log: RewriteLog = { at: Date.now(), rdb };
    this.last = log;

    try {
      await rewriteByHelper(this.#host, rewriter(), tmp, rdb, this.#sync, log);
      log.ms = Date.now() - log.at;

      return true;
    } catch (e) {
      this.#inlineUntil = Date.now() + AOF_HELPER_RETRY_MS;
      log.ms = Date.now() - log.at;
      log.error = e instanceof Error ? e.message : String(e);
      console.log(`rewrite by helper failed after ${log.ms} ms: ${log.error}`);

      return false;
    }
  }

  /** Rewrites once the incr file outgrows the base. A helper rewrite doesn't stop the shard; an inline one does, so
   *  that waits for a quiet moment, unless the incr file has grown so big that a restart would take too long to
   *  replay it. Returns whether one is still due. */
  async check(): Promise<boolean> {
    if (this.#repl.copying || this.#host.rewriting) return true; // a replica copy needs the files to only grow
    const info = infoFields(str(await this.#host.execBatch(command(["INFO", "persistence"]), 1)));
    const base = Number(info.aof_base_size ?? "0");
    const incr = Number(info.aof_current_size ?? "0") - base;
    const due = incr >= Math.max(AOF_REWRITE_MIN, base) || this.#repl.rdbDue;
    const quiet = Date.now() - this.#host.lastActive >= AOF_REWRITE_IDLE_MS;

    if (incr >= Math.max(AOF_REWRITE_CAP, 2 * base) || (due && (this.#helper() || quiet))) {
      await this.#host.execBatch(command(["BGREWRITEAOF"]), 1);
      this.#repl.rdbDue = false;

      return false;
    }

    return due;
  }
}
