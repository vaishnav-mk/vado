import { expect, test } from "vite-plus/test";
import { ago } from "../src/format";

test("ago reads like duration", () => {
  const now = 1e9;

  expect(ago(now - 4_000, now)).toBe("just now");
  expect(ago(now - 42_000, now)).toBe("42 s ago");
  expect(ago(now - 600_000, now)).toBe("10 min ago");
  expect(ago(now - 5_400_000, now)).toBe("1.5 h ago");
  expect(ago(now - 3 * 86_400_000, now)).toBe("3 d ago");
});
