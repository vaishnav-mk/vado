import { shardOfSlot, slotOf, SLOTS } from "@vado/server/protocol/slots.ts";
import { useState } from "react";
import { SHARD_COUNTS } from "@vado/server/catalog/names.ts";

const encoder = new TextEncoder();

export function SlotDiagram() {
  const [first, setFirst] = useState("user:{42}:name");
  const [second, setSecond] = useState("user:{42}:email");
  const [shards, setShards] = useState(16);
  const slotA = slotOf(encoder.encode(first));
  const slotB = slotOf(encoder.encode(second));
  const shardA = shardOfSlot(slotA, shards);
  const shardB = shardOfSlot(slotB, shards);
  const perShard = SLOTS / shards;

  return (
    <figure className="diagram-card">
      <div className="diagram-top">
        <span className="status">Where two keys land</span>
        <span>CRC16 mod 16,384, the same function the router runs</span>
      </div>
      <div className="slot-demo">
        <div className="slot-inputs">
          <label>
            First key
            <input value={first} spellCheck={false} onChange={(event) => setFirst(event.target.value)} />
          </label>
          <label>
            Second key
            <input value={second} spellCheck={false} onChange={(event) => setSecond(event.target.value)} />
          </label>
          <label>
            Shards
            <select value={shards} onChange={(event) => setShards(Number(event.target.value))}>
              {SHARD_COUNTS.map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="shard-grid" aria-label={`Shards ${shardA} and ${shardB} of ${shards}`}>
          {Array.from({ length: shards }, (_, index) => (
            <span key={index} className="shard-cell" data-hit={index === shardA || index === shardB}>
              {index}
            </span>
          ))}
        </div>
        <p className="slot-caption" aria-live="polite">
          First key: slot <code>{slotA}</code>, shard <code>{shardA}</code>. Second key: slot <code>{slotB}</code>,
          shard <code>{shardB}</code>. Each shard owns {perShard.toLocaleString("en-US")} contiguous slots.
          <br />
          {slotA === slotB
            ? "Same slot: any multi-key command, transaction or script over both keys works."
            : "Different slots: MGET, MSET, DEL, UNLINK, EXISTS and TOUCH still work, split by the router. Other multi-key commands get CROSSSLOT."}
        </p>
      </div>
      <figcaption className="bar-caption">
        A key with a non-empty <code>{"{hashtag}"}</code> hashes only the part in braces, so related keys can share a
        slot.
      </figcaption>
    </figure>
  );
}
