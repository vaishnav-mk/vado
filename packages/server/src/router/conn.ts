// A client connection's state, shared by the command handlers, and what its upstreams and replies call back into.
import type { DatabaseRecord } from "../catalog/types";
import { command } from "../protocol/resp";
import { ROUTER_HIGH_WATER, ROUTER_LOW_WATER } from "./config";
import { isolateFull } from "./isolate";
import { isPrimary } from "./key-shards";
import { UpstreamPool } from "./pool";
import { ReadYourWrites } from "./read-your-writes";
import { ReplyQueue } from "./replies";
import { droppedDatabase, HELLO3, LOST } from "./replies-text";
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
  /** Commands handled, read by the live view. */
  commands = 0;
  /** A coarse clock for the watchdog, refreshed every tick. */
  now = Date.now();
  proto: 2 | 3 = 2;
  name: string | null = null;
  closed = false;
  authed: boolean;
  /** RESP2 pub/sub passthrough: the pubsub upstream. */
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

  /** Whether the client must not be read: too much unacknowledged here, on an upstream, or in the isolate. */
  blocked(): boolean {
    return isolateFull(this) || this.replies.inflight > ROUTER_HIGH_WATER || this.pool.above(ROUTER_HIGH_WATER);
  }

  /** Resolves on the wake() that finds everything below the low marks. */
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

  // A shard connection's state is gone. The WATCH stays set, so the next EXEC knows it was watched and aborts
  // (a null reply, as on a conflict) instead of running unconditionally on a new instance.
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

    if (lost) this.push(LOST);
  }

  /** A shard refused because the database was dropped after this isolate cached its record: forget the record,
   *  so the next connection is refused at AUTH, and say so. */
  dropped(): Uint8Array {
    this.options.onDropped(this.db.name);

    return droppedDatabase(this.db.name);
  }
}
