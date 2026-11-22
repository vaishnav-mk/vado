#!/usr/bin/env bash
# Every end-to-end test against a deployed Worker, on fresh databases, over TCP (a Spectrum app) or `npx vado-shim`.
#   BASE=https://<worker> TOKEN=<BENCH_TOKEN> PW=<VALKEY_PASSWORD> [HOST=127.0.0.1] [PORT=6379] [FLAVOUR=redis] test/e2e.sh
# SECONDS_PER_CHECK (default 20) sets how long the hammer runs each check. Exits non-zero on the first failure.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${BASE:?set BASE to the Worker URL}" "${TOKEN:?set TOKEN to its BENCH_TOKEN}" "${PW:?set PW to its VALKEY_PASSWORD}"
export BASE TOKEN PW HOST="${HOST:-127.0.0.1}" PORT="${PORT:-6379}"
run="e2e$(date +%s)${FLAVOUR:+r}"
flavour="${FLAVOUR:+&flavour=$FLAVOUR}"

api() { curl -s -m 600 -H "authorization: Bearer $TOKEN" "$BASE/$1"; }

# Runs a bench test and fails unless the JSON reply satisfies a JavaScript condition on `r`.
expect() {
  api "$1" | node -e '
    const r = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    if (!(new Function("r", `return ${process.argv[1]}`))(r)) { console.error("failed:", JSON.stringify(r)); process.exit(1); }
    console.log("ok", process.argv[1]);' "$2"
}

step() {
  echo "== $1 ($(date -u +%T))"
  shift
  "$@"
}

for n in 1 4 16; do step "create $run-$n" expect "db?db=$run-$n&shards=$n$flavour" "r.db.shards === $n"; done
step "create $run-r" expect "db?db=$run-r&shards=4&replicas=weur,enam$flavour" 'r.db.replicas.length === 2'

DB=$run-1 step "ioredis" node test/ioredis.mjs
DB=$run-4 step "resp3" node test/resp3.mjs
DB=$run-4 step "requests in pieces" node test/chunked.mjs
DB=$run-w step "watch across a shard reset" node test/watch-reset.mjs
DB=$run-16 C=16 SECONDS=${SECONDS_PER_CHECK:-20} step "hammer" node test/hammer.mjs
DB=$run-16 C=16 SECONDS=${SECONDS_PER_CHECK:-20} CHAOS=1 step "hammer with shards reset" node test/hammer.mjs
step "differential, 1 shard against 16" node test/differential.mjs "$RANDOM" 4 16
step "acknowledged writes survive a reset" expect "durability?db=$run-4&n=5000" 'r.acked === 5000 && r.missing === 0 && r.wrong === 0 && r.restarted'
step "writes reach every replica" expect "write?db=$run-r&n=5000&tag=t" 'r.acked === 5000'
step "and read back" expect "verify?db=$run-r&n=5000&tag=t" 'r.missing === 0 && r.wrong === 0'
step "read your writes on replicas" expect "ryw?db=$run-r" 'r.stale === 0'
step "drop" expect "drop?db=$run-1" 'r.dropped && r.failed.length === 0'
step "a dropped database refuses" expect "verify?db=$run-1&n=1&tag=t" '/dropped/.test(r.error ?? "")'
echo "== all passed ($run)"
