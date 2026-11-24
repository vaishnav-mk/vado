// The workspace's checks and tests. Each app builds with its own vite.config.ts (apps/dashboard, apps/docs).
import { defineConfig } from "vite-plus";

const GENERATED = [
  "apps/*/src/routeTree.gen.ts",
  "worker-configuration.d.ts",
  "packages/server/src/catalog/colos.json",
];

// Vendored code, and agent tooling that isn't the project's source.
const NOT_OURS = ["tools/oxlint/anti-slop/**", ".agents/**", ".claude/**", ".pi/**"];

export default defineConfig({
  // Plain Node, without the Worker.
  test: { include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"] },
  lint: {
    ignorePatterns: [...GENERATED, ...NOT_OURS],
    options: { typeAware: true, typeCheck: true },
    // anti-slop (tools/oxlint/anti-slop, vendored from github.com/dmmulroy/anti-slop): every generic rule.
    jsPlugins: [
      { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
      { name: "durability", specifier: "@durability/lint" },
    ],
    rules: {
      "max-lines": ["error", { max: 250 }],
      "durability/abort-after-sync": "error",
      "durability/alarm-runner-only": "error",
      "durability/durability-migrations-only": "error",
      "durability/no-alarm-changes-in-alarm-handler": "error",
      "durability/no-delete-all-in-transaction": "error",
      "durability/no-deferred-storage-writes": "error",
      "durability/transaction-sync-callback": "error",
      "durability/transform-next-once": "error",
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
