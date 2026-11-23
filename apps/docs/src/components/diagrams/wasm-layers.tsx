import { ArrowDownIcon, ArrowUpIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { SERVERS } from "../../content/servers";
import type { Server } from "../../content/servers";
import { PATCHES, patchTotals } from "../../content/wasm-patch-list";
import { ByServer, ServerName } from "../server";

export type Origin = "upstream" | "ours" | "toolchain";

export function OriginLegend() {
  return (
    <div className="diagram-legend">
      <span>
        <i className="origin-key" data-origin="upstream" />
        <span>
          Upstream <ServerName />, compiled as released
        </span>
      </span>
      <span>
        <i className="origin-key" data-origin="ours" />
        Ours: patches, shims, stubs, host
      </span>
      <span>
        <i className="origin-key" data-origin="toolchain" />
        Toolchain: wasi-sdk, binaryen
      </span>
    </div>
  );
}

function Layer({ origin, title, children }: { origin: Origin; title: ReactNode; children: ReactNode }) {
  return (
    <div className="layer" data-origin={origin}>
      <strong>{title}</strong>
      <span>{children}</span>
    </div>
  );
}

function PatchChips({ server }: { server: Server }) {
  const { count, changed } = patchTotals(server);

  return (
    <div className="layer-patches">
      <span>
        {count} patches, {changed} lines in all:
      </span>
      {PATCHES[server].map((patch) => (
        <code key={patch.file} data-origin="ours">
          {patch.file}
        </code>
      ))}
    </div>
  );
}

const EXPORTS = ["_initialize", "rk_boot_args", "rk_tick", "rk_next_timeout_ms", "rk_rewrite_done", "memory"];

const IMPORTS = ["host.socket, listen, accept", "host.read, write, close, poll", "host.aof_rewrite", "env.__c_longjmp"];

const WASI = "wasi_snapshot_preview1: fd_*, path_*, clock_time_get, ...";

const HOST: [string, string][] = [
  ["loop.ts", "Calls rk_tick on socket input and on the serverCron timer"],
  ["sockets.ts", "The host.* socket imports: listener, client fds, poll"],
  ["wasi.ts, shard/vfs/", "Files in the object's SQLite, the clock, log lines"],
  ["aof-rewrite.ts", "Takes an AOF rewrite and has a rewriter object write it"],
];

export function LayersDiagram() {
  return (
    <figure className="diagram-card">
      <div className="diagram-top">
        <span className="status">One shard, top to bottom</span>
        <span className="max-md:hidden">The module, the wasm boundary, the host</span>
      </div>
      <div className="layers">
        <div className="layer-box">
          <span className="layer-box-title">
            <ByServer valkey={<code>valkey.wasm</code>} redis={<code>redis.wasm</code>} />
            one WASI reactor module, single-threaded
          </span>
          <div className="layer" data-origin="upstream">
            <strong>
              <ServerName /> <ByServer valkey={SERVERS.valkey.version} redis={SERVERS.redis.version} /> server, Lua and
              the bundled deps
            </strong>
            <span>The release source, unchanged except for the patches</span>
            <ByServer valkey={<PatchChips server="valkey" />} redis={<PatchChips server="redis" />} />
          </div>
          <div className="layer-row">
            <Layer origin="ours" title="Shims, packages/wasm/wasi/">
              Event loop backend, sockets over host imports, rk_* exports, setjmp helpers, missing headers
            </Layer>
            <Layer origin="ours" title="stubs.c">
              Turns off fork, threads, TLS, dlopen and backtraces
            </Layer>
          </div>
          <Layer origin="toolchain" title="wasi-libc and its dlmalloc">
            From the wasi-sdk 34 sysroot
          </Layer>
        </div>
        <div className="boundary" aria-label="The wasm boundary, listed in interface.txt">
          <div className="boundary-side">
            <span className="boundary-title">
              <ArrowUpIcon aria-hidden="true" /> Exports: the host calls these
            </span>
            <span className="boundary-list">
              {EXPORTS.map((name) => (
                <code key={name}>{name}</code>
              ))}
            </span>
          </div>
          <div className="boundary-side">
            <span className="boundary-title">
              <ArrowDownIcon aria-hidden="true" /> Imports: the host implements these
            </span>
            <span className="boundary-list">
              {IMPORTS.map((name) => (
                <code key={name}>{name}</code>
              ))}
              <code>{WASI}</code>
            </span>
          </div>
        </div>
        <div className="layer-box">
          <span className="layer-box-title">
            The shard's Durable Object, TypeScript in <code>shard/host/</code>
          </span>
          <div className="layer-grid">
            {HOST.map(([file, text]) => (
              <Layer key={file} origin="ours" title={<code>{file}</code>}>
                {text}
              </Layer>
            ))}
          </div>
        </div>
      </div>
      <OriginLegend />
    </figure>
  );
}
