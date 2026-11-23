import type { RewriteDeps, RewriteJob } from "./types";

// patches/0004: 1 if the host took the rewrite a forked child would write, 0 to let Valkey rewrite inline.
export function aofRewrite(deps: RewriteDeps) {
  const { state } = deps;

  return (ptr: number, len: number, rdb: number, generation: number): number => {
    const tmp = deps.text(ptr, len);
    const job = state.rewriting ? null : state.onRewrite?.(tmp, rdb === 1);

    if (!job) return 0;
    state.rewriting = finishRewrite(deps, job, tmp, generation);

    return 1;
  };
}

// Awaited by replica copies, so it never rejects.
async function finishRewrite(deps: RewriteDeps, job: RewriteJob, tmp: string, generation: number): Promise<void> {
  await Promise.resolve(); // after the wasm call that started the rewrite has returned
  let ok = false;

  try {
    ok = await job();
  } catch (e) {
    deps.log(`rewrite: ${e instanceof Error ? e.stack : String(e)}`);
  }

  try {
    const t = Date.now(); // the clock moves only across I/O: this includes the sync's commit

    // false: that rewrite was killed meanwhile (and maybe another started), so tmp is a leftover.
    if (!deps.finish(ok, generation)) deps.remove(tmp);
    await deps.sync?.();
    deps.state.rewriteDoneMs = Date.now() - t;
  } catch (e) {
    deps.log(`rewrite finish: ${e instanceof Error ? e.stack : String(e)}`);
  } finally {
    deps.state.rewriting = null;
    deps.schedule();
  }
}
