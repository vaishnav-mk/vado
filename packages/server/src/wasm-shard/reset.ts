import { sleep } from "../shared";

// After this reply is sent and every write so far is stored; a failed sync resets the object anyway.
export async function resetSoon(ctx: DurableObjectState, reason: string): Promise<void> {
  await sleep(0);
  await ctx.storage.sync();
  ctx.abort(reason);
}
