#!/bin/bash
# Deploys the Worker, then the dashboard: the dashboard calls Admin methods the new Worker must already have.
# Runs the unit tests first and checks afterwards that both answer. Wrangler's own environment (an API token,
# CLOUDFLARE_ACCOUNT_ID) picks the account. Usage: scripts/deploy.sh [https://<your-worker>.workers.dev]
set -euo pipefail
cd "$(dirname "$0")/.."
t() { perl -e "alarm $1; exec @ARGV" "${@:2}"; }

for f in $(git ls-files 'src/*.js'); do node --check "$f"; done
t 60 node test/resp.mjs
(cd dashboard && t 120 npm test --silent && t 300 npm run typecheck --silent)

t 600 wrangler deploy
(cd dashboard && t 600 npm run build && t 600 npx wrangler deploy)

# The dashboard's page, through this Worker's DASHBOARD binding.
[ -z "${1:-}" ] || t 60 curl -fsS -o /dev/null -w "dashboard: HTTP %{http_code}\n" "$1/"
echo "Busy shards move to the new code within about 30 s (docs/durability.md#during-a-deploy)."
