import { sleep } from "../shared";

// After the current request's reply has gone, with every storage write so far stored. If the sync fails, the
// runtime resets the object itself (a failed write breaks the output gate).
export async function resetSoon(ctx: DurableObjectState, reason: string): Promise<void> {
  await sleep(0);
  await ctx.storage.sync();
  ctx.abort(reason);
}
