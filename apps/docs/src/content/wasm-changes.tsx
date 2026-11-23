import { Checklist, Code, Note, Steps } from "../components/blocks";
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

const upgrade = (name: string, version: string) => (
  <>
    <Steps
      items={[
        <>
          Run{" "}
          <code>
            packages/wasm/update.sh {name} {version}
          </code>
          . It downloads the release tarball into <code>packages/wasm/.cache/</code> and rewrites the version and sha256
          in <code>{name}/build.sh</code> with the sha256 of what it downloaded.
        </>,
        <>
          Read its patch report. It tries every patch against a scratch tree, applying the ones that fit in order, so
          one run lists every failure. It exits 1 if any patch fails, and leaves <code>build.sh</code> updated either
          way.
        </>,
        <>
          Fix each failing patch (<a href="#patching">below</a>).
        </>,
        <>Compare the new sha256 with the release: it is only as good as the download.</>,
        <>
          Rebuild, copy the module over the committed one and regenerate <code>interface.txt</code>.{" "}
          <code>update.sh</code> doesn't build.
        </>,
      ]}
    />
    <Code label="Step 5">{rebuild(name)}</Code>
  </>
);

export const CHANGE_SECTIONS: DocSection[] = [
  {
    id: "upgrade",
    title: "Moving to a new upstream version",
    content: (
      <ByServer
        valkey={
          <>
            {upgrade("valkey", "9.2.0")}
            <p>
              A weekly workflow, <code>valkey-release.yml</code>, tries a newer Valkey release when one is out (
              <code>update.sh</code>, build, interface check) and opens an issue with the patch, build, size and
              interface results. It never commits.
            </p>
          </>
        }
        redis={upgrade("redis", "8.14.0")}
      />
    ),
  },
  {
    id: "patching",
    title: "Adding or fixing a patch",
    content: (
      <>
        <Steps
          items={[
            <>Extract the release tarball into a scratch directory and make it a git repository.</>,
            <>
              Apply each patch before yours with <code>patch -p1 -F0</code>, and commit.
            </>,
            <>
              Make the change. Put sandbox-only code under <code>#ifdef VALKEY_WASM</code>.
            </>,
            <>
              Write the diff to <code>patches/</code>, numbered after the last one. To fix a patch, write it over the
              old file.
            </>,
            <>
              Rebuild, copy the module over the committed one, and regenerate <code>interface.txt</code>, as above.
            </>,
          ]}
        />
        <ByServer
          valkey={<Code label="Steps 1 to 4">{patchTree("valkey", SERVERS.valkey.version, "0006")}</Code>}
          redis={<Code label="Steps 1 to 4">{patchTree("redis", SERVERS.redis.version, "0007")}</Code>}
        />
        <ul>
          <li>
            Shared C goes in <code>packages/wasm/wasi/</code> instead of a patch.
          </li>
          <li>
            A missing libc function goes in the server's <code>stubs.c</code>.
          </li>
          <li>A change for one server belongs in its patches, not in a branch in the TypeScript.</li>
        </ul>
      </>
    ),
  },
  {
    id: "host-imports",
    title: "Adding a host import or export",
    content: (
      <Steps
        items={[
          <>
            Declare the import in <code>wasi/host.h</code> with <code>HOST_IMPORT("name")</code>, or the export with{" "}
            <code>__attribute__((export_name(...)))</code> in a patch or shim.
          </>,
          <>
            Provide the import in the <code>host</code> object in <code>valkey-host.ts</code>. Socket imports live in{" "}
            <code>sockets.ts</code>, WASI ones in <code>wasi.ts</code> or <code>shard/vfs</code>.
          </>,
          <>
            Add any new export to <code>ValkeyExports</code> in <code>host/types.ts</code>.
          </>,
          <>
            Rebuild and regenerate <code>interface.txt</code> for both servers. The host passes the same imports to both
            builds, and <code>host.test.ts</code> compares them with the union of both lists.
          </>,
        ]}
      />
    ),
  },
  {
    id: "checks",
    title: "What to check afterwards",
    content: (
      <>
        <Checklist
          items={[
            <>
              <code>{"interface.mjs <file.wasm> --check <interface.txt>"}</code> exits 1 with a diff when imports or
              exports changed: the host may need updating.
            </>,
            <>
              <code>npm test</code>: <code>host.test.ts</code> fails unless the host provides exactly the imports both{" "}
              <code>interface.txt</code> files list. <code>valkey-host.test.ts</code> boots <code>valkey.wasm</code> on
              fake storage, writes and reloads its AOF, and serves a socket.
            </>,
            <>
              <code>npm run check</code>: format, lint and types, if host code changed.
            </>,
            <>
              <code>test/e2e.sh</code> against a deployment: clients, the hammer, resets with acknowledged writes
              reloaded from the AOF, and replicas. <code>FLAVOUR=redis</code> runs it on Redis, in a build made with{" "}
              <code>VADO_REDIS=1</code>.
            </>,
            <>
              <code>wasm.yml</code> in CI rebuilds both modules and fails unless the bytes and the interface match
              what's committed.
            </>,
          ]}
        />
        <Note>
          <p>
            The unit tests load only <code>valkey.wasm</code>. <code>redis.wasm</code> is exercised end to end. See{" "}
            <DocLink slug="repository" hash="e2e">
              End-to-end tests
            </DocLink>{" "}
            for running <code>test/e2e.sh</code> against your own Worker.
          </p>
        </Note>
      </>
    ),
  },
];
