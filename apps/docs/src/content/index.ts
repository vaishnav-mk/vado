import { architecture } from "./architecture";
import { durability } from "./durability";
import { introduction } from "./introduction";
import { lifecycle } from "./lifecycle";
import { measurements } from "./measurements";
import { operations } from "./operations";
import { quickStart } from "./quick-start";
import { redis } from "./redis";
import { replicas } from "./replicas";
import { repository } from "./repository";
import { security } from "./security";
import { sharding } from "./sharding";
import { wasm } from "./wasm";
import type { Doc } from "./types";

export const docs: Doc[] = [
  introduction,
  quickStart,
  architecture,
  sharding,
  durability,
  replicas,
  lifecycle,
  wasm,
  operations,
  security,
  measurements,
  redis,
  repository,
];

/** Sidebar groups in page order. */
export const groups = [...Map.groupBy(docs, (doc) => doc.group)];
