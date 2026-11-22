import { useState, type FormEvent } from "react";
import { Button, Dialog, Input, Select } from "@cloudflare/kumo";
import { PlusIcon } from "@phosphor-icons/react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { Guard } from "./Guard";
import { createDatabase } from "../server/admin";
import type { Options } from "../lib/types";

const SHARDS = { 1: "1 shard (64 MB)", 4: "4 shards (256 MB)", 16: "16 shards (1 GB)", 64: "64 shards (4 GB)" };
const SERVERS = new Map([["valkey", "Valkey 9.1"], ["redis", "Redis 8.12"]]);

export function NewDatabase({ options: { regions, flavours } }: { options: Options }) {
  const [open, setOpen] = useState(false), [name, setName] = useState(""), [shards, setShards] = useState("4"), [flavour, setFlavour] = useState("valkey");
  const [place, setPlace] = useState(() => (regions.weur ? "weur" : Object.keys(regions)[0] ?? "world")), [copies, setCopies] = useState("yes");
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const navigate = useNavigate(), router = useRouter();
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const db = await createDatabase({ data: { name: name.trim(), shards: Number(shards), place, replicas: copies === "yes", flavour } });
      setOpen(false); setName("");
      await router.invalidate();
      await navigate({ to: "/db/$name", params: { name: db.name } });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    setBusy(false);
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Guard action="create a database">
        {(disabled) => <Dialog.Trigger disabled={disabled} render={(p) => <Button {...p} variant="secondary" icon={PlusIcon} disabled={disabled}>New database</Button>} />}
      </Guard>
      <Dialog className="p-6" size="sm">
        <Dialog.Title className="text-lg font-semibold">New database</Dialog.Title>
        <Dialog.Description className="mb-4 text-sm text-kumo-subtle">Its shards stay where they're created. Keys are spread evenly over them.</Dialog.Description>
        <form onSubmit={create} className="flex flex-col gap-4">
          <Input label="Name" placeholder="sessions" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false}
            description="Lowercase letters, digits, - and _" error={error ?? undefined} variant={error ? "error" : "default"} />
          {flavours.length > 1 && (
            <Select label="Runs" value={flavour} onValueChange={(v) => v && setFlavour(v)} items={Object.fromEntries(flavours.map((f) => [f, SERVERS.get(f)]))}
              description="Each shard runs the real server, compiled to WebAssembly. Clients can't tell it from one server." />
          )}
          <Select label="Shards" value={shards} onValueChange={(v) => v && setShards(v)} items={SHARDS} />
          <Select label="Where the shards live" value={place} onValueChange={(v) => v && setPlace(v)} items={{ world: "Spread around the world", ...regions }} />
          <Select label="Read replicas" value={copies} onValueChange={(v) => v && setCopies(v)} items={{ yes: "In every region", no: "None" }}
            description="A copy of every shard in each region. Reads go to the nearest copy; writes go to the shard." />
          <div className="flex justify-end gap-2">
            <Dialog.Close render={(p) => <Button {...p} variant="secondary">Cancel</Button>} />
            <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>Create</Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
