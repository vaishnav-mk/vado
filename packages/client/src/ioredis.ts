// Stock ioredis inside a Worker, over the TCP service binding:
//   const redis = new Redis({ Connector: bindingConnector(env.VALKEY, "mydb") });
// ioredis needs a Node stream; Duplex.fromWeb wraps the binding's socket. No host or port is dialed.
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import type { ReadableWritablePair } from "node:stream/web";
import { AbstractConnector } from "ioredis";

/** What the connector dials: a service binding, or anything else that opens a socket by address. */
export interface Dialer {
  connect(address: string): { readable: ReadableStream; writable: WritableStream };
}

const DISCONNECT_MS = 2_000; // ioredis's own default: how long a closing stream may take before it's destroyed

export function bindingConnector(binding: Dialer, db: string): new () => AbstractConnector {
  return class BindingConnector extends AbstractConnector {
    constructor() {
      super(DISCONNECT_MS);
    }

    async connect(): Promise<Socket> {
      // SAFETY: Workers' web streams are Node's at runtime (nodejs_compat); only their type declarations differ.
      const duplex = Duplex.fromWeb(binding.connect(`${db}:6379`) as ReadableWritablePair);
      // SAFETY: ioredis uses a net.Socket only as a Duplex plus these three setters and `connecting`.
      const stream = duplex as Socket;
      Object.assign(stream, {
        connecting: false, // already usable: ioredis fires its connect handler on nextTick
        setNoDelay: () => stream,
        setKeepAlive: () => stream,
        setTimeout: () => stream,
      });
      this.stream = stream;

      return stream;
    }
  };
}
