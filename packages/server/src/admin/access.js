// Who is signed in, from Cloudflare Access. Access signs a JWT for each request it lets through: the
// Cf-Access-Jwt-Assertion header on a path it protects, and the CF_Authorization cookie on the rest of the host
// after that. The Worker checks the JWT against the team's keys itself (ctx.access doesn't reach a Worker that has
// static assets): ACCESS_TEAM_DOMAIN is the issuer and ACCESS_AUD the audience.
import { createRemoteJWKSet, jwtVerify } from "jose";

let keys = null; // the team's signing keys: jose fetches, caches and refreshes them

/** The email of the person `request` is signed in as, or null. */
export async function accessUser(request, env) {
  const token = request.headers.get("cf-access-jwt-assertion") ?? /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  if (!token) return null;
  const issuer = new URL(env.ACCESS_TEAM_DOMAIN).origin;
  keys ??= createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer));
  const verified = await jwtVerify(token, keys, { issuer, audience: env.ACCESS_AUD }).catch(() => null);
  return verified?.payload.email ?? null;
}
