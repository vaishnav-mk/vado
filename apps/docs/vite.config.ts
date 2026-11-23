import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // From wherever it's loaded (oxlint reads every vite.config.ts from the repository root).
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), tailwindcss(), tanstackStart(), react()],
});
