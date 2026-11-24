#!/usr/bin/env node
// Print a wasm module's imports and exports, sorted. The host in packages/server/src/wasm-shard/host/
// must provide every import, so a change to this list needs a host change too.
//
//   node packages/wasm/interface.mjs [file.wasm]                  print (default: valkey/valkey.wasm)
//   node packages/wasm/interface.mjs [file.wasm] --check <list>   exit 1 with a diff if it differs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const at = args.indexOf("--check");
const list = at >= 0 ? args.splice(at, 2)[1] : null;

if (at >= 0 && !list) {
  console.error("usage: interface.mjs [file.wasm] [--check <interface.txt>]");
  process.exit(2);
}

const wasm = args[0] ?? fileURLToPath(new URL("valkey/valkey.wasm", import.meta.url));

const mod = new WebAssembly.Module(readFileSync(wasm));

const lines = [
  ...WebAssembly.Module.imports(mod).map((i) => `import ${i.module}.${i.name} ${i.kind}`),
  ...WebAssembly.Module.exports(mod).map((e) => `export ${e.name} ${e.kind}`),
].sort();

if (!list) {
  process.stdout.write(lines.join("\n") + "\n");
  process.exit(0);
}

const want = readFileSync(list, "utf8").split("\n").filter(Boolean);
const have = new Set(lines);
const wanted = new Set(want);
const missing = want.filter((l) => !have.has(l));
const added = lines.filter((l) => !wanted.has(l));

if (!missing.length && !added.length) {
  console.log(`${wasm}: interface matches ${list} (${lines.length} entries)`);
  process.exit(0);
}

console.log(`${wasm}: interface differs from ${list}`);

for (const l of missing) console.log(`- ${l}`);

for (const l of added) console.log(`+ ${l}`);

process.exit(1);
