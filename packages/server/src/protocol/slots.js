// Redis Cluster key slots (CRC16/XMODEM of the key or its {hashtag}, mod 16384) and slot -> shard.
export const SLOTS = 16384;

const TABLE = (() => {
  const t = new Uint16Array(256);

  for (let i = 0; i < 256; i++) {
    let c = i << 8;

    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    t[i] = c;
  }

  return t;
})();

function crc16(b, from = 0, to = b.length) {
  let c = 0;

  for (let i = from; i < to; i++) c = ((c << 8) & 0xffff) ^ TABLE[((c >> 8) ^ b[i]) & 0xff];

  return c;
}

/** The slot of key bytes `k`, honouring `{hashtag}` like Redis Cluster. */
export function slotOf(k) {
  const open = k.indexOf(123); // {

  if (open >= 0) {
    const close = k.indexOf(125, open + 1); // }

    if (close > open + 1) return crc16(k, open + 1, close) % SLOTS;
  }

  return crc16(k) % SLOTS;
}

/** Contiguous slot ranges per shard, as Redis Cluster assigns them, so a shard can later split. */
export const shardOfSlot = (slot, shards) => Math.floor((slot * shards) / SLOTS);

/**
 * Shard epochs: `[{ from, shards }]` ordered by `from` (ms), first at 0.
 * A database's creation time picks its epoch, which fixes its shard count for life; adding an
 * epoch that starts later sizes new databases without moving any existing one.
 */
export function parseEpochs(raw) {
  if (!raw) return [{ from: 0, shards: 1 }];
  const list = JSON.parse(raw);
  let prev = -1;

  for (const e of list) {
    if (
      !Number.isSafeInteger(e.from) ||
      e.from <= prev ||
      !Number.isSafeInteger(e.shards) ||
      e.shards < 1 ||
      e.shards > SLOTS
    ) {
      throw new Error("SHARD_EPOCHS entries need ascending integer `from` and 1..16384 `shards`");
    }

    prev = e.from;
  }

  if (list[0]?.from !== 0) throw new Error("the first SHARD_EPOCHS entry must start at 0");

  return list;
}

export const epochAt = (epochs, time) => epochs.reduce((found, e) => (e.from <= time ? e : found), epochs[0]);
