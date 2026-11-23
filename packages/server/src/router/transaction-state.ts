import type { Multi, Upstream } from "./types";

export class Tx {
  multi: Multi | null = null;
  watch: number | null = null;
  watchUp: Upstream | null = null;
  watchBroken = false;

  get pinned(): boolean {
    return this.multi !== null || this.watch !== null;
  }

  clearWatch(): void {
    this.watch = null;
    this.watchUp = null;
    this.watchBroken = false;
  }
}
