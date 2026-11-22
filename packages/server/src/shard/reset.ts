/** Resets the object after the current request's reply has gone, with every storage write so far stored. */
export async function resetSoon(ctx: DurableObjectState, reason: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await ctx.storage.sync();
  ctx.abort(reason);
}
