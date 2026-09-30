import { startIdleShutdownWatcher } from "@/lib/idle-shutdown";

/**
 * Next.js's own `register()` hook -- called once when a new server instance starts, before it
 * accepts requests (node_modules/next/dist/docs/.../instrumentation.md).
 *
 * Gate B "off by default at the start of every session" (owner, 2026-09-21): the web server's
 * boot is the session start, so the shared Live-writes flag is reset here -- and ALSO when the web
 * server session ends (idle auto-shutdown, SIGINT/SIGTERM), so an MCP/CLI-only period after the web
 * server has stopped never inherits a Live-writes toggle nobody enabled for it (architecture-audit
 * review, H1). The signal handlers only reset -- Next.js keeps ownership of the actual shutdown, so
 * in-flight requests still drain. A hard crash can still skip the shutdown reset; the next web boot resets it
 * (docs/TECHNICAL_DEBT.md RISK-09). Deliberately NOT done in db.ts initialization, which also runs
 * in every MCP/CLI process and used to switch the operator's live toggle off mid-session (H1).
 *
 * The idle auto-shutdown itself (`src/lib/idle-shutdown.ts`, owner instruction 2026-09-25) is armed
 * only in a real production process, never during `next dev`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Dynamic import keeps db.ts out of the edge/instrumentation bundle graph.
  const { resetLiveWritesForNewServerSession } = await import("@/lib/db");
  await resetLiveWritesForNewServerSession();

  const resetQuietly = async () => {
    try {
      await resetLiveWritesForNewServerSession();
    } catch {
      // Best effort -- the next web boot resets it anyway.
    }
  };
  // On SIGINT/SIGTERM only RESET -- never exit here. Next.js's own signal handler closes the server
  // and lets in-flight requests finish (e.g. a Batch executing inside one request) before it exits;
  // exiting ourselves would cut such a request off mid-write (architecture-audit review, round 2).
  // The reset is a single local SQLite write, which in practice completes long before Next's drain.
  process.once("SIGINT", () => void resetQuietly());
  process.once("SIGTERM", () => void resetQuietly());

  if (process.env.NODE_ENV !== "production") return;
  // Idle auto-shutdown: no request is in flight by definition, so reset, then exit.
  startIdleShutdownWatcher({
    onIdle: () =>
      void resetQuietly().then(() => process.exit(0)),
  });
}
