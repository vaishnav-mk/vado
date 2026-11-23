import { sleep } from "../shared";

// After the current request's reply has gone, with every storage write so far stored.
export async function resetSoon(ctx: DurableObjectState, reason: string): Promise<void> {
  await sleep(0);
  await ctx.storage.sync();
  ctx.abort(reason);
}
