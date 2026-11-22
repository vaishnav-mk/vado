/** One bench test: query parameters in, a JSON object out. `req` is the HTTP request, absent from a Sender. */
export type Test = (env: Env, q: URLSearchParams, req?: Request) => Promise<object>;
