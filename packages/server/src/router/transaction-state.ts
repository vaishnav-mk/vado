import type { Multi, Upstream } from "./types";

/** A connection's MULTI and WATCH. */
export class Tx {
  multi: Multi | null = null;
  /** The shard WATCH pinned. */
  watch: number | null = null;
  /** The upstream (one Valkey connection) holding the WATCH. */
  watchUp: Upstream | null = null;
  /** That connection died: the shard forgot the WATCH, so EXEC must abort. */
  watchBroken = false;

  /** Inside MULTI or WATCH: reads aren't retryable and go to the primary. */
  get pinned(): boolean {
    return this.multi !== null || this.watch !== null;
  }

  clearWatch(): void {
    this.watch = null;
    this.watchUp = null;
    this.watchBroken = false;
  }
}
