import { defineConfig } from "vite-plus";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const GENERATED = ["src/routeTree.gen.ts", "packages/server/src/replication/colos.js"];

export default defineConfig({
  // The repo root is the app: one Worker with the dashboard and the database (packages/server).
  defaultPackage: ".",
  // The tests are plain Node, without the Worker.
  plugins: process.env.VITEST ? [] : [cloudflare({ viteEnvironment: { name: "ssr" } }), tanstackStart(), react(), tailwindcss()],
  test: { include: ["src/**/*.test.ts", "packages/*/src/**/*.test.js"] },
  lint: {
    ignorePatterns: GENERATED,
    options: { typeAware: true, typeCheck: true },
  },
  fmt: { printWidth: 120, ignorePatterns: [...GENERATED, "*.md"] },
});
