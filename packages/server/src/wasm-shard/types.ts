import type { Flavour } from "../catalog/types";
import type { WasmHost } from "./host/wasm-host";
import type { PrimaryRole } from "./primary";
import type { ReplicaRole } from "./replica";
import type { ValkeyRewriter } from "./rewriter/rewriter";
import type { Upgrader } from "./upgrade";

export interface LiveShard {
  host: WasmHost;
  flavour: Flavour;
  upgrader: Upgrader;
  primary: PrimaryRole | null;
  replica: ReplicaRole | null;
}

export type RewriterStub = () => DurableObjectStub<ValkeyRewriter>;

export interface PrimaryUpgrades {
  rewriter: RewriterStub;
  retryAt: (at: number) => Promise<void>;
}

export interface VfsProbe {
  autoVacuum: { auto_vacuum: number }[] | string;
  writeAMs?: number;
  writeBMs?: number;
  deleteMiddleMs?: number;
  deleteEndMs?: number;
}

export interface AofEntry {
  path: string;
  type: string;
  line: string;
}

export interface AofFiles {
  base: string | undefined;
  incrs: string[];
  entries: AofEntry[];
}
