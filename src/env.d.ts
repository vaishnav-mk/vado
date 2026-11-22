// The Worker's env, as the dashboard's server functions see it: they only pass it on to @vado/server's Admin and
// accessUser, which read its bindings (wrangler.jsonc). These are the vars and secrets that path reads.
declare module "cloudflare:workers" {
  interface WorkerEnv {
    ACCESS_TEAM_DOMAIN: string;
    ACCESS_AUD: string;
    VALKEY_PASSWORD?: string;
  }

  export const env: WorkerEnv;
}
