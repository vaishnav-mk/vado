#!/usr/bin/env node
// Print a wasm module's imports and exports, one per line, sorted. The JS host
// (src/shard/valkey-host.js) must provide every import and call these exports,
// so a patch that changes this list needs a host change too.
//
//   node packages/wasm/interface.mjs [file.wasm]           print (default: valkey/valkey.wasm)
//   node wasm/interface.mjs [file.wasm] --check <list>     exit 1 with a diff if it differs
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
const missing = want.filter((l) => !have.has(l)); // in the list, gone from the wasm
const added = lines.filter((l) => !wanted.has(l)); // new in the wasm
if (!missing.length && !added.length) {
  console.log(`${wasm}: interface matches ${list} (${lines.length} entries)`);
  process.exit(0);
}
console.log(`${wasm}: interface differs from ${list}`);
for (const l of missing) console.log(`- ${l}`);
for (const l of added) console.log(`+ ${l}`);
process.exit(1);
