// Cooperative cancel for a batch execution running IN THIS PROCESS (ADR 0016).
//
// A cancel flag exists only while `executeBatch` is actually running: `beginBatchExecution` creates it
// (clearing anything stale), `endBatchExecution` removes it in a `finally`. A cancel for a batch that is
// not executing is refused, so no flag can outlive a run and silently cancel a later one. In memory on
// purpose: it describes work this server process is doing, and a restart ends that work (resuming goes
// through `recoverBatch`, never through a leftover flag). Kept on globalThis so a dev hot reload cannot
// split the route that requests the cancel from the run that reads it.

type ControlEntry = { cancelRequested: boolean; token: symbol };

const CONTROL_KEY = Symbol.for("youtube-operations-manager.batch-execution-control");

function entries(): Map<string, ControlEntry> {
  const holder = globalThis as unknown as Record<symbol, Map<string, ControlEntry> | undefined>;
  return (holder[CONTROL_KEY] ??= new Map());
}

/** Registers a run and returns its token; `endBatchExecution` removes the entry only for that token, so
 * a run that finishes late can never delete the entry of a newer run of the same batch. */
export function beginBatchExecution(batchId: string): symbol {
  const token = Symbol(batchId);
  entries().set(batchId, { cancelRequested: false, token });
  return token;
}

export function endBatchExecution(batchId: string, token: symbol): void {
  if (entries().get(batchId)?.token === token) entries().delete(batchId);
}

/** Sets the flag if (and only if) the batch is executing now. Synchronous on purpose: the flag is set
 * before the caller's next await, so a row that starts afterwards always sees it. */
export function requestBatchCancelFlag(batchId: string): boolean {
  const entry = entries().get(batchId);
  if (!entry) return false;
  entry.cancelRequested = true;
  return true;
}

export function isBatchCancelRequested(batchId: string): boolean {
  return entries().get(batchId)?.cancelRequested === true;
}
