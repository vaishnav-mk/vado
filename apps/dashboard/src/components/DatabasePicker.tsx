import { Combobox } from "@cloudflare/kumo";
import { useNavigate } from "@tanstack/react-router";
import { FLAVOUR_NAMES, FLAVOURS } from "@vado/server/catalog/flavours.ts";
import { plural } from "../lib/format";
import type { Database } from "../lib/types";

interface Group {
  value: string;
  items: string[];
}

const details = (d: Database) =>
  [
    plural(d.shards, "shard"),
    (d.regions?.length ?? 0) > 1 ? "around the world" : "",
    d.replicas?.length ? "read replicas" : "",
  ]
    .filter((s) => s)
    .join(", ");

export function DatabasePicker({ name, databases }: { name: string | null; databases: Database[] }) {
  const navigate = useNavigate();
  const byName = new Map(databases.map((d) => [d.name, d]));

  const groups: Group[] = FLAVOURS.map((f) => ({
    value: FLAVOUR_NAMES[f],
    items: databases
      .filter((d) => d.flavour === f)
      .map((d) => d.name)
      .toSorted(),
  })).filter((g) => g.items.length > 0);

  return (
    <Combobox
      items={groups}
      value={name}
      onValueChange={(v) => v && navigate({ to: "/db/$name", params: { name: v } })}
    >
      <Combobox.TriggerValue aria-label="Database" className="w-56 max-w-full">
        {(v: string | null) => (v ? <span className="truncate font-medium">{v}</span> : "Pick a database")}
      </Combobox.TriggerValue>
      <Combobox.Content className="w-80">
        <Combobox.Input aria-label="Search databases" placeholder="Search by name" />
        <Combobox.Empty>No database has that name</Combobox.Empty>
        <Combobox.List>
          {(group: Group) => (
            <Combobox.Group key={group.value} items={group.items}>
              <Combobox.GroupLabel className="sticky top-0 z-10 bg-kumo-base">{group.value}</Combobox.GroupLabel>
              <Combobox.Collection>
                {(n: string) => {
                  const d = byName.get(n);

                  return (
                    <Combobox.Item key={n} value={n} className="grid-cols-[minmax(0,1fr)_16px]">
                      <span className="block truncate">{n}</span>
                      {d && <span className="block truncate text-xs text-kumo-subtle">{details(d)}</span>}
                    </Combobox.Item>
                  );
                }}
              </Combobox.Collection>
            </Combobox.Group>
          )}
        </Combobox.List>
      </Combobox.Content>
    </Combobox>
  );
}
