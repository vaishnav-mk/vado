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
            deploys. The Worker's URL is the dashboard.
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
                  {SERVERS.redis.licence} (<DocLink slug="redis">what that asks of you</DocLink>).
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
            valkey={<p>The AUTH username picks the database; a new one is created on first use, running Valkey.</p>}
            redis={
              <>
                <p>
                  The AUTH username picks the database. One created on first use runs Valkey, so create a Redis database
                  first: in the dashboard's New database dialog, or with <code>flavour=redis</code> on the{" "}
                  <DocLink slug="operations" hash="bench">
                    bench API
                  </DocLink>
                  . The flavour never changes after that.
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
            <strong>Over TCP:</strong> add a Spectrum application of type Workers (tcp) with this Worker as origin, on
            port 6379, with TLS on (<code>flexible</code>). Spectrum doesn't pass a hostname, so the database comes from
            AUTH.
          </p>
          <Code label="Through Spectrum">
            {'valkey-cli --tls -h valkey.example.com -p 6379 --user mydb --pass "$VALKEY_PASSWORD"'}
          </Code>
          <p>
            <strong>Over a WebSocket:</strong> the shim turns <code>/ws</code> into a local TCP port for any client.
          </p>
          <Code label="Through vado-shim">
            {
              'npx vado-shim wss://<your-worker>.workers.dev/ws 6379\nvalkey-cli -p 6379 --user mydb --pass "$VALKEY_PASSWORD"'
            }
          </Code>
          <Note>
            <p>
              Without TLS on Spectrum, the password and data cross the internet in plain text. The shim's local port is
              plain text on 127.0.0.1 only.
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
            the dialed host names the database. For ioredis, use <code>bindingConnector</code> from{" "}
            <code>@vado/client</code>:
          </p>
          <Code label="wrangler.jsonc">{'"services": [{ "binding": "VALKEY", "service": "vado" }]'}</Code>
          <Code label="worker.ts">
            {
              'import Redis from "ioredis";\nimport { bindingConnector } from "@vado/client";\n\nconst redis = new Redis({\n  Connector: bindingConnector(env.VALKEY, "mydb"),\n  password: env.VALKEY_PASSWORD,\n});\nawait redis.set("greeting", "hello");'
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
              "cp .dev.vars.example .dev.vars\nnpm run dev                                     # http://localhost:5173\nnpx vado-shim ws://localhost:5173/ws 6379       # in another terminal"
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
