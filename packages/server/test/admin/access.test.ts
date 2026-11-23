// accessUser against a stand-in Access team: its keys are served from a stubbed fetch.
import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { accessUser } from "../../src/admin/access";

const TEAM = "https://team.cloudflareaccess.com",
  AUD = "aud-tag";

const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
let key: CryptoKeyPair, other: CryptoKeyPair;

beforeAll(async () => {
  [key, other] = await Promise.all([generateKeyPair("RS256"), generateKeyPair("RS256")]);
  const jwk = { ...(await exportJWK(key.publicKey)), kid: "k1", alg: "RS256" };
  vi.stubGlobal("fetch", async (url: URL) => {
    expect(String(url)).toBe(`${TEAM}/cdn-cgi/access/certs`);

    return Response.json({ keys: [jwk] });
  });
});

afterAll(() => vi.unstubAllGlobals());

interface Claims {
  iss?: string;
  aud?: string;
  exp?: string | number;
}

const jwt = ({ iss = TEAM, aud = AUD, exp = "1h" }: Claims = {}, signer = key.privateKey) =>
  new SignJWT({ email: "me@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(signer);

const request = (headers: Record<string, string>) => new Request("https://vado.example/", { headers });

test("a good token in the header or the cookie signs in", async () => {
  const token = await jwt();
  expect(await accessUser(request({ "cf-access-jwt-assertion": token }), env)).toBe("me@example.com");
  expect(await accessUser(request({ cookie: `a=b; CF_Authorization=${token}; c=d` }), env)).toBe("me@example.com");
});

test("anything else doesn't", async () => {
  const bad = await Promise.all([
    jwt({}, other.privateKey),
    jwt({ aud: "someone-else" }),
    jwt({ iss: "https://evil.cloudflareaccess.com" }),
    jwt({ exp: 1 }),
  ]);

  for (const token of [...bad, "not-a-jwt"])
    expect(await accessUser(request({ "cf-access-jwt-assertion": token }), env)).toBe(null);
  expect(await accessUser(request({}), env)).toBe(null);
});
