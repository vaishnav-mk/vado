/** A count of work in flight that can be awaited down to zero. */
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

  /** Resolves when the count is zero (checked again on waking: new work may have started meanwhile). */
  async zero(): Promise<void> {
    while (this.count) await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Whether `work` settles within `ms`. */
export async function within(work: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)));

  try {
    return await Promise.race([work.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
