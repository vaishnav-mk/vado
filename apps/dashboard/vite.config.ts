import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Redis (AGPLv3) doubles the upload, so a build carries it only with VADO_REDIS=1; otherwise its wasm is null and
// databases run Valkey.
const redis = process.env.VADO_REDIS === "1";

// VADO_CONTAINERS=1 adds the container application behind the redis-native flavour (packages/box): Redis 8.12.0 built
// from packages/box/redis/Dockerfile, or VADO_REDIS_IMAGE, a digest-pinned image in the Cloudflare registry.
const containers = process.env.VADO_CONTAINERS === "1";

const redisImage = process.env.VADO_REDIS_IMAGE
  ? { image: process.env.VADO_REDIS_IMAGE }
  : { dockerfile: fileURLToPath(new URL("../../packages/box/redis/Dockerfile", import.meta.url)) };

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
                images: { redis: redisImage },
              },
            ],
            vars: { ...config.vars, BOX: "1" },
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
