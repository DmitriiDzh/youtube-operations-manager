import { startIdleShutdownWatcher } from "@/lib/idle-shutdown";

/**
 * Next.js's own `register()` hook -- called once when a new server instance starts, before it
 * accepts requests (node_modules/next/dist/docs/.../instrumentation.md).
 *
 * Gate B "off by default at the start of every session" (owner, 2026-09-21): the web server's
 * boot is the session start, so the shared Live-writes flag is reset here -- and ALSO when the web
 * server session ends (idle auto-shutdown, SIGINT/SIGTERM), so an MCP/CLI-only period after the web
 * server has stopped never inherits a Live-writes toggle nobody enabled for it (architecture-audit
 * review, H1). A hard crash can still skip the shutdown reset; the next web boot resets it
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

  let shuttingDown = false;
  const endSession = async (exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await resetLiveWritesForNewServerSession();
    } catch {
      // Best effort -- the next web boot resets it anyway.
    }
    process.exit(exitCode);
  };
  process.once("SIGINT", () => void endSession(0));
  process.once("SIGTERM", () => void endSession(0));

  if (process.env.NODE_ENV !== "production") return;
  startIdleShutdownWatcher({ onIdle: () => void endSession(0) });
}
