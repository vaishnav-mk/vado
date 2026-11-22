import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Redis (AGPLv3) doubles the upload, so a build carries it only with VADO_REDIS=1; otherwise its wasm is null and
// databases run Valkey.
const redis = process.env.VADO_REDIS === "1";

const GENERATED = ["src/routeTree.gen.ts", "packages/server/src/replication/colos.js"];

export default defineConfig({
  // The repo root is the app: one Worker with the dashboard and the database (packages/server).
  defaultPackage: ".",
  // The tests are plain Node, without the Worker.
  plugins: process.env.VITEST ? [] : [cloudflare({ viteEnvironment: { name: "ssr" } }), tanstackStart(), react(), tailwindcss()],
  resolve: { alias: redis ? {} : { "@vado/wasm/redis.wasm": fileURLToPath(new URL("packages/wasm/no-redis.js", import.meta.url)) } },
  test: { include: ["src/**/*.test.ts", "packages/*/src/**/*.test.js"] },
  lint: {
    ignorePatterns: GENERATED,
    options: { typeAware: true, typeCheck: true },
  },
  fmt: { printWidth: 120, ignorePatterns: [...GENERATED, "*.md"] },
});
