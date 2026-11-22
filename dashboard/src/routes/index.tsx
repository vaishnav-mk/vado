import { createFileRoute, redirect } from "@tanstack/react-router";
import { Empty } from "@cloudflare/kumo";
import { DatabaseIcon } from "@phosphor-icons/react";
import { Header } from "../components/Header";
import { listDatabases, listRegions } from "../server/admin";

export const Route = createFileRoute("/")({
  loader: async () => {
    const [databases, regions] = await Promise.all([listDatabases(), listRegions()]);
    const first = databases.find((d) => d.name === "global") ?? databases[0];
    if (first) throw redirect({ to: "/db/$name", params: { name: first.name } });
    return { regions };
  },
  component: NoDatabases,
});

function NoDatabases() {
  const { regions } = Route.useLoaderData();
  return (
    <>
      <Header name={null} databases={[]} regions={regions} state={null} connection="connecting" />
      <main className="mx-auto max-w-7xl px-6 py-16">
        <Empty icon={<DatabaseIcon size={32} />} title="No databases yet" description="Create one with New database. Its numbers show up here as soon as it has any." />
      </main>
    </>
  );
}
