#!/bin/bash
# End-to-end hammer against production from this machine: stock clients over the public WebSocket
# ingress (scripts/ws-shim.mjs), plus in-Cloudflare load through the bench API.
# Wait at least 5 minutes after a deploy before running. Output: results/prod-hammer-<time>.log
cd "$(dirname "$0")/.."
B=${VADO_URL:?set VADO_URL to the deployed Worker, e.g. https://vado.example.workers.dev}
TOKEN=${TOKEN:-$(cat .bench-token)} PW=${PW:-$(cat .valkey-password)}
mkdir -p results
OUT=results/prod-hammer-$(date -u +%Y%m%dT%H%M).log
t(){ perl -e "alarm $1; exec @ARGV" "${@:2}"; }
api(){ curl -s -m 900 -H "authorization: Bearer $TOKEN" "$B/$1"; }
log(){ echo "=== $(date -u +%T) $*" | tee -a "$OUT"; }
run(){ "$@" 2>&1 | grep -v '^\[ioredis\]' | tee -a "$OUT"; }
export TOKEN PW BASE=$B
want(){ [ -z "$PHASES" ] || [[ " $PHASES " == *" $1 "* ]]; }  # PHASES="P3 P6" runs a subset

pkill -f "ws-shim.mjs.*6399" 2>/dev/null
node scripts/ws-shim.mjs "${B/https:/wss:}/ws" 6399 >/tmp/shim-prod.log 2>&1 &
SHIM=$!
trap 'kill $SHIM 2>/dev/null' EXIT
sleep 1

if want P1; then
log "P1 functional: ioredis + RESP3 over the public WebSocket"
PORT=6399 DB=e2e-io run t 180 node test/ioredis.mjs
PORT=6399 DB=e2e-r3 run t 60 node test/resp3.mjs
run valkey-cli -p 6399 PING
run valkey-cli -p 6399 --user e2e-cli --pass wrong --no-auth-warning PING
fi

if want P2; then
log "P2 hammer, no chaos (16 shards)"
api "db?db=hammer16&shards=16" | tee -a "$OUT"; echo | tee -a "$OUT"
PORT=6399 DB=hammer16 C=32 SECONDS=60 run t 900 node test/hammer.mjs
fi

if want P3; then
log "P3 hammer with chaos (random shard aborts)"
PORT=6399 DB=hammer16 C=32 SECONDS=120 CHAOS=1 run t 1200 node test/hammer.mjs
fi

if want P4; then
log "P4 valkey-benchmark over the WebSocket (16 shards)"
api "db?db=bench16&shards=16" >/dev/null
run t 900 valkey-benchmark -h 127.0.0.1 -p 6399 --user bench16 -a "$PW" -c 50 -n 100000 -P 16 -t set,get,incr,lpush,rpop,sadd,hset,zadd,mset --csv
run t 900 valkey-benchmark -h 127.0.0.1 -p 6399 --user bench16 -a "$PW" -c 100 -n 20000 -P 1 -t set,get --csv
fi

if want P5; then
log "P5 in-Cloudflare load: 24 parallel requests x 4 connections, fresh 16-shard DB"
api "db?db=cfh16&shards=16" >/dev/null
pids=(); for i in $(seq 1 24); do api "throughput?db=cfh16&n=100000&batch=2000&conns=4&prefix=h$i" > /tmp/ph_$i.json & pids+=($!); done; wait "${pids[@]}"
python3 - <<'PY' | tee -a "$OUT"
import json
rs=[json.load(open(f'/tmp/ph_{i}.json')) for i in range(1,25)]
ok=[r for r in rs if 'ms' in r]
ms=max(r['ms'] for r in ok); n=sum(r['n'] for r in ok)
print(json.dumps({'requests':len(rs),'ok':len(ok),'aggregateOpsPerSec':round(n/ms*1000),'errors':sum(r['errors'] for r in ok),'firstError':next((r['firstError'] for r in ok if r['firstError']),None)}))
PY
fi

if want P6; then
log "P6 billed SQLite rows per unpipelined write (1-shard DB)"
api "db?db=rowsp&shards=1" >/dev/null
run node -e '
const Redis = require("ioredis");
const r = new Redis({ port: 6399, username: "rowsp", password: process.env.PW });
const st = () => fetch(process.env.BASE + "/stats?db=rowsp", { headers: { authorization: "Bearer " + process.env.TOKEN } }).then((x) => x.json()).then((j) => j.shards[0]);
(async () => {
  await r.set("warm", "1");
  const a = await st();
  for (let i = 0; i < 300; i++) await r.set("r" + i, "v".repeat(20));
  const b = await st();
  console.log(JSON.stringify({ rowsPerWrite: (b.vfs.rowsWritten - a.vfs.rowsWritten) / 300, sameInstance: a.instance === b.instance }));
  console.log("P7 waiting 45 s with the client connected to check idle upstream close");
  await new Promise((s) => setTimeout(s, 45000));
  const c = await st();
  console.log(JSON.stringify({ socketsAfterIdle: c.sockets, cronRunning: c.cronRunning, getAfterIdle: await r.get("r1") }));
  r.disconnect();
})();'
fi

if want P8; then
log "P8 new databases default to 1 shard"
api "db?db=newdefault-$(date +%s)" | tee -a "$OUT"; echo | tee -a "$OUT"
fi

if want P9; then
log "P9 idle WebSocket client for 300 s, then PING"
run node -e '
const Redis = require("ioredis");
const r = new Redis({ port: 6399, username: "idlews", password: process.env.PW, retryStrategy: () => null });
(async () => { await r.set("k", "v"); const t0 = Date.now(); await new Promise((s) => setTimeout(s, 300000)); console.log(JSON.stringify({ idleSeconds: (Date.now() - t0) / 1000, ping: await r.ping().catch((e) => e.message), status: r.status })); r.disconnect(); })();'
fi

log "done"
