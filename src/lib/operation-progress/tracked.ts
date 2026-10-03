import type { ProgressReporter } from "./contracts";
import type { OperationRegistry } from "./registry";

/**
 * Wraps ONE blocking server operation (a sync, a generation, a collection) so it shows up in the
 * operation registry while it runs (ADR 0015): stage and counts for the overlay, a heartbeat that keeps
 * the idle auto-shutdown away, and a final status. The caller's result -- or its error, unchanged -- still
 * reaches the route exactly as before, so adding progress never changes an endpoint's own response.
 *
 * `OperationAlreadyRunningError` is thrown BEFORE the work starts when a run of the same kind is already
 * active for the channel; the route maps it to 409 with the running operation's id.
 */
export async function runTrackedOperation<T>(args: {
  registry: OperationRegistry;
  kind: string;
  channelId: string;
  title: string;
  /** Whether `work` honours `progress.isCancelRequested()` (it must check BEFORE each item). */
  cancellable: boolean;
  work: (progress: ProgressReporter) => Promise<T>;
  messageFor?: (result: T) => string | null;
}): Promise<T> {
  const handle = args.registry.start({
    kind: args.kind,
    channelId: args.channelId,
    title: args.title,
    items: [],
    cancellable: args.cancellable,
  });
  const progress: ProgressReporter = {
    stage: (text) => handle.setStage(text),
    counts: (done, total) => handle.setCounts(done, total),
    isCancelRequested: () => handle.isCancelRequested(),
  };
  try {
    const result = await args.work(progress);
    handle.finish({ message: args.messageFor?.(result) ?? null });
    return result;
  } catch (error) {
    handle.finish({ error: true, message: error instanceof Error ? error.message : "Operation failed" });
    throw error;
  }
}
