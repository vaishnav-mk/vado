// Redis Cluster key slots (CRC16/XMODEM of the key or its {hashtag}, mod 16384) and slot -> shard.
export const SLOTS = 16384;

const TABLE = new Uint16Array(256);

for (let i = 0; i < 256; i++) {
  let c = i << 8;

  for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  TABLE[i] = c;
}

/** CRC16/XMODEM of `b[from..to)`. */
export function crc16(b: Uint8Array, from = 0, to = b.length): number {
  let c = 0;

  for (let i = from; i < to; i++) c = ((c << 8) & 0xffff) ^ TABLE[((c >> 8) ^ b[i]) & 0xff];

  return c;
}

/** The slot of key bytes `k`, honouring `{hashtag}` like Redis Cluster. */
export function slotOf(k: Uint8Array): number {
  const open = k.indexOf(123);

  if (open >= 0) {
    const close = k.indexOf(125, open + 1);

    if (close > open + 1) return crc16(k, open + 1, close) % SLOTS;
  }

  return crc16(k) % SLOTS;
}

/** Contiguous slot ranges per shard, as Redis Cluster assigns them, so a shard can later split. */
export const shardOfSlot = (slot: number, shards: number): number => Math.floor((slot * shards) / SLOTS);
