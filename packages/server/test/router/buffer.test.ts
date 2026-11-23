import { expect, test } from "vite-plus/test";
import { append, sameBytes } from "../../src/router/buffer";

const enc = new TextEncoder();

test("append keeps views it handed out unchanged", () => {
  const a = append(enc.encode("ab"), enc.encode("cd")),
    view = a.subarray(0, 4);

  const b = append(a, enc.encode("ef"));
  const c = append(b.subarray(2), enc.encode("gh"));

  expect(new TextDecoder().decode(view)).toBe("abcd");
  expect(new TextDecoder().decode(b)).toBe("abcdef");
  expect(new TextDecoder().decode(c)).toBe("cdefgh");
  expect(sameBytes(enc.encode("+id\r\n"), enc.encode("+id\r\n"))).toBe(true);
  expect(sameBytes(enc.encode("+id\r\n"), enc.encode("+ix\r\n"))).toBe(false);
});
