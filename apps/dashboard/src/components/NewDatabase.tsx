import { useState, type FormEvent } from "react";
import { Button, Dialog, Input, Select } from "@cloudflare/kumo";
import { PlusIcon } from "@phosphor-icons/react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { Guard } from "./Guard";
import { createDatabase } from "../server/admin";
import { useAction } from "../lib/hooks";
import type { Options } from "../lib/types";

const SHARDS = { 1: "1 shard (64 MB)", 4: "4 shards (256 MB)", 16: "16 shards (1 GB)", 64: "64 shards (4 GB)" };

const SERVERS = new Map([
  ["valkey", "Valkey 9.1"],
  ["redis", "Redis 8.12"],
]);

// One field alone fills the row; two share it equally.
const ROW = "grid gap-5 sm:auto-cols-fr sm:grid-flow-col sm:gap-4";

export function NewDatabase({ options: { regions, flavours } }: { options: Options }) {
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [shards, setShards] = useState("4"),
    [flavour, setFlavour] = useState("valkey");

  const [place, setPlace] = useState(() => (regions.weur ? "weur" : (Object.keys(regions)[0] ?? "world"))),
    [copies, setCopies] = useState("yes");

  const { busy, error, run } = useAction();

  const navigate = useNavigate(),
    router = useRouter();

  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const db = await createDatabase({
        data: { name: name.trim(), shards: Number(shards), place, replicas: copies === "yes", flavour },
      });

      setOpen(false);
      setName("");
      await router.invalidate();
      await navigate({ to: "/db/$name", params: { name: db.name } });
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Guard action="create a database">
        {(disabled) => (
          <Dialog.Trigger
            disabled={disabled}
            render={(p) => (
              <Button {...p} variant="secondary" icon={PlusIcon} disabled={disabled}>
                New database
              </Button>
            )}
          />
        )}
      </Guard>
      <Dialog className="p-6" size="lg">
        <Dialog.Title className="text-lg font-semibold">New database</Dialog.Title>
        <Dialog.Description className="mt-1 text-sm text-kumo-subtle">
          The real server, compiled to WebAssembly.
        </Dialog.Description>
        <form onSubmit={create} className="mt-6 flex flex-col gap-5">
          <Input
            label="Name"
            placeholder="sessions"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            description="Lowercase letters, digits, - and _"
            error={error ?? undefined}
            variant={error ? "error" : "default"}
          />
          <div className={ROW}>
            {flavours.length > 1 && (
              <Select
                label="Runs"
                className="w-full"
                value={flavour}
                onValueChange={(v) => v && setFlavour(v)}
                items={Object.fromEntries(flavours.map((f) => [f, SERVERS.get(f)]))}
                description="Clients see one server"
              />
            )}
            <Select
              label="Shards"
              className="w-full"
              value={shards}
              onValueChange={(v) => v && setShards(v)}
              items={SHARDS}
              description="Keys spread evenly over them"
            />
          </div>
          <div className={ROW}>
            <Select
              label="Where the shards live"
              className="w-full"
              value={place}
              onValueChange={(v) => v && setPlace(v)}
              items={{ world: "Spread around the world", ...regions }}
              description="Shards never move"
            />
            <Select
              label="Read replicas"
              className="w-full"
              value={copies}
              onValueChange={(v) => v && setCopies(v)}
              items={{ yes: "In every region", no: "None" }}
              description="Reads go to the nearest copy"
            />
          </div>
          <div className="mt-1 flex justify-end gap-2">
            <Dialog.Close
              render={(p) => (
                <Button {...p} variant="secondary">
                  Cancel
                </Button>
              )}
            />
            <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
              Create
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
