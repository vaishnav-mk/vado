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

// Vendored code, and agent tooling that isn't the project's source.
const NOT_OURS = ["tools/oxlint/anti-slop/**", ".agents/**", ".claude/**", ".pi/**"];

export default defineConfig({
  // The repo root is the app: one Worker with the dashboard and the database (packages/server).
  defaultPackage: ".",
  // The tests are plain Node, without the Worker.
  plugins: process.env.VITEST
    ? []
    : [cloudflare({ viteEnvironment: { name: "ssr" } }), tanstackStart(), react(), tailwindcss()],
  resolve: {
    alias: redis
      ? {}
      : { "@vado/wasm/redis.wasm": fileURLToPath(new URL("packages/wasm/no-redis.js", import.meta.url)) },
  },
  test: { include: ["src/**/*.test.ts", "packages/*/src/**/*.test.js"] },
  lint: {
    ignorePatterns: [...GENERATED, ...NOT_OURS],
    options: { typeAware: true, typeCheck: true },
    // anti-slop (tools/oxlint/anti-slop, vendored from github.com/dmmulroy/anti-slop): every generic rule.
    jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
    rules: {
      "oxc/no-accumulating-spread": "error",
      "anti-slop/no-array-filter-map": "error",
      "anti-slop/no-reduce-accumulator-copy": "error",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-readable-spacing": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
    },
  },
  fmt: { printWidth: 120, ignorePatterns: [...GENERATED, ...NOT_OURS, "*.md"] },
});
