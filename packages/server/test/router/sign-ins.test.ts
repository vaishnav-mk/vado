import { expect, test } from "vite-plus/test";
import { ipOf } from "../../src/router/sign-ins";

test("sign-ins count the client's IP, not its port", () => {
  expect(ipOf("1.2.3.4:5678")).toBe("1.2.3.4");
  expect(ipOf("[::1]:5678")).toBe("::1");
  expect(ipOf("2001:db8::1")).toBe("2001:db8::1");
  expect(ipOf(null)).toBe(null);
});
