import { createFileRoute } from "@tanstack/react-router";
import { Empty } from "@cloudflare/kumo";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Dashboard } from "../components/Dashboard";
import { Header } from "../components/Header";
import { getDatabase, listDatabases, listOptions } from "../server/admin";
import { useDark } from "../lib/hooks";
import { useLive } from "../lib/live";
import { useSignedIn } from "../components/Guard";
import type { Database, Options } from "../lib/types";

export const Route = createFileRoute("/db/$name")({
  loader: async ({ params }) => {
    const [db, databases, options] = await Promise.all([
      getDatabase({ data: { name: params.name } }).catch(() => null),
      listDatabases(),
      listOptions(),
    ]);

    return { db, databases, options };
  },
  head: ({ params }) => ({ meta: [{ title: `${params.name} · vado` }] }),
  component: Page,
});

function Page() {
  const { db, databases, options } = Route.useLoaderData();
  const { name } = Route.useParams();

  if (!db) {
    return (
      <>
        <Header name={null} databases={databases} options={options} state={null} connection="connecting" />
        <main className="mx-auto max-w-7xl px-6 py-16">
          <Empty
            icon={<MagnifyingGlassIcon size={32} />}
            title={`There's no database named ${name}`}
            description={
              databases.length ? "Pick one from the list above, or create a new one." : "Create one with New database."
            }
          />
        </main>
      </>
    );
  }

  return <LivePage db={db} databases={databases} options={options} />;
}

function LivePage({ db, databases, options }: { db: Database; databases: Database[]; options: Options }) {
  const live = useLive(db.name, !!useSignedIn()),
    dark = useDark();

  return (
    <>
      <Header name={db.name} databases={databases} options={options} state={live.state} connection={live.connection} />
      <Dashboard key={db.name} name={db.name} live={live} regions={options.regions} dark={dark} />
    </>
  );
}
