import { startIdleShutdownWatcher } from "@/lib/idle-shutdown";

/**
 * Next.js's own `register()` hook -- called once when a new server instance starts, before it
 * accepts requests (node_modules/next/dist/docs/.../instrumentation.md). Only arms the idle
 * auto-shutdown (`src/lib/idle-shutdown.ts`, owner instruction 2026-09-25) in a real production
 * process (`npm run start`/`start.sh`) on the Node.js runtime -- never during `next dev`, so an
 * active development session's server never exits just because no browser tab happened to poll
 * it for a while.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Gate B "off at the start of every session" -- the web server's boot is the session start. Runs
  // for `next dev` too. Deliberately here and NOT in db.ts initialization, which also runs in every
  // MCP/CLI process and used to switch the operator's live toggle off (architecture audit H1).
  // Dynamic import keeps db.ts out of the edge/instrumentation bundle graph.
  const { resetLiveWritesForNewServerSession } = await import("@/lib/db");
  await resetLiveWritesForNewServerSession();

  if (process.env.NODE_ENV !== "production") return;
  startIdleShutdownWatcher();
}
