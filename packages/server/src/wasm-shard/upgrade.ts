import { count, desc, eq, gte, max } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { UPGRADE_RPC_WAIT_MS, UPGRADE_TRIES, VERSION_CHECK_MS } from "./config";
import { Gauge } from "./host/gauge";
import { within } from "../shared";
import type { WasmHost } from "./host/wasm-host";
import { resetSoon } from "./reset";
import type { ValkeyRewriter } from "./rewriter/rewriter";
import { restarts } from "./schema";
import type { LastUpgrade, UpgradeReport } from "../shard/types";
import { deployedAt, RESTARTING } from "../shard/version";

// A gradual deploy may keep giving this object the old code, which must not make it restart forever.
export function mayRestart(own: number, target: number, tries: number, lastAt: number | null, now: number): boolean {
  return own > 0 && target > own && tries < UPGRADE_TRIES && now - (lastAt ?? 0) >= VERSION_CHECK_MS;
}

// A rewriter runs the newest code whenever it starts.
export interface PrimaryUpgrades {
  rewriter: (() => DurableObjectStub<ValkeyRewriter>) | null;
  retryAt: (at: number) => Promise<void>;
}

export class Upgrader {
  restarting = false;
  #ctx: DurableObjectState;
  #env: Env;
  #db: DrizzleSqliteDODatabase;
  #host: WasmHost;
  #primary: PrimaryUpgrades | null;
  #checkedAt = 0;
  readonly #rpcs = new Gauge();

  constructor(
    ctx: DurableObjectState,
    env: Env,
    db: DrizzleSqliteDODatabase,
    host: WasmHost,
    primary: PrimaryUpgrades | null,
  ) {
    this.#ctx = ctx;
    this.#env = env;
    this.#db = db;
    this.#host = host;
    this.#primary = primary;
  }

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

  async upgradeTo(t: number): Promise<void> {
    if (!this.#primary) return;
    const at = this.restartFor(t);

    if (at !== null) await this.#restart(this.#primary, at);
  }

  // A restart may have come back on the old code while the deploy spreads.
  async retry(): Promise<void> {
    const target = this.#db
      .select({ t: max(restarts.deployed) })
      .from(restarts)
      .get()?.t;

    if (target) await this.upgradeTo(target);
  }

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
    await within(this.#rpcs.zero(), UPGRADE_RPC_WAIT_MS);
    report.ms = Date.now() - t0; // the clock moves only across I/O, which each phase is
    this.#db
      .update(restarts)
      .set({ report: JSON.stringify(report) })
      .where(eq(restarts.at, at))
      .run();
    await resetSoon(this.#ctx, RESTARTING);
  }

  lastUpgrade(): LastUpgrade | null {
    const row = this.#db.select().from(restarts).orderBy(desc(restarts.at)).limit(1).get();

    if (!row) return null;
    const report: UpgradeReport = JSON.parse(row.report ?? "{}");

    return { deployed: row.deployed, at: row.at, ...report };
  }

  async running<T>(rpc: () => Promise<T>): Promise<T> {
    this.#rpcs.up();

    try {
      return await rpc();
    } finally {
      this.#rpcs.down();
    }
  }
}
