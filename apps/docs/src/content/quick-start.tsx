import { RocketLaunchIcon } from "@phosphor-icons/react";
import { Code, Note, Table } from "../components/blocks";
import { DocLink } from "../components/doc-link";
import { ByServer, ServerBadge } from "../components/server";
import { SERVERS } from "./servers";
import { REPO, source } from "./sources";
import type { Doc } from "./types";

export const quickStart: Doc = {
  slug: "quick-start",
  title: "Quick start",
  group: "Start here",
  icon: RocketLaunchIcon,
  description: "Deploy the Worker, then connect valkey-cli or ioredis. About ten minutes on Workers Paid.",
  keywords:
    "install setup deploy button connect valkey-cli ioredis shim spectrum service binding local dev redis flavour VADO_REDIS",
  sections: [
    {
      id: "deploy",
      title: "1. Deploy",
      content: (
        <>
          <p>
            <a href={`https://deploy.workers.cloudflare.com/?url=${REPO}`}>
              <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" height={32} />
            </a>
          </p>
          <p>
            The button copies the repository into your GitHub account, asks for <code>VALKEY_PASSWORD</code>, builds and
            deploys. The Worker's URL is the dashboard, which watches databases.
          </p>
          <Table
            headers={["Setting", "What to enter"]}
            rows={[
              [
                <code>VALKEY_PASSWORD</code>,
                <>
                  The password clients send with <code>{"AUTH <database> <password>"}</code>. It also opens{" "}
                  <code>/ws</code>. Generate one with <code>openssl rand -hex 32</code>.
                </>,
              ],
            ]}
          />
          <p>Or from a checkout:</p>
          <ByServer
            valkey={
              <Code label="Terminal">{"npm install\nnpx wrangler secret put VALKEY_PASSWORD\nnpm run deploy"}</Code>
            }
            redis={
              <Code label="Terminal">
                {"npm install\nnpx wrangler secret put VALKEY_PASSWORD\nVADO_REDIS=1 npm run deploy"}
              </Code>
            }
          />
          <p>
            <ServerBadge />{" "}
            <ByServer
              valkey={
                <>
                  Every build carries Valkey, whose wasm build is {SERVERS.valkey.licence}. A database runs it unless it
                  was created as Redis.
                </>
              }
              redis={
                <>
                  Redis ships only in builds made with <code>VADO_REDIS=1</code>, and its wasm build is{" "}
                  {SERVERS.redis.licence} (
                  <DocLink slug="flavours" hash="licence">
                    what that asks of you
                  </DocLink>
                  ).
                </>
              }
            />
          </p>
        </>
      ),
    },
    {
      id: "connect-tcp",
      title: "2. Connect valkey-cli",
      content: (
        <>
          <ByServer
            valkey={
              <p>
                The AUTH username picks the database. A database is created on its first AUTH, with 1 shard, Valkey and
                no replicas. For more shards or replicas, create it first on the{" "}
                <DocLink slug="operations" hash="create">
                  bench API
                </DocLink>
                .
              </p>
            }
            redis={
              <>
                <p>
                  The AUTH username picks the database. One created on its first AUTH runs Valkey, so create a Redis
                  database first, with <code>flavour=redis</code> on the{" "}
                  <DocLink slug="operations" hash="create">
                    bench API
                  </DocLink>
                  . Set its token first with <code>npx wrangler secret put BENCH_TOKEN</code>. The flavour never changes
                  after that.
                </p>
                <Code label="Bench API">
                  {
                    'curl -H "authorization: Bearer $BENCH_TOKEN" \\\n  "https://<your-worker>.workers.dev/db?db=mydb&flavour=redis"'
                  }
                </Code>
              </>
            }
          />
          <p>There are two ways in from outside Cloudflare.</p>
          <p>
            <strong>Over TCP:</strong> add a Spectrum application with this Worker as its origin, on port 6379. Worker
            origins are in beta, and need a Pro or Business zone (one such application per zone) or Spectrum Enterprise.
            Only Spectrum Enterprise terminates TLS (<code>flexible</code>); on Pro and Business the connection is plain
            text, since the Worker doesn't terminate TLS itself. Spectrum doesn't pass a hostname, so the database comes
            from AUTH.
          </p>
          <Code label="Through Spectrum">
            {'valkey-cli --tls -h valkey.example.com -p 6379 --user mydb --pass "$VALKEY_PASSWORD"'}
          </Code>
          <p>
            <strong>Over a WebSocket:</strong> the shim turns <code>/ws</code> into a local TCP port for any client. Run
            it from a checkout after <code>npm install</code>. It needs Node 22 or newer, for the global WebSocket.
          </p>
          <Code label="Through the shim">
            {
              'node packages/client/ws-shim.mjs wss://<your-worker>.workers.dev/ws 6379\nvalkey-cli -p 6379 --user mydb --pass "$VALKEY_PASSWORD"'
            }
          </Code>
          <Note>
            <p>
              Without TLS on Spectrum, the password and data cross the internet in plain text. Use it only for test
              data. The shim's local port is plain text on 127.0.0.1 only.
            </p>
          </Note>
        </>
      ),
    },
    {
      id: "connect-worker",
      title: "3. Connect from a Worker",
      content: (
        <>
          <p>
            Bind this Worker as a service. <code>env.VALKEY.connect("mydb:6379")</code> returns a raw RESP socket, and
            the dialed host names the database. For ioredis, copy <code>packages/client/src/ioredis.ts</code> into your
            Worker and use its <code>bindingConnector</code>. It imports <code>ioredis</code>, so add that dependency,
            and <code>node:stream</code>, so the Worker needs the <code>nodejs_compat</code> flag.
          </p>
          <Code label="wrangler.jsonc">{'"services": [{ "binding": "VALKEY", "service": "vado" }]'}</Code>
          <Code label="worker.ts">
            {
              'import Redis from "ioredis";\nimport { bindingConnector } from "./ioredis";\n\nconst redis = new Redis({\n  Connector: bindingConnector(env.VALKEY, "mydb"),\n  password: env.VALKEY_PASSWORD,\n});\nawait redis.set("greeting", "hello");'
            }
          </Code>
          <p>
            The connection stays inside Cloudflare, and failed AUTHs aren't rate limited. With{" "}
            <code>VALKEY_PASSWORD</code> set, a binding still has to AUTH, and that password opens every database,
            including ones with their own password (<DocLink slug="security">security</DocLink>).
          </p>
        </>
      ),
    },
    {
      id: "local",
      title: "Run it locally",
      content: (
        <>
          <Code label="From a checkout">
            {
              "npm install\ncp .dev.vars.example .dev.vars                                 # then set VALKEY_PASSWORD in it\nnpm run dev                                                    # http://localhost:5173\nnode packages/client/ws-shim.mjs ws://localhost:5173/ws 6379   # in another terminal"
            }
          </Code>
          <p>
            The local dev server has no TCP port, so clients go through the shim. Placement and replicas need a real
            deployment.
          </p>
        </>
      ),
    },
  ],
  sources: [source("README.md"), source("packages/client/src/ioredis.ts"), source("packages/client/ws-shim.mjs")],
};
