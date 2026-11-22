// Stock ioredis inside a Worker, over the TCP service binding:
//   import Redis from "ioredis";
//   const redis = new Redis({ Connector: bindingConnector(env.VALKEY, "mydb") });
// ioredis needs a Node stream; Duplex.fromWeb wraps the binding's Socket. No host/port is dialed.
import { Duplex } from "node:stream";

export function bindingConnector(binding, db) {
  return class BindingConnector {
    constructor() {
      this.connecting = false;
      this.stream = null;
    }
    check() {
      return true;
    }
    async connect() {
      const socket = binding.connect(`${db}:6379`);
      const stream = Duplex.fromWeb({ readable: socket.readable, writable: socket.writable });
      stream.connecting = false; // already usable: ioredis fires its connect handler on nextTick
      stream.setNoDelay = () => stream;
      stream.setKeepAlive = () => stream;
      stream.setTimeout = () => stream;
      this.stream = stream;
      return stream;
    }
    disconnect() {
      this.connecting = false;
      this.stream?.end();
    }
  };
}
