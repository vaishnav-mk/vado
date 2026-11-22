// Signing in: a BENCH_TOKEN is traded once for a signed session string (ADMIN.session), kept in an
// HttpOnly cookie. The token itself is never stored. Every change checks the cookie again (requireSession).
import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { deleteCookie, getCookie, setCookie } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { z } from "zod";

const COOKIE = "vado_session";
const OPTIONS = { httpOnly: true, secure: true, sameSite: "strict", path: "/" } as const;

/** Whether this request carries a good session. */
const signedIn = createServerOnlyFn(async () => {
  const session = getCookie(COOKIE);
  return !!session && (await env.ADMIN.authorized(session));
});

/** Throws unless this request is signed in. Call first in every server function that changes something. */
export const requireSession = createServerOnlyFn(async () => {
  if (!(await signedIn())) throw new Error("Sign in first");
});

export const signIn = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string().trim().min(1).max(1024) }))
  .handler(async ({ data }) => {
    const session = await env.ADMIN.session(data.token);
    if (!session) throw new Error("That token isn't right");
    setCookie(COOKIE, session, { ...OPTIONS, maxAge: 7 * 24 * 3600 });
    return true;
  });

export const signOut = createServerFn({ method: "POST" }).handler(async () => {
  deleteCookie(COOKIE, OPTIONS);
  return false;
});

export const me = createServerFn({ method: "GET" }).handler(() => signedIn());
