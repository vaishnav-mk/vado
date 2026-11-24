// `req` is absent when a Sender runs the test.
export type Test = (env: Env, q: URLSearchParams, req?: Request) => Promise<object>;

export interface IoredisResult {
  ping?: string;
  set?: string | null;
  get?: string | null;
  mget?: (string | null)[];
  multi?: [Error | null, unknown][] | null;
  eval?: unknown;
  blpop?: [string, string] | null;
  pubsub?: string;
  pipeline?: number;
  pipelineMs?: number;
  error?: string;
}
