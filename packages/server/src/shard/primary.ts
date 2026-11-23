import { DurabilityAlarms } from "durability";
import type { DurabilityScheduler } from "durability";
import { replicaDial } from "../replication/names";
import { Replicator } from "../replication/replicator";
import type { ReplicaNamespace } from "../replication/types";
import { AOF_CHECK_MS } from "./config";
import type { ValkeyHost } from "./host/valkey-host";
import { Rewrites } from "./rewrites";
import type { ValkeyRewriter } from "./rewriter/rewriter";
import type { Upgrader } from "./upgrade";

type ShardAlarms = DurabilityAlarms<"rewriteCheck" | "replicaTick" | "upgrade">;

const logFailure = (what: string) => (e: Error) => console.log(`${what}: ${e.message}`);

export class PrimaryRole {
  readonly alarms: ShardAlarms;
  readonly repl: Replicator;
  readonly rewrites: Rewrites;
  #upgrader: () => Upgrader;
  #checkArmed = false;
  #stopped = false;

  constructor(
    ctx: DurableObjectState,
    host: ValkeyHost,
    scheduler: DurabilityScheduler,
    replicas: ReplicaNamespace,
    deployed: number,
    rewriter: (() => DurableObjectStub<ValkeyRewriter>) | null,
    upgrader: () => Upgrader,
  ) {
    this.#upgrader = upgrader;
    this.alarms = new DurabilityAlarms({
      scheduler,
      handlers: {
        rewriteCheck: () => this.#aofCheck(),
        replicaTick: () => this.#tick(),
        upgrade: () => this.#upgrader().retry(),
      },
    });

    this.repl = new Replicator(ctx.storage, host, {
      name: ctx.id.name ?? "",
      replicas,
      dial: replicaDial(deployed),
      // Not inside the wasm call that appended: the schedule is a storage transaction.
      schedule: (at: number) =>
        queueMicrotask(() => {
          if (!this.#stopped) this.alarms.replicaTick(at).catch(logFailure("replica tick"));
        }),
    });
    this.rewrites = new Rewrites(host, this.repl, rewriter, () => ctx.storage.sync());

    host.onAppend = (bytes: Uint8Array) => {
      this.repl.append(bytes);

      if (!this.#checkArmed) this.#armCheck();
    };
  }

  #armCheck(): void {
    this.#checkArmed = true;

    // The replicator's tick also runs the check.
    if (!this.repl.configured && !this.#stopped)
      queueMicrotask(() => {
        this.alarms.rewriteCheck(Date.now() + AOF_CHECK_MS).catch((e: Error) => {
          this.#checkArmed = false;
          logFailure("rewrite check")(e);
        });
      });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await this.repl.retireAll();
    await this.alarms.purgeBefore(Number.MAX_SAFE_INTEGER);
  }

  async #aofCheck(): Promise<void> {
    if (this.#stopped) return;
    this.#upgrader().checkVersion();
    this.#checkArmed = false;

    if (await this.rewrites.check()) this.#armCheck();
  }

  async #tick(): Promise<void> {
    if (this.#stopped) return;
    await this.repl.tick();
    await this.#aofCheck();
  }
}
