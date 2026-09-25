// Owner instruction, 2026-09-25 (Telegram): "Если 5 минут никто не обращается - то
// автовыключение" -- a packaged local app should not need a separate manual "stop" step for the
// common case of just being done for a while. Scoped to the Next.js web server process only
// (`src/proxy.ts`'s own `/api/:path*` traffic, the only thing this process serves) -- MCP
// (`src/mcp/server.ts`) and the CLI (`src/cli/video-metadata.ts`) are each their own separate
// process, reading the local database directly and never depending on this server being up
// (confirmed by inspection: neither makes an HTTP call to it), so an idle web server going away
// has no effect on either. Only ever armed in a production (`npm run start`) process -- see
// `src/instrumentation.ts` -- never during `next dev`, so an active development session's server
// never disappears just because no browser tab happened to poll it for a while.
export const DEFAULT_IDLE_SHUTDOWN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CHECK_INTERVAL_MS = 15_000;

let lastActivityAt = Date.now();

/** Called from `src/proxy.ts` on every `/api/*` request -- the one thing every real form of use
 * of this server (a page's own periodic polls included, e.g. the Merge tab's conflict-summary/
 * sync-cycle intervals) already passes through, so no separate heartbeat/ping mechanism is
 * needed: as long as at least one browser tab is open, its own existing polling already keeps
 * this timestamp fresh, and once every tab is closed, polling naturally stops. */
export function recordActivity(now: Date = new Date()): void {
  lastActivityAt = now.getTime();
}

export function getLastActivityAt(): number {
  return lastActivityAt;
}

/** Pure decision function, kept separate from the timer/process-exit side effects below so it
 * can be tested directly without waiting on a real timer. */
export function isIdleTimeoutExceeded(args: { lastActivityAt: number; now: Date; timeoutMs: number }): boolean {
  return args.now.getTime() - args.lastActivityAt >= args.timeoutMs;
}

/** Starts the periodic idle check. Returns a stop function (used by tests; production code never
 * needs to call it, since the process is expected to exit once idle). The interval is `unref`'d
 * so it is never itself a reason the process stays alive -- the server's own listening socket is
 * what keeps the process running normally, exactly as intended. */
export function startIdleShutdownWatcher(
  opts: {
    timeoutMs?: number;
    checkIntervalMs?: number;
    onIdle?: () => void;
  } = {}
): () => void {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_IDLE_SHUTDOWN_TIMEOUT_MS;
  const checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const onIdle = opts.onIdle ?? (() => process.exit(0));

  const interval = setInterval(() => {
    if (isIdleTimeoutExceeded({ lastActivityAt: getLastActivityAt(), now: new Date(), timeoutMs })) {
      onIdle();
    }
  }, checkIntervalMs);
  interval.unref();

  return () => clearInterval(interval);
}
