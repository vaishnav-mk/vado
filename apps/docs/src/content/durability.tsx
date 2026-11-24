import { HardDrivesIcon } from "@phosphor-icons/react";
import { Flow, Note } from "../components/blocks";
import { server, source } from "./sources";
import type { Doc } from "./types";

export const durability: Doc = {
  slug: "durability",
  title: "Durability",
  group: "How it works",
  icon: HardDrivesIcon,
  description:
    "Every acknowledged write is in SQLite before its reply leaves. Group commit keeps that cheap under load, a helper object compacts the AOF, and a deploy restarts each shard once it has answered what it read.",
  keywords:
    "durability aof appendfsync sqlite vfs write-through group commit rewrite rewriter fork reset LOST deploy restart drain",
  sections: [
    {
      id: "write-through",
      title: "Write-through storage",
      content: (
        <>
          <p>
            Valkey runs with <code>appendonly yes</code> and <code>appendfsync always</code>. Its files live in a WASI
            file system backed by the shard's SQLite. A file is a set of rows of at most 1 MB, and AOF appends are
            written to SQLite synchronously, by the write or the fsync after it.
          </p>
          <p>
            A Durable Object holds every outgoing message until its storage writes are committed.{" "}
            <strong>So a reply leaves only after the write behind it is durable</strong>, and pipelined writes share one
            commit.
          </p>
          <Flow items={["SET arrives", "Valkey appends to its AOF", "Row written to SQLite", "Commit", "+OK leaves"]} />
        </>
      ),
    },
    {
      id: "group-commit",
      title: "Group commit",
      content: (
        <p>
          After each pass of Valkey's event loop that wrote to the AOF, the shard waits for that commit, with at most
          two in flight. Input that arrives meanwhile runs in the next pass: one AOF write and one commit for all of it.
          Replies wait for their own commit either way, so waiting costs no durability. Under load a commit carries
          about 100 writes instead of 4, and rows written per write fell from 0.26 to 0.008.
        </p>
      ),
    },
    {
      id: "rewrites",
      title: "AOF rewrites in a helper",
      content: (
        <>
          <p>
            A rewrite is due once the AOF's incremental file is at least 8 MB and at least as big as the base, and is
            forced at 64 MB and twice the base, since a restart replays the whole incremental file (about 1 s per 64
            MB). Valkey would fork a child to write the new base. wasm has no <code>fork()</code>, so a rewriter object
            does it:
          </p>
          <ol>
            <li>Valkey opens a new incremental file, as before a fork, and offers the rewrite to the shard.</li>
            <li>The shard sends its rewriter the manifest and every file from before the new incremental file.</li>
            <li>
              The rewriter boots its own Valkey on that copy with nothing expiring, rewrites, and sends back the base
              with a checksum.
            </li>
            <li>The shard writes the base 1 MB per commit while it keeps serving, and checks length and checksum.</li>
            <li>Valkey swaps it in as if a forked child had finished. The swap is one commit.</li>
          </ol>
          <p>
            For a 35.6 MB base, a helper rewrite took 5.2 to 5.9 s while PINGs to the shard stayed at p99 128 to 175 ms.
            Inline, the same rewrite blocks the shard for 1.4 to 1.9 s. A helper rewrite that fails or takes over 120 s
            counts as a failed child, and the shard rewrites inline for the next 10 minutes.
          </p>
          <Note>
            <p>
              A reset mid-rewrite loses nothing: until the swap commits, the stored manifest lists the old files plus
              the new incremental file, which together hold every write.
            </p>
          </Note>
        </>
      ),
    },
    {
      id: "resets",
      title: "When a shard resets",
      content: (
        <>
          <p>
            A shard can reset for a deploy, a crash, an exceeded limit, or a move. It also resets itself if Valkey
            throws mid-command, since its memory can't be trusted after that and its storage can.
          </p>
          <ul>
            <li>
              <strong>Acknowledged writes are kept.</strong> The object restarts and replays its AOF before serving.
            </li>
            <li>
              <strong>In-flight commands get an error</strong>:{" "}
              <code>ERR shard connection lost; the command may or may not have run</code>.
            </li>
            <li>
              <strong>Read-only commands retry once</strong> on a fresh connection. Writes never retry.
            </li>
            <li>
              <strong>WATCH breaks.</strong> EXEC returns a null reply and the transaction doesn't run.
            </li>
            <li>
              <strong>Blocked clients and subscribers lose their wait</strong>, as if the server had restarted.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "deploys",
      title: "Clean restarts on deploy",
      content: (
        <>
          <p>
            In our tests, left alone, the runtime moved a busy object to new code only by resetting it, about 5 minutes
            after a deploy. So a shard restarts itself as soon as it sees newer code: when a router from the new deploy
            connects, or, every 30 s while busy, by asking its rewriter, which always starts on the newest code.
          </p>
          <Flow
            items={[
              "Stop reading input",
              "Answer what Valkey read",
              "Commit those writes",
              "Greet each router again",
              "Routers resend the rest",
            ]}
          />
          <p>
            The second greeting tells the router that no command still waiting for a reply has run, so it sends them all
            again, in order, to the new copy. The one exception is a transaction whose MULTI ran and EXEC didn't: its
            EXEC gets the lost-connection error. Replicas keep serving throughout.
          </p>
        </>
      ),
    },
  ],
  sources: [
    server("wasm-shard/vfs/vfs.ts"),
    server("wasm-shard/host/loop.ts"),
    server("wasm-shard/rewrites.ts"),
    server("wasm-shard/rewriter/rewriter.ts"),
    server("wasm-shard/upgrade.ts"),
    source("packages/wasm/valkey/patches/0004-host-aof-rewrite.patch"),
  ],
};
