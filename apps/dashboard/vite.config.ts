import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Redis (AGPLv3) doubles the upload, so a build carries it only with VADO_REDIS=1; otherwise its wasm is null and
// databases run Valkey.
const redis = process.env.VADO_REDIS === "1";

// VADO_CONTAINERS=1 adds the container application behind the -native flavours (packages/box): an image of each server
// the build carries, from packages/box/Dockerfile, or VADO_VALKEY_IMAGE / VADO_REDIS_IMAGE, digest-pinned images in
// the Cloudflare registry.
const containers = process.env.VADO_CONTAINERS === "1";

const servers = redis ? ["valkey", "redis"] : ["valkey"];

const imageOf = (server: string) => {
  const pinned = process.env[`VADO_${server.toUpperCase()}_IMAGE`];
  const dockerfile = fileURLToPath(new URL("../../packages/box/Dockerfile", import.meta.url));

  return pinned ? { image: pinned } : { dockerfile, build_vars: { SERVER: server } };
};

export default defineConfig({
  // From wherever it's loaded (oxlint reads every vite.config.ts from the repository root).
  root: fileURLToPath(new URL(".", import.meta.url)),
  // The Worker's config stays at the repository root, where the Deploy to Cloudflare button reads it.
  plugins: [
    cloudflare({
      configPath: "../../wrangler.jsonc",
      viteEnvironment: { name: "ssr" },
      config: containers
        ? (config) => ({
            // Each container runs where its shard's object runs (the durable_object policy).
            containers: [
              {
                name: process.env.VADO_CONTAINER_APP,
                class_name: "RedisBox",
                scheduling_policy: "durable_object",
                images: Object.fromEntries(servers.map((s) => [s, imageOf(s)])),
              },
            ],
            vars: { ...config.vars, BOX: servers.join(",") },
          })
        : undefined,
    }),
    tanstackStart(),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: redis
      ? {}
      : { "@vado/wasm/redis.wasm": fileURLToPath(new URL("../../packages/wasm/no-redis.js", import.meta.url)) },
  },
});
