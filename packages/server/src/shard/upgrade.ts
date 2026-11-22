// Restarts onto newer code: cleanly, before the runtime resets the object minutes after a deploy with commands in
// flight. Routers that dialed "router-<ms>" get the greeting again before the close (the restart marker), meaning
// nothing they got no reply to ran, so they send it again.
import { count, desc, eq, gte, max } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { UPGRADE_RPC_WAIT_MS, UPGRADE_TRIES, VERSION_CHECK_MS } from "./config";
import type { ValkeyHost } from "./host/valkey-host";
import { resetSoon } from "./reset";
import type { ValkeyRewriter } from "./rewriter/rewriter";
import { restarts } from "./schema";
import type { LastUpgrade, UpgradeReport } from "./types";
import { deployedAt, RESTARTING } from "./version";

/** Whether code deployed at `target` is worth a restart: newer than ours, fewer than UPGRADE_TRIES restarts for it
 *  (or newer) so far, the last VERSION_CHECK_MS ago. A gradual deploy may keep giving this object the old code,
 *  which must not make it restart forever. */
export function mayRestart(own: number, target: number, tries: number, lastAt: number | null, now: number): boolean {
  return own > 0 && target > own && tries < UPGRADE_TRIES && now - (lastAt ?? 0) >= VERSION_CHECK_MS;
}

/** What a primary adds: its rewriter (which runs the newest code whenever it starts) and the retry alarm. */
export interface PrimaryUpgrades {
  rewriter: (() => DurableObjectStub<ValkeyRewriter>) | null;
  retryAt: (at: number) => Promise<void>;
}

export class Upgrader {
  restarting = false;
  #ctx: DurableObjectState;
  #env: Env;
  #db: DrizzleSqliteDODatabase;
  #host: ValkeyHost;
  #primary: PrimaryUpgrades | null;
  #checkedAt = 0;
  #rpcs = 0; // RPCs running commands, which a restart lets finish
  #rpcsDone: (() => void) | null = null;

  constructor(
    ctx: DurableObjectState,
    env: Env,
    db: DrizzleSqliteDODatabase,
    host: ValkeyHost,
    primary: PrimaryUpgrades | null,
  ) {
    this.#ctx = ctx;
    this.#env = env;
    this.#db = db;
    this.#host = host;
    this.#primary = primary;
  }

  /** A busy primary asks its rewriter for the newest code's deploy time, every VERSION_CHECK_MS. */
  checkVersion(): void {
    const rewriter = this.#primary?.rewriter;
    const now = Date.now();

    if (!rewriter || now - this.#checkedAt < VERSION_CHECK_MS) return;
    this.#checkedAt = now;
    rewriter()
      .deployedAt()
      .then((t) => this.upgradeTo(t))
      .catch((e: Error) => {
        if (!/deployedAt/.test(e.message)) console.log(`version check: ${e.message}`); // an older rewriter lacks it
      });
  }

  /** A primary: restarts onto code deployed at `t` if that is newer and the cap allows. */
  async upgradeTo(t: number): Promise<void> {
    if (!this.#primary) return;
    const at = this.restartFor(t);

    if (at !== null) await this.#restart(this.#primary, at);
  }

  /** The `upgrade` alarm: a restart may have come back on the old code while the deploy spreads, so try again. One
   *  that finds itself on the newest code it knows of does nothing. */
  async retry(): Promise<void> {
    const target = this.#db
      .select({ t: max(restarts.deployed) })
      .from(restarts)
      .get()?.t;

    if (target) await this.upgradeTo(target);
  }

  /** Whether to restart onto code deployed at `t` now; if so it is recorded, this instance refuses new work from
   *  here on, and the restart's time is returned. */
  restartFor(t: number): number | null {
    const now = Date.now();

    if (this.restarting) return null;

    const tries = this.#db
      .select({ n: count(), last: max(restarts.at) })
      .from(restarts)
      .where(gte(restarts.deployed, t))
      .get();

    if (!mayRestart(deployedAt(this.#env), t, tries?.n ?? 0, tries?.last ?? null, now)) return null;
    this.#db.insert(restarts).values({ deployed: t, at: now }).run();
    this.restarting = true;

    return now;
  }

  // Its replicas keep serving meanwhile; the next instance copies to them, and they move to its code then.
  async #restart(primary: PrimaryUpgrades, at: number): Promise<void> {
    // A retry that can't be scheduled mustn't stop this restart: `restarting` refuses all work until the reset.
    await primary.retryAt(at + VERSION_CHECK_MS).catch((e: Error) => console.error(`upgrade retry: ${e.message}`));
    const t0 = Date.now();
    const drained = await this.#host.drain();
    const report: UpgradeReport = { from: this.#env.VERSION.id, ...drained, drainMs: Date.now() - t0 };
    await this.#rpcsFinished();
    report.ms = Date.now() - t0; // the clock moves only across I/O, which each phase is
    this.#db
      .update(restarts)
      .set({ report: JSON.stringify(report) })
      .where(eq(restarts.at, at))
      .run();
    await resetSoon(this.#ctx, RESTARTING);
  }

  /** The last restart onto newer code, as the instance that restarted reported it, or null. */
  lastUpgrade(): LastUpgrade | null {
    const row = this.#db.select().from(restarts).orderBy(desc(restarts.at)).limit(1).get();

    if (!row) return null;
    const report: UpgradeReport = JSON.parse(row.report ?? "{}");

    return { deployed: row.deployed, at: row.at, ...report };
  }

  /** Runs an RPC that runs commands, counted so a restart lets it finish. */
  async running<T>(rpc: () => Promise<T>): Promise<T> {
    this.#rpcs++;

    try {
      return await rpc();
    } finally {
      if (--this.#rpcs === 0) this.#rpcsDone?.();
    }
  }

  async #rpcsFinished(): Promise<void> {
    if (!this.#rpcs) return;

    await new Promise<void>((resolve) => {
      this.#rpcsDone = resolve;
      setTimeout(resolve, UPGRADE_RPC_WAIT_MS);
    });
  }
}
