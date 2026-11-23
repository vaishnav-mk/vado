// `req` is absent when a Sender runs the test.
export type Test = (env: Env, q: URLSearchParams, req?: Request) => Promise<object>;
