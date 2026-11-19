#!/bin/bash
# Full local suite against workerd: stock ioredis, RESP3, differential (1 vs N shards), kill -9
# durability, then password mode (test/auth.mjs).
set -e -o pipefail
cd "$(dirname "$0")/.."
t(){ perl -e "alarm $1; exec @ARGV" "${@:2}"; }
scripts/local.sh fresh || exit 1
t 120 node test/ioredis.mjs
t 60 node test/resp3.mjs
t 120 node test/chunked.mjs
t 60 node test/watch-reset.mjs
t 600 node test/differential.mjs 1 30 16
t 600 node test/differential.mjs 7 30 5
t 120 node test/kill9.mjs
KILL_AFTER_MS=4000 t 120 node test/kill9.mjs
# Password mode: AUTH gate, database selection, WebSocket ingress, idle upstream close, rows per write.
export VALKEY_PASSWORD=local-pass ROUTER_IDLE_MS=3000
scripts/local.sh || exit 1
t 180 node test/auth.mjs
# No BENCH_TOKEN: the bench API is refused, whatever the header says.
BENCH_TOKEN= scripts/local.sh || exit 1
for h in "Bearer undefined" "Bearer " ""; do
  [ "$(curl -s -o /dev/null -w "%{http_code}" -H "authorization: $h" http://127.0.0.1:8787/stats)" = 401 ] || { echo "bench API open without BENCH_TOKEN ($h)"; exit 1; }
done
echo "local suite passed"
