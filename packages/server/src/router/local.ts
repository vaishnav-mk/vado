import { RespClient } from "../protocol/resp-client";
import { serve } from "./serve";
import { socketPair } from "./socket-pair";
import type { ClientSocket } from "./types";
import { failure } from "../shared";

// Trusted like a service binding: it's our own code.
export function connectLocal(env: Env, name: string): ClientSocket {
  const [client, server] = socketPair();
  void serve(server, env, name, "binding");

  return client;
}

export async function openLocal(env: Env, name: string, stallMs?: number): Promise<RespClient> {
  const client = new RespClient(connectLocal(env, name), stallMs);

  if (env.VALKEY_PASSWORD) {
    const [reply] = await client.call(["AUTH", env.VALKEY_PASSWORD]);
    const err = failure(reply);

    if (err !== null) {
      client.close();
      throw new Error(`AUTH: ${err}`);
    }
  }

  return client;
}
