import { worker } from "@vado/server";

// Named, not `export *`: wrangler reads these names to type the bindings in worker-configuration.d.ts.
export { ValkeyShard } from "@vado/server/wasm-shard/shard.ts";

export {
  ValkeyShard1,
  ValkeyShard2,
  ValkeyShard3,
  ValkeyShard4,
  ValkeyShard5,
  ValkeyShard6,
  ValkeyShard7,
  ValkeyShard8,
  ValkeyShard9,
  ValkeyShard10,
  ValkeyShard11,
  ValkeyShard12,
  ValkeyShard13,
  ValkeyShard14,
  ValkeyShard15,
} from "@vado/server/wasm-shard/classes.ts";

export { ValkeyRewriter } from "@vado/server/wasm-shard/rewriter/rewriter.ts";

export {
  ValkeyRewriter1,
  ValkeyRewriter2,
  ValkeyRewriter3,
  ValkeyRewriter4,
  ValkeyRewriter5,
  ValkeyRewriter6,
  ValkeyRewriter7,
} from "@vado/server/wasm-shard/rewriter/classes.ts";

export { RedisBox } from "@vado/server/container-shard/box.ts";

export { Catalog } from "@vado/server/catalog/catalog.ts";

export { Pulse } from "@vado/server/admin/pulse.ts";

export { Watcher } from "@vado/server/admin/watcher/watcher.ts";

export { Sender } from "@vado/server/bench/sender.ts";

export default worker({
  // Lazily, so the Durable Objects, which never serve a page, don't load the dashboard.
  fetch: async (req: Request) => (await import("@tanstack/react-start/server-entry")).default.fetch(req),
});
