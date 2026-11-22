// A Watcher per database being looked at (GET /live?db=<name>, a WebSocket). While anyone watches, it polls
// every shard and ready replica once a second from an alarm (src/admin/snapshot.js), measures response time
// on connections of its own, and sends every watcher the same picture: rates, history, events and where
// traffic comes from. It also starts and stops test traffic (src/bench/sender.js). Kept in memory only: a
// view of now, not a record, and an eviction just starts the history again.
//
// Messages, all JSON:
//   { type: "init", history: Point[], events: Event[], state: State | null }   on connecting
//   { type: "tick", point: Point, events: Event[], state: State }               every poll
// The shapes are documented on #state(), #point() and #event() below.
import { DurableObject } from "cloudflare:workers";
import { lookup } from "../catalog/databases.js";
import { RespClient } from "../client/resp-client.js";
import { commands } from "../router/serve.js";
import { coloOf, REGION_NAMES, WORLD } from "../replication/regions.js";
import { TEST_TRAFFIC_MS, WATCH_HISTORY, WATCH_MS, WATCH_RATE_POLLS } from "../constants.js";
import { shardSnapshots } from "./snapshot.js";
import { dbView, place, shardView } from "./views.js";

const EVENTS_KEPT = 100;
const RESTARTING_MS = 10_000; // a shard counts as restarting for this long after it comes back
const MEMORY_HIGH = 0.9, MEMORY_OK = 0.8; // warn once above the first, again only after dropping below the second
const TEST_SENDERS = { light: 1, medium: 3, heavy: 6 }; // per region
const PROBE_KEY = "dashboard:probe";

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : null);
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
const keep = (xs, x, n) => { xs.push(x); if (xs.length > n) xs.splice(0, xs.length - n); return xs; };
/** Per second, between the oldest and newest of `pts` ({ at, [key] }). */
const rate = (pts, key) => (pts.length < 2 || pts.at(-1).at === pts[0].at ? 0 : Math.max(0, (pts.at(-1)[key] - pts[0][key]) / ((pts.at(-1).at - pts[0].at) / 1000)));

export class Watcher extends DurableObject {
  #name = null;
  #state = null;
  #history = [];
  #events = [];
  #fresh = []; // events since the last tick
  #shards = new Map(); // shard i -> what the last polls saw: instance, version, call counts, replica states
  #isolates = new Map(); // router isolate -> its last few { at, commands } on this database
  #asked = new Map(); // shard i -> when the dashboard asked it to restart
  #reader = null; #writer = null; // probe connections: a reader never writes, so it reads where clients would
  #probes = [];
  #test = null;
  #seq = 0; // event ids

  async fetch(req) {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket upgrade", { status: 426 });
    this.#name ??= new URL(req.url).searchParams.get("db");
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "init", history: this.#history, events: this.#events, state: this.#state }));
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage() {} // watchers only listen
  webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code); } catch { /* already closed */ } }

  // One poll per alarm while anyone is watching: each has the budget of a fresh request.
  async alarm() {
    this.#name ??= this.ctx.id.name;
    const watchers = this.ctx.getWebSockets();
    if (!watchers.length) return this.#idle();
    const started = Date.now();
    await this.#poll();
    const msg = JSON.stringify({ type: "tick", point: this.#history.at(-1), events: this.#fresh, state: this.#state });
    this.#fresh = [];
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(msg); } catch { /* closing */ } }
    await this.ctx.storage.setAlarm(started + WATCH_MS);
  }

  /** Noted on the timeline by the Admin API: something someone did from the dashboard. */
  note(kind, text) {
    this.#event("info", kind, text);
  }

  /** The dashboard is about to restart shard `i`: say how long it takes to come back. */
  restarting(i) {
    this.#asked.set(i, Date.now());
    this.#event("info", "action", `Restarting shard ${i}`, { shard: i });
  }

  /** Starts test traffic: `level` light, medium or heavy senders per region, from `from` (a region or
   *  "everywhere"). It stops by itself after TEST_TRAFFIC_MS, or when nobody is watching. */
  async startTest(level, from) {
    if (!TEST_SENDERS[level]) throw new Error("level is light, medium or heavy");
    if (from !== "everywhere" && !WORLD.includes(from)) throw new Error("from is everywhere or a region");
    this.#name ??= this.ctx.id.name;
    await this.stopTest(false);
    const since = Date.now(), until = since + TEST_TRAFFIC_MS;
    this.#test = { level, from, since, until, senders: this.#senders(level, from) };
    await Promise.all(this.#test.senders.map(({ region, k }) => this.#sender(region, k).loop(this.#name, `test-${region}${k}-`, until)));
    this.#event("info", "test", `Test traffic started: ${level}, from ${from === "everywhere" ? "everywhere" : REGION_NAMES[from]}`);
    return this.#testView();
  }

  async stopTest(say = true, why = "Test traffic stopped") {
    const t = this.#test;
    if (!t) return null;
    this.#test = null;
    await Promise.all(t.senders.map(({ region, k }) => this.#sender(region, k).stop().catch(() => {})));
    if (say) this.#event("info", "test", why);
    return null;
  }

  #senders(level, from) {
    const regions = from === "everywhere" ? WORLD : [from];
    return regions.flatMap((region) => Array.from({ length: TEST_SENDERS[level] }, (_, k) => ({ region, k })));
  }

  #sender(region, k) {
    return this.env.SENDER.getByName(`${region}/${k}`, { locationHint: region });
  }

  #testView() {
    const t = this.#test;
    return t && { level: t.level, from: t.from, since: t.since, until: t.until, senders: t.senders.length };
  }

  async #idle() {
    await this.stopTest(true, "Test traffic stopped: nobody is watching");
    this.#reader?.close(); this.#writer?.close();
    this.#reader = this.#writer = null;
  }

  async #poll() {
    const at = Date.now();
    if (this.#test && at >= this.#test.until) { this.#test = null; this.#event("info", "test", "Test traffic stopped after 10 minutes"); } // the senders stop themselves
    let error = null, shards = this.#state?.shards ?? [], entries = this.#state?.map.entries ?? [], db = this.#state?.db ?? null, here = this.#state?.watcher ?? null;
    try {
      const record = await lookup(this.env, this.#name);
      if (!record || record.dropped) throw new Error(`There is no database named ${this.#name}`);
      db = dbView(record);
      const [snaps, table, pulse, colo] = await Promise.all([
        shardSnapshots(this.env, record), commands(this.env),
        this.env.PULSE ? this.env.PULSE.getByName("pulse").snapshot() : { isolates: [] },
        here?.colo ?? coloOf().catch(() => null), this.#probe(),
      ]);
      here = place(colo);
      const seen = { restarts: [], replicas: [], rewrites: [] };
      shards = snaps.map((s, i) => this.#shard(shardView(s, i, table), at, seen));
      this.#summarize(seen);
      entries = this.#entries(pulse.isolates);
    } catch (e) {
      error = e.message;
    }
    const ok = shards.filter((s) => s.ok);
    const sum = (f) => ok.reduce((a, s) => a + f(s), 0);
    const restarting = shards.filter((s) => !s.ok || at - s.restartedAt < RESTARTING_MS).length;
    const replicas = shards.flatMap((s) => s.replicas ?? []);
    const probe = this.#probes.filter((p) => !p.failed);
    // State: everything the page shows, as of `at`.
    this.#state = {
      at, error, db, watcher: here,
      health: error ? "unreachable" : restarting ? "restarting" : shards.length ? "healthy" : "starting", restarting,
      totals: {
        reads: sum((s) => s.reads), writes: sum((s) => s.writes), replicaReads: sum((s) => s.replicas.reduce((a, r) => a + r.reads, 0)),
        keys: sum((s) => s.keys), memory: sum((s) => s.memory.used), maxMemory: sum((s) => s.memory.max), logBytes: sum((s) => s.log.size),
        replicas: replicas.length, replicasReady: replicas.filter((r) => r.state === "ready").length,
        replicaLagMs: Math.max(0, ...replicas.filter((r) => r.state === "ready").map((r) => r.lagMs ?? 0)),
      },
      // Response time measured by this Watcher, from `watcher` (its colo), over the last few polls.
      probe: { readMs: median(probe.map((p) => p.readMs)), writeMs: median(probe.map((p) => p.writeMs)), failed: this.#probes.length - probe.length },
      shards,
      map: { entries }, // where clients connect: per colo, commands per second and open connections
      test: this.#testView(),
    };
    keep(this.#history, this.#point(at), WATCH_HISTORY);
  }

  // Point: one poll, for the charts. reads includes what replicas served.
  #point(t) {
    const s = this.#state;
    const r1 = (x) => Math.round(x * 10) / 10; // a tenth is enough, and keeps small rates from rounding to zero
    return { t, reads: r1(s.totals.reads + s.totals.replicaReads), writes: r1(s.totals.writes), replicaReads: r1(s.totals.replicaReads), readMs: s.probe.readMs, writeMs: s.probe.writeMs };
  }

  // One shard as the page shows it, with rates over the last few polls, and what changed since the last.
  #shard(v, at, seen) {
    const k = this.#shards.get(v.i) ?? { points: [], replicas: new Map() };
    this.#shards.set(v.i, k);
    if (v.down) {
      if (!k.down) this.#event("warning", "restart", `Shard ${v.i} stopped responding`, { shard: v.i });
      k.down = true;
      return { i: v.i, ok: false, error: v.down, colo: k.colo ?? null, city: k.city ?? null, lat: k.lat ?? null, lon: k.lon ?? null, restartedAt: k.restartedAt ?? 0, replicas: [] };
    }
    if (k.instance && k.instance !== v.instance) {
      const asked = this.#asked.get(v.i);
      this.#asked.delete(v.i);
      seen.restarts.push({ i: v.i, deploy: !!(k.version && v.version && k.version !== v.version), backMs: asked ? at - asked : null });
      k.restartedAt = at;
      k.points = [];
    }
    Object.assign(k, { down: false, instance: v.instance, version: v.version, colo: v.colo, city: v.city, lat: v.lat, lon: v.lon });
    keep(k.points, { at, ...v.calls }, WATCH_RATE_POLLS);
    const used = v.memory.max ? v.memory.used / v.memory.max : 0;
    if (used >= MEMORY_HIGH && !k.memoryHigh) this.#event("warning", "memory", `Shard ${v.i} is at ${Math.round(used * 100)}% of its memory`, { shard: v.i });
    if (used >= MEMORY_HIGH) k.memoryHigh = true; else if (used < MEMORY_OK) k.memoryHigh = false;
    const lr = v.log.lastRewrite;
    if (lr?.ms !== undefined && k.rewriteAt !== lr.at) {
      if (k.rewriteAt !== undefined) seen.rewrites.push({ i: v.i, ms: lr.ms, bytes: lr.baseBytes ?? null, error: lr.error ?? null });
      k.rewriteAt = lr.at;
    }
    const replicas = v.replicas.map((r) => {
      const rk = k.replicas.get(r.region) ?? { points: [] };
      k.replicas.set(r.region, rk);
      if (rk.state && rk.state !== r.state) seen.replicas.push({ i: v.i, region: r.region, from: rk.state, to: r.state, error: r.error });
      if (rk.instance !== r.instance) rk.points = [];
      Object.assign(rk, { state: r.state, instance: r.instance });
      if (r.instance) keep(rk.points, { at, reads: r.reads }, WATCH_RATE_POLLS);
      const { instance, ...shown } = r;
      return { ...shown, reads: r.instance ? rate(rk.points, "reads") : 0 };
    });
    const reads = rate(k.points, "reads"), writes = rate(k.points, "writes");
    const { instance, calls, ...shown } = v;
    return { ...shown, ok: true, reads, writes, restartedAt: k.restartedAt ?? 0, replicas };
  }

  // Restarts, log compactions and replica changes seen in one poll, as a few readable events rather than one
  // per shard (a new database's 64 shards all compact at once, say).
  #summarize({ restarts, replicas, rewrites }) {
    const deploys = restarts.filter((r) => r.deploy), others = restarts.filter((r) => !r.deploy);
    if (deploys.length) this.#event("info", "deploy", deploys.length === this.#shards.size && deploys.length > 1 ? `All ${deploys.length} shards restarted for a new deploy` : `${deploys.length === 1 ? `Shard ${deploys[0].i}` : plural(deploys.length, "shard")} restarted for a new deploy`);
    for (const r of others) this.#event("warning", "restart", r.backMs === null ? `Shard ${r.i} restarted` : `Shard ${r.i} restarted and was back in ${(r.backMs / 1000).toFixed(1)} s`, { shard: r.i });
    const failed = rewrites.filter((r) => r.error), done = rewrites.filter((r) => !r.error);
    for (const r of failed) this.#event("warning", "rewrite", `Shard ${r.i} couldn't compact its log in a helper, so it did it itself`, { shard: r.i });
    const mb = (b) => (b < 2 ** 20 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 2 ** 20).toFixed(1)} MB`), sec = (ms) => `${(ms / 1000).toFixed(1)} s`;
    if (done.length === 1) this.#event("success", "rewrite", `Shard ${done[0].i} compacted its log in ${sec(done[0].ms)}${done[0].bytes ? `, to ${mb(done[0].bytes)}` : ""}`, { shard: done[0].i });
    else if (done.length) this.#event("success", "rewrite", `${plural(done.length, "shard")} compacted their logs, the slowest in ${sec(Math.max(...done.map((r) => r.ms)))}`);
    const by = (to) => replicas.filter((r) => r.to === to);
    const one = (r) => `The replica of shard ${r.i} in ${REGION_NAMES[r.region] ?? r.region}`;
    const group = (xs, many, single, level) => { if (xs.length > 1) this.#event(level, "replica", many(xs.length)); else if (xs.length) this.#event(level, "replica", single(xs[0]), { shard: xs[0].i, region: xs[0].region }); };
    group(by("asleep"), (n) => `${plural(n, "replica")} went to sleep: no traffic for 10 minutes`, (r) => `${one(r)} went to sleep: no traffic for 10 minutes`, "info");
    group(by("copying").filter((r) => r.from === "asleep"), (n) => `New traffic woke ${plural(n, "replica")}; they're copying their shards`, (r) => `New traffic woke ${one(r).toLowerCase()}`, "info");
    group(by("copying").filter((r) => r.from !== "asleep"), (n) => `${plural(n, "replica")} started copying their shards`, (r) => `${one(r)} started copying its shard`, "info");
    group(by("ready"), (n) => `${plural(n, "replica")} are ready and serving reads`, (r) => `${one(r)} is ready and serving reads`, "success");
    group(by("idle"), (n) => `${plural(n, "replica")} lost their stream and will copy again`, (r) => `${one(r)} lost its stream${r.error ? ` (${r.error})` : ""} and will copy again`, "warning");
  }

  // Where clients connect: each router isolate's commands per second on this database, summed per colo.
  #entries(isolates) {
    const byColo = new Map(), seen = new Set();
    for (const iso of isolates) {
      seen.add(iso.isolate);
      const conns = iso.conns.filter((c) => c.db === this.#name);
      const commands = (iso.done?.[this.#name] ?? 0) + conns.reduce((a, c) => a + c.commands, 0);
      const pts = this.#isolates.get(iso.isolate) ?? [];
      if (pts.at(-1)?.at !== iso.at) keep(pts, { at: iso.at, commands }, WATCH_RATE_POLLS);
      this.#isolates.set(iso.isolate, pts);
      const ops = rate(pts, "commands");
      if (!conns.length && !ops) continue;
      const e = byColo.get(iso.colo) ?? { ops: 0, conns: 0 };
      e.ops += ops; e.conns += conns.length;
      byColo.set(iso.colo, e);
    }
    for (const id of this.#isolates.keys()) if (!seen.has(id)) this.#isolates.delete(id);
    return [...byColo].map(([colo, e]) => ({ ...place(colo), ops: e.ops, conns: e.conns })).filter((e) => e.city);
  }

  // Response time: a GET on a connection that only reads (so it reads from a replica when clients would)
  // and a SET on one that only writes. Kept open between polls, so it's a request, not a connection setup.
  async #probe() {
    const timed = async (c, cmd) => { const t = performance.now(); const [r] = await c.call(cmd); if (r?.err) throw new Error(r.err); return performance.now() - t; };
    try {
      if (!this.#reader) { this.#reader = await RespClient.open(this.env, this.#name, 5_000); await timed(this.#reader, ["GET", PROBE_KEY]); }
      if (!this.#writer) { this.#writer = await RespClient.open(this.env, this.#name, 5_000); await timed(this.#writer, ["SET", PROBE_KEY, "0"]); }
      const [readMs, writeMs] = await Promise.all([timed(this.#reader, ["GET", PROBE_KEY]), timed(this.#writer, ["SET", PROBE_KEY, String(Date.now())])]);
      keep(this.#probes, { readMs, writeMs }, WATCH_RATE_POLLS);
    } catch {
      this.#reader?.close(); this.#writer?.close();
      this.#reader = this.#writer = null;
      keep(this.#probes, { failed: true }, WATCH_RATE_POLLS);
    }
  }

  // Event: { id, t, level: info | success | warning | error, kind: action | test | deploy | restart | replica |
  // rewrite | memory, text, shard?, region?, count }. The same text again within a minute counts up instead
  // (same id, a later t), so a page replaces events by id.
  #event(level, kind, text, about = {}) {
    const t = Date.now(), last = this.#events[0];
    if (last && last.text === text && t - last.t < 60_000) { last.count++; last.t = t; this.#fresh.push(last); return; }
    const e = { id: ++this.#seq, t, level, kind, text, ...about, count: 1 };
    this.#events.unshift(e);
    if (this.#events.length > EVENTS_KEPT) this.#events.pop();
    this.#fresh.push(e);
  }
}
