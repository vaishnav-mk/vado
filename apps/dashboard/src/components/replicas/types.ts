import type { Replica } from "../../lib/types";

/** One region: its copy of every shard, in shard order. */
export interface Row {
  region: string;
  name: string;
  city: string | null;
  cells: (Replica | undefined)[];
  lag: number | null;
  reads: number;
  note: string | null;
}
