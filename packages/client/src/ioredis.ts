// new Redis({ Connector: bindingConnector(env.VALKEY, "mydb") })
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import type { ReadableWritablePair } from "node:stream/web";
import { AbstractConnector } from "ioredis";

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
