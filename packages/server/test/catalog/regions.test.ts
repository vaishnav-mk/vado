import { expect, test } from "vite-plus/test";
import { HINT_NAMES, isHint, regionName, WORLD } from "../../src/catalog/regions";

test("a new database spreads over the named regions, in a fixed order", () => {
  expect(WORLD).toEqual(["wnam", "enam", "sam", "weur", "eeur", "me", "afr", "apac", "oc"]);
  expect(regionName("weur")).toBe("Western Europe");
  expect(regionName("apac-ne")).toBe("apac-ne");
});

test("every location hint is accepted, nothing else", () => {
  expect(HINT_NAMES.split(", ").every(isHint)).toBe(true);
  expect([isHint("apac-se"), isHint("mars"), isHint("")]).toEqual([true, false, false]);
});
