// BL-271 (WAIT_TOOLS_PLAN.md §3.2, AC-WT-07): the process's stop signal for waits. One AbortController per process, on globalThis --
// Next builds the instrumentation and the routes as separate bundles, and a wait in a route must see the abort the instrumentation's
// SIGTERM handler sets. Nothing here installs a signal handler by itself: src/instrumentation.ts calls `signalShutdown` from its own.

const KEY = Symbol.for("youtube-operations-manager.operation-wait.shutdown");

function controller(): AbortController {
  const holder = globalThis as unknown as Record<symbol, AbortController | undefined>;
  return (holder[KEY] ??= new AbortController());
}

/** Aborted once this process is stopping: every blocked wait returns at once (`server_stopping`). */
export function shutdownSignal(): AbortSignal {
  return controller().signal;
}

/** Called by the server's SIGTERM / SIGINT handler. */
export function signalShutdown(): void {
  controller().abort();
}
