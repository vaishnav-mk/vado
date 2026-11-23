import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { accessUser } from "@vado/server";

const user = createServerOnlyFn((): Promise<string | null> => accessUser(getRequest(), env));

export const requireUser = createServerOnlyFn(async () => {
  if (!(await user())) throw new Error("Sign in first");
});

export const me = createServerFn({ method: "GET" }).handler(() => user());
