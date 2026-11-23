import type { Replica } from "../../lib/types";

export interface Row {
  region: string;
  name: string;
  city: string | null;
  cells: (Replica | undefined)[];
  lag: number | null;
  reads: number;
  note: string | null;
}
