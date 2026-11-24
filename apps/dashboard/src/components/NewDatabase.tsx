import { useState, type FormEvent } from "react";
import { Button, Dialog, Input, Select, Text } from "@cloudflare/kumo";
import { PlusIcon } from "@phosphor-icons/react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { isNative } from "@vado/server/catalog/flavours.ts";
import { DB_NAME_RULE } from "@vado/server/catalog/names.ts";
import type { Flavour } from "@vado/server/catalog/types.ts";
import { Guard } from "./Guard";
import { createDatabase } from "../server/admin";
import { useAction } from "../lib/hooks";
import type { Options } from "../lib/types";

const SHARDS = { 1: "1 shard", 4: "4 shards", 16: "16 shards", 64: "64 shards" };

const RUNS: Record<Flavour, string> = {
  valkey: "Valkey 9.1 in WebAssembly",
  "valkey-native": "Valkey 9.1 in a container",
  redis: "Redis 8.12 in WebAssembly",
  "redis-native": "Redis 8.12 in a container",
};

// One field alone fills the row; two share it equally.
const ROW = "grid gap-5 sm:auto-cols-fr sm:grid-flow-col sm:gap-4";

export function NewDatabase({ options: { regions, flavours } }: { options: Options }) {
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [shards, setShards] = useState("4"),
    [flavour, setFlavour] = useState<Flavour>("valkey");

  const [place, setPlace] = useState(() => (regions.weur ? "weur" : (Object.keys(regions)[0] ?? "world"))),
    [copies, setCopies] = useState("yes");

  const { busy, error, setError, run } = useAction();

  const native = isNative(flavour);

  const n = name.trim(),
    nameError =
      error && [DB_NAME_RULE, `${n} already exists`, `database ${n} was dropped`].includes(error) ? error : undefined;

  const navigate = useNavigate(),
    router = useRouter();

  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const db = await createDatabase({
        data: { name: n, shards: Number(shards), place, replicas: !native && copies === "yes", flavour },
      });

      setOpen(false);
      setName("");
      await router.invalidate();
      await navigate({ to: "/db/$name", params: { name: db.name } });
    });
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);

        if (o) setError(null);
      }}
    >
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
          The real server: compiled to WebAssembly inside each shard's Durable Object, or native in a container beside
          it.
        </Dialog.Description>
        <form onSubmit={create} className="mt-6 flex flex-col gap-5">
          <Input
            label="Name"
            placeholder="sessions"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            autoComplete="off"
            spellCheck={false}
            description="Lowercase letters, digits, - and _"
            error={nameError}
            variant={nameError ? "error" : "default"}
          />
          <div className={ROW}>
            {flavours.length > 1 && (
              <Select
                label="Runs"
                className="w-full"
                value={flavour}
                onValueChange={(v) => {
                  const picked = flavours.find((f) => f === v);

                  if (picked) setFlavour(picked);
                }}
                items={Object.fromEntries(flavours.map((f) => [f, RUNS[f]]))}
                description={native ? "2 GB a shard; wakes in seconds" : "64 MB a shard; idles for free"}
              />
            )}
            <Select
              label="Shards"
              className="w-full"
              value={shards}
              onValueChange={(v) => v && setShards(v)}
              items={SHARDS}
              description="Slots spread evenly over them"
            />
          </div>
          <div className={ROW}>
            <Select
              label="Where the shards live"
              className="w-full"
              value={place}
              onValueChange={(v) => v && setPlace(v)}
              items={{ world: "Spread around the world", ...regions }}
              description="Placement is fixed at creation"
            />
            <Select
              label="Read replicas"
              className="w-full"
              value={native ? "no" : copies}
              onValueChange={(v) => v && setCopies(v)}
              items={{ yes: "In every region", no: "None" }}
              disabled={native}
              description={native ? "Not for containers yet" : "Reads go to the nearest copy"}
            />
          </div>
          {error && !nameError && (
            <Text variant="error" size="sm">
              {error}
            </Text>
          )}
          <div className="mt-1 flex justify-end gap-2">
            <Dialog.Close
              render={(p) => (
                <Button {...p} variant="secondary">
                  Cancel
                </Button>
              )}
            />
            <Button type="submit" variant="primary" loading={busy} disabled={!n}>
              Create
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
