import { VFS_SWEEP_BYTES, VFS_SWEEP_MS } from "../vfs/config";
import { viewsOf } from "../vfs/memory";
import type { FileEntry, VfsStorage } from "../vfs/types";
import { Vfs } from "../vfs/vfs";
import { aofRewrite } from "./aof-rewrite";
import { Internal } from "./internal";
import { Loop } from "./loop";
import { drain, serve } from "./serve";
import { Sockets } from "./sockets";
import type { DrainReport, HostOptions, HostStats, RewriteHook, TagConstructor, ValkeyExports } from "./types";
import { wasiImports } from "./wasi";
import type { ByteSocket, Protocol } from "../../protocol/types";
import { decoder, encoder, messageOf, sleep } from "../../shared";

const wasm: { Memory: unknown; Tag?: unknown } = WebAssembly;

// SAFETY: workerd has the exception-handling proposal's WebAssembly.Tag; TypeScript's lib lacks it or won't import it.
const Tag = wasm.Tag as TagConstructor;

export class ValkeyHost {
  onRewrite: RewriteHook | null = null;
  rewriting: Promise<void> | null = null;
  rewriteDoneMs: number | null = null;
  lastActive = 0; // not moved by quiet sockets
  onInput: (() => void) | null = null;
  readonly #vk: ValkeyExports;
  readonly #vfs: Vfs;
  readonly #sockets = new Sockets();
  readonly #loop: Loop;
  readonly #internal: Internal;
  readonly #sync: (() => Promise<void>) | undefined;
  readonly #log: (line: string) => void;
  #sweeping = false;

  constructor(module: WebAssembly.Module, storage: VfsStorage, options: HostOptions = {}) {
    const { args = [], log = (line: string) => console.log("[valkey]", line), sync, fatal } = options;
    this.#sync = sync;
    this.#log = log;
    const memory = () => this.#vk.memory;
    const views = viewsOf(memory);
    this.#vfs = new Vfs(storage, memory);
    this.#vfs.onTrash = () => void this.#sweep();
    void this.#sweep(); // left from before a restart

    const host = {
      ...this.#sockets.imports(views, {
        schedule: () => this.#loop.schedule(),
        closed: () => this.#loop.updateTimer(),
      }),
      aof_rewrite: aofRewrite({
        state: this,
        text: (ptr, len) => decoder.decode(views.u8().subarray(ptr, ptr + len)),
        finish: (ok, generation) => this.#vk.rk_rewrite_done(ok ? 1 : 0, generation) !== 0,
        remove: (path) => this.#vfs.remove(path),
        sync,
        log,
        schedule: () => this.#loop.schedule(),
      }),
    };

    const instance = new WebAssembly.Instance(module, {
      wasi_snapshot_preview1: wasiImports(views, this.#vfs, log),
      host,
      env: { __c_longjmp: new Tag({ parameters: ["i32"] }) },
    });

    // SAFETY: both wasm builds export these (packages/wasm/*/interface.txt).
    this.#vk = instance.exports as ValkeyExports;
    this.#vk._initialize();
    const argv = encoder.encode(args.map((a) => a + "\0").join(""));

    if (argv.length > this.#vk.rk_args_cap()) throw new Error("valkey args too long");
    views.u8().set(argv, this.#vk.rk_args_ptr());
    const rc = this.#vk.rk_boot_args(argv.length);

    if (rc !== 0) throw new Error(`valkey boot failed (${rc})`);
    this.#loop = new Loop(this.#vk, this.#sockets, this.#vfs.stats, sync, fatal, log);
    this.#internal = new Internal(this.#sockets, this.#loop);
  }

  // Replication bytes: client reading pauses on them too.
  hold(n: number): void {
    this.#sockets.hold(n);
  }

  release(n: number): void {
    this.#sockets.release(n);
  }

  execBatch(bytes: Uint8Array, count: number, proto: Protocol = 2): Promise<Uint8Array> {
    return this.#internal.execBatch(bytes, count, proto);
  }

  serve(socket: ByteSocket, greeting: string | null = null, quiet = false, farewell: string | null = null) {
    return serve(this.#sockets, this.#loop, this, socket, greeting, quiet, farewell);
  }

  drain(): Promise<DrainReport> {
    return drain(this.#sockets, this.#loop, this.#internal.batches, this.#sync);
  }

  async #sweep(): Promise<void> {
    if (this.#sweeping) return;
    this.#sweeping = true;

    try {
      await Promise.resolve(); // not inside the wasm call that deleted the file

      while (this.#vfs.sweep(VFS_SWEEP_BYTES)) await sleep(VFS_SWEEP_MS);
    } catch (e) {
      this.#log(`vfs sweep: ${messageOf(e)}`);
    } finally {
      this.#sweeping = false;
    }
  }

  stats(): HostStats {
    return {
      wasmMemoryBytes: this.#vk.memory.buffer.byteLength,
      sockets: this.#sockets.clients().length,
      pooled: this.#internal.pooled,
      cronRunning: this.#loop.cronRunning,
      vfs: this.#vfs.stats,
    };
  }

  files(): FileEntry[] {
    return this.#vfs.listing();
  }

  readFile(path: string, pos: number, len: number): Uint8Array | null {
    return this.#vfs.read(path, pos, len);
  }

  appendFile(path: string, bytes: Uint8Array): void {
    this.#vfs.append(path, bytes);
  }

  removeFile(path: string): void {
    this.#vfs.remove(path);
  }

  flushFiles(): void {
    this.#vfs.flush();
  }

  fileSize(path: string): number | null {
    return this.#vfs.size(path);
  }

  set onAppend(f: ((bytes: Uint8Array) => void) | null) {
    this.#vfs.onAppend = f;
  }
}
