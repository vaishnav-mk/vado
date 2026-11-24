import { withTimeout } from "../../shared";

export class Gauge {
  count = 0;
  #waiters: (() => void)[] = [];

  up(): void {
    this.count++;
  }

  down(): void {
    if (--this.count) return;

    for (const wake of this.#waiters.splice(0)) wake();
  }

  async zero(): Promise<void> {
    while (this.count) await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }
}

// Whether `work` settled within `ms`.
export const within = (work: Promise<void>, ms: number): Promise<boolean> =>
  withTimeout(work, ms, "work").then(
    () => true,
    () => false,
  );
