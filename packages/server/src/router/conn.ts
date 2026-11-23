import type { DatabaseRecord } from "../catalog/types";
import { command, HELLO3 } from "../protocol/resp";
import { ROUTER_HIGH_WATER, ROUTER_LOW_WATER } from "./config";
import { isolateFull } from "./isolate";
import { isPrimary } from "./key-shards";
import { UpstreamPool } from "./pool";
import { ReadYourWrites } from "./read-your-writes";
import { ReplyQueue } from "./replies";
import { droppedDatabase } from "./replies-text";
import { Tx } from "./transaction-state";
import type {
  ClientSocket,
  DatabaseHandles,
  ReplyOwner,
  RouterOptions,
  ShardStub,
  UpKey,
  Upstream,
  UpstreamOwner,
} from "./types";

export class Conn implements UpstreamOwner, ReplyOwner {
  static #ids = 0;
  readonly id = ++Conn.#ids;
  commands = 0;
  // Refreshed by the watchdog, so commands needn't call Date.now().
  now = Date.now();
  proto: 2 | 3 = 2;
  name: string | null = null;
  closed = false;
  authed: boolean;
  pass: Upstream | null = null;
  target: DatabaseHandles;
  readonly dial: string;
  readonly options: RouterOptions;
  readonly socket: ClientSocket;
  readonly replies: ReplyQueue;
  readonly pool = new UpstreamPool(this);
  readonly tx = new Tx();
  readonly writes = new ReadYourWrites();
  #waiter: (() => void) | null = null;

  constructor(socket: ClientSocket, target: DatabaseHandles, options: RouterOptions) {
    this.socket = socket;
    this.target = target;
    this.options = options;
    this.dial = options.dial;
    this.authed = options.password === undefined;
    this.replies = new ReplyQueue(socket.writable.getWriter(), this);
  }

  get db(): DatabaseRecord {
    return this.target.db;
  }

  blocked(): boolean {
    return isolateFull(this) || this.replies.inflight > ROUTER_HIGH_WATER || this.pool.above(ROUTER_HIGH_WATER);
  }

  paused(): Promise<void> {
    return new Promise((wake) => {
      this.#waiter = wake;
    });
  }

  wake(): void {
    const waiter = this.#waiter;

    if (!waiter || isolateFull(this)) return;

    if (this.replies.inflight > ROUTER_LOW_WATER || this.pool.above(ROUTER_LOW_WATER)) return;
    this.#waiter = null;
    waiter();
  }

  close(): void {
    this.closed = true;
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.();
  }

  stubOf(key: UpKey): ShardStub {
    if (key === "pubsub") return this.target.pubsub();

    if (isPrimary(key)) return this.target.shard(key);
    const shard = Number(key.slice(1));

    return this.target.replica(shard) ?? this.target.shard(shard);
  }

  setup(): Uint8Array[] {
    const out: Uint8Array[] = [];

    if (this.proto === 3) out.push(HELLO3);

    if (this.name) out.push(command(["CLIENT", "SETNAME", this.name]));

    return out;
  }

  push(frame: Uint8Array): void {
    this.replies.push(frame);
  }

  // The WATCH stays set, so the next EXEC aborts as on a conflict instead of running unwatched on a new instance.
  lostConnection(up: Upstream): void {
    if (up === this.tx.watchUp) this.tx.watchBroken = true;
  }

  dropUpstream(up: Upstream): void {
    this.pool.drop(up);
    this.lostConnection(up);
  }

  endPassthrough(lost: boolean): void {
    const pass = this.pass;

    if (!pass) return;
    pass.passthrough = null;
    this.pass = null;

    // Its subscriptions went with the shard: closed, as a Redis server going away would leave it, the client reconnects
    // and subscribes again. An error frame here would reach a client expecting only pushes.
    if (lost) this.close();
  }

  // Dropped after this isolate cached its record: forget it, so the next connection is refused at AUTH.
  dropped(): Uint8Array {
    this.options.onDropped(this.db.name);

    return droppedDatabase(this.db.name);
  }
}
