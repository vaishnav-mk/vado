import type { ByteSocket } from "../protocol/types";
import { LOCAL_SOCKET_BUFFER } from "./config";

// Buffered like a TCP socket, so a write doesn't wait for the other end to read (both ends waiting is a deadlock).
const buffered = () =>
  new TransformStream<Uint8Array, Uint8Array>(undefined, undefined, {
    highWaterMark: LOCAL_SOCKET_BUFFER,
    size: (chunk) => chunk.byteLength,
  });

export function socketPair(): [ByteSocket, ByteSocket] {
  const up = buffered(),
    down = buffered();

  return [
    { readable: down.readable, writable: up.writable },
    { readable: up.readable, writable: down.writable },
  ];
}
