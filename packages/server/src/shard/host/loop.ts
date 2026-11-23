import type { VfsStats } from "../vfs/types";
import { SHARD_COMMITS } from "./config";
import { Gauge } from "./gauge";
import type { Sockets } from "./sockets";
import type { ValkeyExports } from "./types";
import { sleep } from "../../shared";

export class Loop {
  readonly commits = new Gauge();
  readonly #vk: ValkeyExports;
  readonly #sockets: Sockets;
  readonly #vfs: VfsStats;
  readonly #sync: (() => Promise<void>) | undefined;
  readonly #fatal: ((error: Error) => void) | undefined;
  readonly #log: (line: string) => void;
  readonly #hzMs: number;
  #queued = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  #lastTick = 0;

  constructor(
    vk: ValkeyExports,
    sockets: Sockets,
    vfs: VfsStats,
    sync: (() => Promise<void>) | undefined,
    fatal: ((error: Error) => void) | undefined,
    log: (line: string) => void,
  ) {
    this.#vk = vk;
    this.#sockets = sockets;
    this.#vfs = vfs;
    this.#sync = sync;
    this.#fatal = fatal;
    this.#log = log;
    this.#hzMs = Math.max(20, vk.rk_next_timeout_ms() || 100);
  }

  get cronRunning(): boolean {
    return this.#timer !== null;
  }

  step(): void {
    // A throw (a wasm trap, a storage error under fd_write) leaves Valkey's memory untrustworthy.
    try {
      this.#vk.rk_tick();
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      this.#log(`rk_tick threw: ${error.stack}`);
      this.#fatal?.(error);
      throw error;
    }
  }

  schedule(): void {
    if (this.#queued) return;
    this.#queued = true;

    if (this.commits.count < SHARD_COMMITS) queueMicrotask(() => this.#wake());
  }

  // Group commit: the output gate holds a commit's replies anyway, so input that arrives meanwhile waits for it.
  #wake(): void {
    this.#queued = false;
    const writes = this.#vfs.writes;
    this.step();

    if (this.#sync && this.#vfs.writes !== writes) {
      this.commits.up();
      this.#sync()
        .catch(() => {})
        .finally(() => {
          this.commits.down();

          if (this.#queued) this.#wake();
        });
    }
  }

  // serverCron runs only while clients are connected, so an idle object can be evicted; an alarm would wake it.
  updateTimer(): void {
    const clients = this.#sockets.clients().length > 0;

    if (clients && !this.#timer) this.#timer = setInterval(() => this.step(), this.#hzMs);
    else if (!clients && this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async stepUntil(done: () => boolean): Promise<void> {
    for (let i = 0; i < 6 && !done(); i++) this.step();

    while (!done()) {
      await sleep(1);
      const now = Date.now();

      if (now !== this.#lastTick) {
        this.#lastTick = now;
        this.step();
      }
    }
  }
}
