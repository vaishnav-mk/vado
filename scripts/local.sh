#!/bin/bash
# Build the wrangler bundle, then restart local workerd (TCP :6380 router, HTTP :8787 bench).
# `local.sh fresh` wipes DO storage first.
cd "$(dirname "$0")/.."
rm -rf .dist && wrangler deploy --dry-run --outdir .dist >/tmp/vd-build.log 2>&1 || { cat /tmp/vd-build.log; exit 1; }
python3 - <<'PY'
import os
mods = ['    (name = "index.js", esModule = embed ".dist/index.js"),']
mods += [f'    (name = "{f}", wasm = embed ".dist/{f}"),' for f in os.listdir(".dist") if f.endswith(".wasm")]
open("config.capnp", "w").write(open("config.capnp.in").read().replace("@MODULES@", "\n".join(mods)).replace("@BUDGET@", os.environ.get("ROUTER_SOCKET_BUDGET", "128")).replace("@PASSWORD@", os.environ.get("VALKEY_PASSWORD", "")).replace("@IDLE_MS@", os.environ.get("ROUTER_IDLE_MS", "30000")).replace("@BENCH_TOKEN@", os.environ.get("BENCH_TOKEN", "local")))
PY
pkill -9 -f "workerd serve config.capnp" 2>/dev/null
while lsof -nP -iTCP:6380 -sTCP:LISTEN >/dev/null 2>&1; do sleep 0.2; done
[ "$1" = fresh ] && rm -rf .local-do && mkdir -p .local-do
nohup "${WORKERD:-node_modules/.bin/workerd}" serve config.capnp --experimental > /tmp/vd.log 2>&1 &
for i in $(seq 50); do lsof -nP -iTCP:6380 -sTCP:LISTEN >/dev/null 2>&1 && exit 0; sleep 0.1; done
echo "workerd failed to start"; cat /tmp/vd.log; exit 1
