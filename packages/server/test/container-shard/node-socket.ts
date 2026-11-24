import { connect } from "node:net";

// A Workers Socket over node:net, for tests against a server in Docker.
export function socket(port: number): Socket {
  const s = connect(port, "127.0.0.1");

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      s.on("data", (d: Buffer) => controller.enqueue(new Uint8Array(d)));
      s.on("end", () => controller.close());
      s.on("error", (e) => controller.error(e));
    },
  });

  const writable = new WritableStream<Uint8Array>({
    write: (chunk) => new Promise((resolve, reject) => s.write(chunk, (e) => (e ? reject(e) : resolve()))),
    close: () => void s.end(),
  });

  const opened = new Promise<SocketInfo>((resolve, reject) => {
    s.once("connect", () => resolve({}));
    s.once("error", reject);
  });

  return {
    readable,
    writable,
    opened,
    closed: new Promise((resolve) => s.once("close", () => resolve())),
    upgraded: false,
    secureTransport: "off",
    close: async () => void s.destroy(),
    startTls: () => {
      throw new Error("no TLS in tests");
    },
  };
}
