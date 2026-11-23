import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { accessUser } from "@vado/server";

const signIn = () => !!env.ACCESS_TEAM_DOMAIN && !!env.ACCESS_AUD;

const user = createServerOnlyFn((): Promise<string | null> =>
  signIn() ? accessUser(getRequest(), env) : Promise.resolve(null),
);

export const requireUser = createServerOnlyFn(async () => {
  if (!(await user())) throw new Error("Sign in first");
});

export const me = createServerFn({ method: "GET" }).handler(async () => ({ user: await user(), signIn: signIn() }));
