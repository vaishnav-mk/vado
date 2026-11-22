// The Worker's bindings, as the dashboard's server functions see them: they only pass env on to @vado/server.
declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}
