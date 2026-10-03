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
//
// Widened from 5 to 60 minutes, owner instruction 2026-09-29 (Telegram), found by direct
// experience: the original 5-minute window shut the server down mid-session (e.g. while filling
// in a form with no `/api/*` traffic in between), surfacing as a plain fetch failure to whoever
// was using the app at the time, not a clear "the server went idle" message.
//
// Narrowed from 60 to 10 minutes, owner instruction 2026-10-03 (Telegram, BL-116): the page now sends a
// heartbeat (`GET /api/presence`, every minute, `src/components/server-presence.tsx`), so an open window is
// always "activity" and the long window that only existed to survive form-filling is no longer needed. "No
// window for 10 minutes" means the user has finished. `YTOM_IDLE_SHUTDOWN_MINUTES` overrides it (verification).
export const DEFAULT_IDLE_SHUTDOWN_TIMEOUT_MS = 10 * 60 * 1000;
/** A busy server (running operation, held lock, RUNNING Batch) defers the idle exit, but never longer than this. */
export const MAX_IDLE_DEFERRAL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_CHECK_INTERVAL_MS = 15_000;

// BL-116: kept on `globalThis`, not in a module variable. `src/proxy.ts` (which records the activity), the route
// handlers and `src/instrumentation.ts` (whose watcher reads it) are bundled separately by Next.js, each with its
// own copy of this module: a module-level variable written by one was never seen by the other, so the watcher
// counted NO activity at all (found live 2026-10-03: a server answering a request every few seconds still exited at
// the end of the window). Same `globalThis` singleton pattern as the device-sync runner.
const ACTIVITY_KEY = Symbol.for("ytom.idleShutdown.lastActivityAt");
type GlobalWithActivity = typeof globalThis & { [ACTIVITY_KEY]?: number };

/** Called from `src/proxy.ts` on every `/api/*` request -- the one thing every real form of use
 * of this server (a page's own periodic polls included, e.g. the Merge tab's conflict-summary/
 * sync-cycle intervals) already passes through, so no separate heartbeat/ping mechanism is
 * needed: as long as at least one browser tab is open, its own existing polling already keeps
 * this timestamp fresh, and once every tab is closed, polling naturally stops. */
export function recordActivity(now: Date = new Date()): void {
  (globalThis as GlobalWithActivity)[ACTIVITY_KEY] = now.getTime();
}

export function getLastActivityAt(): number {
  const g = globalThis as GlobalWithActivity;
  return (g[ACTIVITY_KEY] ??= Date.now());
}

/** Pure decision function, kept separate from the timer/process-exit side effects below so it
 * can be tested directly without waiting on a real timer. */
export function isIdleTimeoutExceeded(args: { lastActivityAt: number; now: Date; timeoutMs: number }): boolean {
  return args.now.getTime() - args.lastActivityAt >= args.timeoutMs;
}

/** `YTOM_IDLE_SHUTDOWN_MINUTES` (a positive number, fractions allowed) or the 10-minute default. */
export function resolveIdleTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const minutes = Number(env.YTOM_IDLE_SHUTDOWN_MINUTES);
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : DEFAULT_IDLE_SHUTDOWN_TIMEOUT_MS;
}

export type IdleDecision = "stay" | "defer" | "exit";

/**
 * Pure idle decision (BL-116). `stay`: still within the idle window. Past the window: `exit` when nothing is running,
 * `defer` while work is running -- until `MAX_IDLE_DEFERRAL_MS` after the window expired, then `exit` anyway (a
 * stale RUNNING row must not keep the server alive forever). `busySinceExpiry` is when the window expired.
 */
export function decideIdleShutdown(args: {
  lastActivityAt: number;
  now: Date;
  timeoutMs: number;
  busy: boolean;
  maxDeferralMs?: number;
}): IdleDecision {
  if (!isIdleTimeoutExceeded({ lastActivityAt: args.lastActivityAt, now: args.now, timeoutMs: args.timeoutMs })) return "stay";
  if (!args.busy) return "exit";
  const expiredAt = args.lastActivityAt + args.timeoutMs;
  return args.now.getTime() - expiredAt >= (args.maxDeferralMs ?? MAX_IDLE_DEFERRAL_MS) ? "exit" : "defer";
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
    /** True while work is running that an exit would cut short (BL-116). A throwing check counts as busy. */
    isBusy?: () => boolean | Promise<boolean>;
    maxDeferralMs?: number;
  } = {}
): () => void {
  const timeoutMs = opts.timeoutMs ?? resolveIdleTimeoutMs();
  const checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const onIdle = opts.onIdle ?? (() => process.exit(0));

  let checking = false;
  const interval = setInterval(() => {
    if (checking) return;
    checking = true;
    void (async () => {
      try {
        const lastActivityAt = getLastActivityAt();
        let busy = false;
        if (opts.isBusy && isIdleTimeoutExceeded({ lastActivityAt, now: new Date(), timeoutMs })) {
          try {
            busy = await opts.isBusy();
          } catch {
            busy = true; // cannot tell: do not cut work short
          }
        }
        const decision = decideIdleShutdown({ lastActivityAt, now: new Date(), timeoutMs, busy, maxDeferralMs: opts.maxDeferralMs });
        if (decision === "exit") onIdle();
      } finally {
        checking = false;
      }
    })();
  }, checkIntervalMs);
  interval.unref();

  return () => clearInterval(interval);
}
