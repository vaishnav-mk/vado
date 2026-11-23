// Who is signed in, from the Cloudflare Access JWT. Every server function that changes something calls requireUser.
import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { accessUser } from "@vado/server";

const user = createServerOnlyFn((): Promise<string | null> => accessUser(getRequest(), env));

export const requireUser = createServerOnlyFn(async () => {
  if (!(await user())) throw new Error("Sign in first");
});

/** The signed-in email, or null. */
export const me = createServerFn({ method: "GET" }).handler(() => user());
