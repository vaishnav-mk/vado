import { Code, Note, Table } from "../components/blocks";
import { DocLink } from "../components/doc-link";
import { ByServer } from "../components/server";
import { SERVERS } from "./servers";
import type { DocSection } from "./types";

const rebuild = (name: string) => `WASI_SDK=/path/to/wasi-sdk-34.0 packages/wasm/${name}/build.sh
cp packages/wasm/${name}/build/${name}.wasm packages/wasm/${name}/${name}.wasm
node packages/wasm/interface.mjs packages/wasm/${name}/${name}.wasm > packages/wasm/${name}/interface.txt`;

const patchTree = (name: string, version: string, next: string) => `# in a scratch directory
tar -xzf <repo>/packages/wasm/.cache/${name}-${version}.tar.gz --strip-components=1
git init -q && git add -A && git commit -qm upstream
patch -p1 -F0 -i <repo>/packages/wasm/${name}/patches/0001-ae-wasi-backend.patch   # each patch before yours
git add -A && git commit -qm "earlier patches"
# edit, then
git add -A && git diff --cached > <repo>/packages/wasm/${name}/patches/${next}-my-change.patch`;

export const CHANGE_SECTIONS: DocSection[] = [
  {
    id: "upgrade",
    title: "Moving to a new upstream version",
    content: (
      <>
        <ByServer
          valkey={
            <>
              <Code label="Terminal">{`packages/wasm/valkey/update.sh 9.2.0\n${rebuild("valkey")}`}</Code>
              <p>
                <code>update.sh</code> downloads the release tarball into <code>packages/wasm/.cache/</code>, rewrites{" "}
                <code>VALKEY_VERSION</code> and <code>VALKEY_SHA256</code> in <code>build.sh</code> with the sha256 of
                what it downloaded, and tries every patch against a scratch tree, applying the ones that fit in order so
                a single run lists every failure. It exits 1 if any patch fails and leaves <code>build.sh</code> updated
                either way. It doesn't build.
              </p>
            </>
          }
          redis={
            <>
              <p>
                Redis has no <code>update.sh</code>. Set <code>REDIS_VERSION</code> and <code>REDIS_SHA256</code> in{" "}
                <code>packages/wasm/redis/build.sh</code> by hand, run it, and fix the first patch that fails: the build
                stops there.
              </p>
              <Code label="Terminal">{rebuild("redis")}</Code>
            </>
          }
        />
        <p>
          The new checksum is only as good as the download, so compare it with the release before committing. A weekly
          workflow, <code>valkey-release.yml</code>, does this for Valkey when a newer release is out and opens an issue
          with the patch, build, size and interface results; it never commits.
        </p>
      </>
    ),
  },
  {
    id: "patching",
    title: "Adding or fixing a patch",
    content: (
      <>
        <p>
          Patches are plain unified diffs against the release tree, applied with <code>-p1</code> and zero fuzz. Number
          a new one after the last, and put sandbox-only code under <code>#ifdef VALKEY_WASM</code>. A git repository
          over the extracted tarball makes the diff easy:
        </p>
        <ByServer
          valkey={<Code label="One way to write a patch">{patchTree("valkey", SERVERS.valkey.version, "0006")}</Code>}
          redis={<Code label="One way to write a patch">{patchTree("redis", SERVERS.redis.version, "0007")}</Code>}
        />
        <p>
          A patch that stopped applying after an upgrade is fixed the same way: apply the ones before it, redo its
          change by hand, and write the diff over the old file.
        </p>
        <p>
          Shared C goes in <code>packages/wasm/wasi/</code> instead, and a missing libc function in the server's{" "}
          <code>stubs.c</code>. Then rebuild, copy the module over the committed one, and regenerate{" "}
          <code>interface.txt</code>, as above. A change for one server belongs in its patches, not in a branch in the
          TypeScript.
        </p>
      </>
    ),
  },
  {
    id: "host-imports",
    title: "Adding a host import or export",
    content: (
      <ol>
        <li>
          Declare the import in <code>wasi/host.h</code> with <code>HOST_IMPORT("name")</code>, or the export with{" "}
          <code>__attribute__((export_name(...)))</code> in a patch or shim.
        </li>
        <li>
          Provide the import in the <code>host</code> object in <code>valkey-host.ts</code> (socket imports live in{" "}
          <code>sockets.ts</code>, WASI ones in <code>wasi.ts</code> or <code>shard/vfs</code>), and add any new export
          to <code>ValkeyExports</code> in <code>host/types.ts</code>.
        </li>
        <li>
          Rebuild and regenerate <code>interface.txt</code> for both servers. The host passes the same imports to both
          builds, and <code>host.test.ts</code> compares them with the union of both lists.
        </li>
      </ol>
    ),
  },
  {
    id: "checks",
    title: "What to check afterwards",
    content: (
      <>
        <Table
          headers={["Check", "What it catches"]}
          rows={[
            [<code>interface.mjs --check</code>, "Imports or exports that changed: the host may need updating"],
            [
              <code>npm test</code>,
              "host.test.ts fails unless the host provides exactly the imports both interface.txt files list. valkey-host.test.ts boots valkey.wasm on fake storage, writes and reloads its AOF, and serves a socket",
            ],
            [<code>npm run check</code>, "Format, lint and types, if host code changed"],
            [
              <code>test/e2e.sh</code>,
              "Against a deployment: clients, the hammer, resets with acknowledged writes reloaded from the AOF, and replicas. FLAVOUR=redis runs it on Redis, in a build made with VADO_REDIS=1",
            ],
            [
              "wasm.yml in CI",
              "Rebuilds both modules and fails unless the bytes and the interface match what's committed",
            ],
          ]}
        />
        <Note>
          <p>
            The unit tests load only <code>valkey.wasm</code>; <code>redis.wasm</code> is exercised end to end. See{" "}
            <DocLink slug="repository" hash="e2e">
              End-to-end tests
            </DocLink>{" "}
            for running <code>test/e2e.sh</code> against your own Worker.
          </p>
        </Note>
      </>
    ),
  },
  {
    id: "licence",
    title: "Licences",
    content: (
      <ByServer
        valkey={
          <p>
            The Valkey build, its patches and the shared shims are BSD 3-Clause (<code>packages/wasm/LICENSE</code>),
            like Valkey itself.
          </p>
        }
        redis={
          <p>
            <code>redis.wasm</code>, its patches and stubs are distributed under the AGPLv3 (
            <DocLink slug="redis" hash="licence">
              Redis
            </DocLink>
            ). Anyone running the Redis flavour for others must offer them the pinned tarball,{" "}
            <code>packages/wasm/redis/</code> and <code>packages/wasm/wasi/</code>.
          </p>
        }
      />
    ),
  },
];
