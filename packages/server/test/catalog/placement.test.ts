import { expect, test } from "vite-plus/test";
import { objectOptions, replicaRegion } from "../../src/catalog/placement";

test("a router reads the replica in its region, else a neighbour's", () => {
  expect(replicaRegion({ replicas: ["weur", "apac"] }, "AMS")).toBe("weur");
  expect(replicaRegion({ replicas: ["weur"] }, "WAW"), "eastern Europe falls back west").toBe("weur");
  expect(replicaRegion({ replicas: ["wnam", "enam"] }, "GRU"), "nearest neighbour first").toBe("enam");
  expect(replicaRegion({ replicas: ["apac"] }, "SFO")).toBe(null);
  expect(replicaRegion({ replicas: null }, "AMS")).toBe(null);
  expect(replicaRegion({ replicas: ["weur"] }, "???")).toBe(null);
});

test("objectOptions places only at known hints", () => {
  const env = { LOCATION_HINT: "weur" } as const;
  expect(objectOptions(env)).toEqual({ locationHint: "weur" });
  expect(objectOptions(env, "mars")).toEqual({});
  expect(objectOptions({})).toEqual({});
});
