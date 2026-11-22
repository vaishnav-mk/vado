import { createFileRoute } from "@tanstack/react-router";
import { Empty } from "@cloudflare/kumo";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Dashboard } from "../components/Dashboard";
import { Header } from "../components/Header";
import { getDatabase, listDatabases, listRegions } from "../server/admin";
import { useDark } from "../lib/hooks";
import { useLive } from "../lib/live";
import type { Database } from "../lib/types";

export const Route = createFileRoute("/db/$name")({
  loader: async ({ params }) => {
    const [db, databases, regions] = await Promise.all([getDatabase({ data: { name: params.name } }), listDatabases(), listRegions()]);
    return { db, databases, regions };
  },
  head: ({ params }) => ({ meta: [{ title: `${params.name} · vado` }] }),
  component: Page,
});

function Page() {
  const { db, databases, regions } = Route.useLoaderData();
  const { name } = Route.useParams();
  if (!db) {
    return (
      <>
        <Header name={null} databases={databases} regions={regions} state={null} connection="connecting" />
        <main className="mx-auto max-w-7xl px-6 py-16">
          <Empty icon={<MagnifyingGlassIcon size={32} />} title={`There's no database named ${name}`}
            description={databases.length ? "Pick one from the list above, or create a new one." : "Create one with New database."} />
        </main>
      </>
    );
  }
  return <LivePage db={db} databases={databases} regions={regions} />;
}

function LivePage({ db, databases, regions }: { db: Database; databases: Database[]; regions: Record<string, string> }) {
  const live = useLive(db.name), dark = useDark();
  return (
    <>
      <Header name={db.name} databases={databases} regions={regions} state={live.state} connection={live.connection} />
      <Dashboard name={db.name} live={live} regions={regions} dark={dark} />
    </>
  );
}
