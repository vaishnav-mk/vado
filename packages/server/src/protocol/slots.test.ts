import { expect, test } from "vite-plus/test";
import { crc16, shardOfSlot, slotOf, SLOTS } from "./slots";

const enc = new TextEncoder();

test("slots match Redis Cluster", () => {
  expect(crc16(enc.encode("123456789")), "CRC16/XMODEM check value").toBe(0x31c3);
  expect(slotOf(enc.encode("foo"))).toBe(12182);
  expect(slotOf(enc.encode("{user1000}.following"))).toBe(slotOf(enc.encode("user1000")));
  expect(slotOf(enc.encode("{}x")), "an empty tag hashes the whole key").toBe(crc16(enc.encode("{}x")) % SLOTS);
  expect(shardOfSlot(0, 4)).toBe(0);
  expect(shardOfSlot(SLOTS - 1, 4)).toBe(3);
  expect(shardOfSlot(SLOTS / 2, 2)).toBe(1);
});
