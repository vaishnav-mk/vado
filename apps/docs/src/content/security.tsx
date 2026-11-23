import { LockKeyIcon } from "@phosphor-icons/react";
import { Note } from "../components/blocks";
import { server } from "./sources";
import type { Doc } from "./types";

export const security: Doc = {
  slug: "security",
  title: "Security",
  group: "Run it",
  icon: LockKeyIcon,
  description:
    "Who can connect, what clients may change, how data travels, where copies live, and what the bench token and the dashboard allow.",
  keywords:
    "security auth password per-database rate limit constant time CONFIG SET allowed tls spectrum transport replicas data location bench token dashboard at rest",
  sections: [
    {
      id: "authentication",
      title: "Authentication",
      content: (
        <ul>
          <li>
            <strong>A shared password.</strong> <code>VALKEY_PASSWORD</code> makes AUTH mandatory, and the AUTH username
            names the database. There are no users or ACLs within a database.
          </li>
          <li>
            <strong>Optional per-database passwords.</strong> A database created with <code>password=new</code> takes
            only its own password over TCP or the WebSocket. The catalog keeps a salted SHA-256 of it. Any other
            database takes the shared password, and a service binding's shared password opens every database.
          </li>
          <li>
            <strong>A wrong password creates nothing.</strong> AUTH checks the shared password before it looks up or
            creates a database. Passwords are compared in constant time.
          </li>
          <li>
            <strong>Failed AUTHs are rate limited</strong> to 30 a minute per client address, then refused for a minute.
            Service bindings aren't limited.
          </li>
          <li>
            <strong>Before AUTH</strong>, only AUTH, HELLO and QUIT run, and requests are capped at 64 KB.
          </li>
        </ul>
      ),
    },
    {
      id: "no-password",
      title: "Without a password",
      content: (
        <p>
          Anything that reaches <code>connect()</code> is in. That is fine behind a service binding, which only your own
          Workers can call. Set the password before putting Spectrum in front; <code>/ws</code> refuses to serve without
          one.
        </p>
      ),
    },
    {
      id: "config",
      title: "What clients can change",
      content: (
        <>
          <p>
            Persistence, memory, networking and auth belong to the service. <code>CONFIG SET</code> takes only settings
            that change how data behaves: <code>maxmemory-policy</code>, <code>maxmemory-samples</code>,{" "}
            <code>notify-keyspace-events</code>, the listpack, ziplist, intset, HyperLogLog and stream encoding
            thresholds, <code>lfu-log-factor</code>, <code>lfu-decay-time</code>, the slowlog and latency monitor
            settings, <code>busy-reply-threshold</code>, <code>lua-time-limit</code> and <code>activerehashing</code>.
          </p>
          <p>
            An allowed setting goes to every primary and lasts until that shard restarts. Anything else gets an error.
            CONFIG inside MULTI, SAVE, BGREWRITEAOF and ACL are refused.
          </p>
        </>
      ),
    },
    {
      id: "transport",
      title: "Transport",
      content: (
        <ul>
          <li>
            <strong>Spectrum:</strong> turn on TLS. Without it the password and all data cross the internet in plain
            text.
          </li>
          <li>
            <strong>WebSocket:</strong> use <code>wss://</code>. The shim's local port is plain text on 127.0.0.1.
          </li>
          <li>
            <strong>Service binding:</strong> stays inside Cloudflare.
          </li>
          <li>
            <strong>Between objects:</strong> only code in this Worker holds the bindings that reach shards, replicas
            and rewriters. Clients reach only the router.
          </li>
        </ul>
      ),
    },
    {
      id: "replicas",
      title: "Replicas and data location",
      content: (
        <p>
          A replica is a full copy of its shard, in memory, in its region. Data that must stay in one region doesn't
          belong in a database with shards or replicas elsewhere. Replica names can't be claimed by a client: database
          names can't contain dots, so no database maps onto <code>{"<shard>.r.<region>"}</code>. Object names carry
          database names, so anyone who can read the Worker's logs can see which databases exist.
        </p>
      ),
    },
    {
      id: "dashboard",
      title: "The bench token and the dashboard",
      content: (
        <>
          <p>
            The bench API is off unless <code>BENCH_TOKEN</code> is set, and with the token anyone can do anything to
            any database. The dashboard lists every database's name and anyone can watch one; watching reads one key a
            second for response times.
          </p>
          <Note>
            <p>
              Data is stored in Durable Object SQLite with no encryption of its own on top. Replicas keep their copy in
              memory only. A rewriter stores a copy of its shard's AOF only while a rewrite runs.
            </p>
          </Note>
        </>
      ),
    },
  ],
  sources: [
    server("router/auth.ts"),
    server("router/secrets.ts"),
    server("router/command-sets.ts"),
    server("catalog/names.ts"),
    server("bench/bench.ts"),
  ],
};
