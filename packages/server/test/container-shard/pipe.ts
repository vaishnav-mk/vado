// One end of a connection: it reads what is written to `input`, and its writes go to `onWrite`.
export function end(input: TransformStream<Uint8Array, Uint8Array>, onWrite: (chunk: Uint8Array) => void): Socket {
  return {
    readable: input.readable,
    writable: new WritableStream({ write: onWrite }),
    opened: Promise.resolve({}),
    closed: new Promise(() => {}),
    upgraded: false,
    secureTransport: "off",
    close: async () => {},
    startTls: () => {
      throw new Error("no TLS");
    },
  };
}

// `bytes` as a socket gives them, in small reads.
export function send(to: WritableStreamDefaultWriter<Uint8Array>, bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i += 64) void to.write(bytes.subarray(i, i + 64));
}
