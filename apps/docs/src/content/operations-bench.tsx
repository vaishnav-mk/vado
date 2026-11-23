import { Note, Table } from "../components/blocks";
import type { DocSection } from "./types";

export const BENCH_SECTION: DocSection = {
  id: "bench",
  title: "The bench API",
  content: (
    <>
      <p>
        <code>{"https://<your-worker>.workers.dev/<test>?..."}</code> with{" "}
        <code>{"Authorization: Bearer <BENCH_TOKEN>"}</code>. Every test takes <code>db</code> (default{" "}
        <code>default</code>), and <code>{"via=shard&shard=<i>"}</code> to skip the router.
      </p>
      <Table
        headers={["Test", "What it does"]}
        rows={[
          ["db", "Create a database, or return its record: shards, regions, replicas, flavour, password=new"],
          ["stats, shards", "Each shard's host stats, files and replica states; shards adds Valkey's INFO"],
          ["throughput", "Pipelined SETs (op=get reads them back) over conns connections: n, batch, value, keys"],
          ["latency", "One PING, then n GETs one at a time: first reply, p50, p99 and max"],
          ["run", 'The commands in a POSTed JSON array, such as [["SET","k","v"],["GET","k"]]'],
          ["send", "Run another test from a Sender object in region, so load starts where you choose"],
          ["durability, write, verify", "Write known keys, abort every shard (or deploy in between), read them back"],
          ["abort", "Hard-reset one shard, all of them, or one region's replicas"],
          ["staleness, ryw", "Replica lag seen by a second connection; stale reads on one connection"],
          ["commit", "How long shard 0's storage takes to confirm a write, from inside the object"],
          ["rewrite", "BGREWRITEAOF on shard 0 while another connection PINGs it"],
          ["fill, frag", "Write until OOM; measure fragmentation of wasm memory against used_memory"],
          ["churn", "n connections, par at a time, each AUTH, SET, GET and close"],
          ["drop", "Drop a database for good. Its name is never reused and its shards keep only a tombstone"],
        ]}
      />
      <Note>
        <p>
          <code>BENCH_TOKEN</code> is full control. It can run commands on any database, including straight to a shard
          past most of the router's filters (<code>via=shard</code> still refuses CONFIG and the unsupported commands),
          drop databases, abort shards and start load you pay for. Keep it unset unless you need it.
        </p>
      </Note>
    </>
  ),
};
