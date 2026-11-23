import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Redis (AGPLv3) doubles the upload, so a build carries it only with VADO_REDIS=1; otherwise its wasm is null and
// databases run Valkey.
const redis = process.env.VADO_REDIS === "1";

export default defineConfig({
  // From wherever it's loaded (oxlint reads every vite.config.ts from the repository root).
  root: fileURLToPath(new URL(".", import.meta.url)),
  // The Worker's config stays at the repository root, where the Deploy to Cloudflare button reads it.
  plugins: [
    cloudflare({ configPath: "../../wrangler.jsonc", viteEnvironment: { name: "ssr" } }),
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
