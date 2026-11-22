import { RespClient } from "../protocol/resp-client";
import { serve } from "./serve";
import type { ClientSocket } from "./types";

/** A connection to database `name` through a Router in this isolate, as a service binding's would be (our own
 *  code: the shared password opens any database). */
export function connectLocal(env: Env, name: string): ClientSocket {
  const up = new TransformStream<Uint8Array, Uint8Array>(),
    down = new TransformStream<Uint8Array, Uint8Array>();

  void serve({ readable: up.readable, writable: down.writable }, env, name, "binding");

  return { readable: down.readable, writable: up.writable };
}

/** A RespClient on database `name` through a Router in this isolate, signed in. */
export async function openLocal(env: Env, name: string, stallMs?: number): Promise<RespClient> {
  const client = new RespClient(connectLocal(env, name), stallMs);

  if (env.VALKEY_PASSWORD) {
    const [reply] = await client.call(["AUTH", env.VALKEY_PASSWORD]);

    if (reply instanceof Object && "err" in reply) {
      client.close();
      throw new Error(`AUTH: ${reply.err}`);
    }
  }

  return client;
}
