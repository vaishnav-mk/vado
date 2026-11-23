import { useState } from "react";
import { Button, LayerCard, Select, Text } from "@cloudflare/kumo";
import { PlayIcon, StopIcon } from "@phosphor-icons/react";
import { Guard } from "./Guard";
import { startTest, stopTest } from "../server/admin";
import { duration } from "../lib/format";
import type { TestView } from "../lib/types";

const LEVELS = { light: "Light", medium: "Medium", heavy: "Heavy" };

export function TestTraffic({
  db,
  test,
  now,
  regions,
}: {
  db: string;
  test: TestView | null | undefined;
  now: number;
  regions: Record<string, string>;
}) {
  const [level, setLevel] = useState<keyof typeof LEVELS>("medium"),
    [from, setFrom] = useState("everywhere");

  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);

  const act = async (f: () => Promise<TestView | null>) => {
    setBusy(true);
    setError(null);

    try {
      await f();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }

    setBusy(false);
  };

  const left = test ? Math.max(0, (test.until - now) / 1000) : 0;

  return (
    <LayerCard>
      <LayerCard.Secondary>Test traffic</LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-3">
        <Text variant="secondary" size="sm">
          Writes keys from Cloudflare locations, then reads them back three times, so you can watch the database under
          load. It stops by itself after 10 minutes.
        </Text>
        <div className="grid grid-cols-2 gap-2">
          <Select
            label="From"
            value={from}
            onValueChange={(v) => v && setFrom(v)}
            disabled={!!test}
            items={{ everywhere: "Everywhere", ...regions }}
          />
          <Select
            label="Amount"
            value={level}
            onValueChange={(v) => v && setLevel(v)}
            disabled={!!test}
            items={LEVELS}
          />
        </div>
        <Guard action={test ? "stop test traffic" : "start test traffic"} className="flex">
          {(disabled) =>
            test ? (
              <Button
                variant="secondary"
                icon={StopIcon}
                loading={busy}
                disabled={disabled}
                onClick={() => act(() => stopTest({ data: { name: db } }))}
                className="w-full"
              >
                Stop test traffic
              </Button>
            ) : (
              <Button
                variant="primary"
                icon={PlayIcon}
                loading={busy}
                disabled={disabled}
                onClick={() => act(() => startTest({ data: { name: db, level, from } }))}
                className="w-full"
              >
                Start test traffic
              </Button>
            )
          }
        </Guard>
        {test && (
          <Text variant="secondary" size="sm">
            {LEVELS[test.level] ?? test.level} traffic from{" "}
            {test.from === "everywhere" ? "everywhere" : (regions[test.from] ?? test.from)}, running for{" "}
            {duration((now - test.since) / 1000)}. Stops in {duration(left)}.
          </Text>
        )}
        {error && (
          <Text variant="error" size="sm">
            {error}
          </Text>
        )}
      </LayerCard.Primary>
    </LayerCard>
  );
}
