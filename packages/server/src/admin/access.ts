// Checked here because ctx.access doesn't reach a Worker that has static assets.
import { createRemoteJWKSet, jwtVerify } from "jose";
import * as v from "valibot";

let keys: ReturnType<typeof createRemoteJWKSet> | null = null; // jose fetches, caches and refreshes them

export async function accessUser(
  request: Request,
  env: Pick<Env, "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD">,
): Promise<string | null> {
  const token =
    request.headers.get("cf-access-jwt-assertion") ??
    /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];

  // Unset by default (wrangler.jsonc): nobody can be signed in.
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const issuer = new URL(env.ACCESS_TEAM_DOMAIN).origin;
  keys ??= createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer));
  const verified = await jwtVerify(token, keys, { issuer, audience: env.ACCESS_AUD }).catch(() => null);
  const email = verified?.payload.email;

  return v.is(v.string(), email) ? email : null;
}
