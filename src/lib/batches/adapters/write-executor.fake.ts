import type { WriteExecutor, WriteExecutorResult } from "../contracts";

/**
 * Fake WriteExecutor for Slice 1 tests only. This is NOT wired into any production code
 * path -- `src/lib/batches/index.ts` does not construct or export one. It exists purely
 * so Slice 1's tests can exercise `beginAttempt`/`completeAttempt`/`executeSingleAttempt`'s
 * durable-ordering and multi-attempt data-model guarantees without a real YouTube adapter,
 * per the approved architectural decision #1 (shared WriteExecutor interface, Slice 4
 * substitutes the real adapter behind it, no alternative write path).
 *
 * `script` is consumed in order, one result per call to `attemptWrite`; calling it more
 * times than the script has entries throws (a test bug, not a production concern).
 */
export function createScriptedFakeWriteExecutor(script: WriteExecutorResult[]): WriteExecutor {
  let cursor = 0;
  return {
    async attemptWrite(): Promise<WriteExecutorResult> {
      if (cursor >= script.length) {
        throw new Error("createScriptedFakeWriteExecutor: script exhausted");
      }
      return script[cursor++];
    },
  };
}
