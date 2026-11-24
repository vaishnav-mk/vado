import { Code, Facts, Note } from "../components/blocks";
import { ServerBadge } from "../components/server";
import { SERVERS } from "./servers";
import type { DocSection } from "./types";

const flag = (text: string) => <code className="whitespace-nowrap">{text}</code>;

export const SETUP_SECTIONS: DocSection[] = [
  {
    id: "building",
    title: "Building",
    content: (
      <>
        <Code label="Terminal">
          {
            "npm run deploy                                  # valkey\nVADO_REDIS=1 npm run deploy                     # and redis\nVADO_CONTAINERS=1 npm run deploy                # and valkey-native (needs Docker)\nVADO_REDIS=1 VADO_CONTAINERS=1 npm run deploy   # all four"
          }
        </Code>
        <ul>
          <li>
            Redis is opt-in. It doubles the upload, from <strong>0.86 MB to 1.77 MB</strong> gzipped, and is distributed
            under the AGPLv3 (<a href="#licence">licences</a>).
          </li>
          <li>
            On their own, <code>valkey.wasm</code> is {SERVERS.valkey.wasm} and <code>redis.wasm</code> is{" "}
            {SERVERS.redis.wasm}.
          </li>
        </ul>
        <h3>Container settings</h3>
        <Facts
          items={[
            [
              flag("VADO_CONTAINERS=1"),
              <>
                Adds a container application with an image of each server the build carries. Docker builds them from{" "}
                <code>packages/box/Dockerfile</code> during the deploy.
              </>,
            ],
            [
              <>
                {flag("VADO_VALKEY_IMAGE")} {flag("VADO_REDIS_IMAGE")}
              </>,
              <>
                Skip that Docker build. Set them to digest-pinned images you pushed to the Cloudflare registry with{" "}
                <code>wrangler containers push</code>.
              </>,
            ],
            [flag("VADO_CONTAINER_APP"), "Names the application, for two vado Workers on one account."],
            [
              flag("BOX_MAXMEMORY"),
              <>
                The containers' <code>maxmemory</code>. Default <code>2gb</code>, on a <code>standard-1</code> instance
                with 4 GiB.
              </>,
            ],
          ]}
        />
      </>
    ),
  },
  {
    id: "creating",
    title: "Creating a database",
    content: (
      <>
        <Code label="Terminal">
          {
            'curl -H "authorization: Bearer $BENCH_TOKEN" \\\n  "https://<worker>/db?db=big&shards=16&flavour=valkey-native"'
          }
        </Code>
        <ul>
          <li>
            Pick the flavour at creation, in the dashboard or with <code>flavour=</code> on the bench API.
          </li>
          <li>
            It <strong>never changes</strong>.
          </li>
          <li>A database made by its first AUTH runs Valkey in its objects.</li>
          <li>Every object's name carries the flavour, so each one boots the right server from its name alone.</li>
        </ul>
      </>
    ),
  },
  {
    id: "redis-wasm",
    title: "Redis in wasm",
    content: (
      <ul>
        <li>
          Redis lacks Valkey's <code>import-mode</code>. Replicas and rewriters need it so nothing expires on its own. A
          patch adds it.
        </li>
        <li>
          Redis has no <code>CLIENT IMPORT-SOURCE</code>. With that patch, every write on a replica counts as the
          primary's stream.
        </li>
        <li>
          <code>INFO</code> shows <code>executable:/valkey-server</code>, the name the shared host code passes.
        </li>
      </ul>
    ),
  },
  {
    id: "licence",
    title: "Licences",
    content: (
      <>
        <Facts
          items={[
            [<ServerBadge server="valkey" />, "BSD 3-Clause"],
            [<ServerBadge server="redis" />, "Redis 8 is available under RSALv2, SSPLv1 or AGPLv3"],
            [
              "Redis in vado",
              <>
                <code>redis.wasm</code>, its patches and stubs, and the Redis container image are distributed under the
                AGPLv3
              </>,
            ],
            ["The rest of vado", "Apache-2.0"],
          ]}
        />
        <Note title="If you run a Redis flavour for other people">
          <p>The AGPL's network clause means you must offer them its source:</p>
          <ul>
            <li>
              the Redis tarball pinned in <code>packages/wasm/redis/build.sh</code> and{" "}
              <code>packages/box/Dockerfile</code>
            </li>
            <li>
              <code>packages/wasm/redis/</code>
            </li>
            <li>
              <code>packages/wasm/wasi/</code>
            </li>
          </ul>
        </Note>
      </>
    ),
  },
];
