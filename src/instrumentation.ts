import { startIdleShutdownWatcher } from "@/lib/idle-shutdown";

/**
 * Next.js's own `register()` hook -- called once when a new server instance starts, before it
 * accepts requests (node_modules/next/dist/docs/.../instrumentation.md). Only arms the idle
 * auto-shutdown (`src/lib/idle-shutdown.ts`, owner instruction 2026-09-25) in a real production
 * process (`npm run start`/`start.sh`) on the Node.js runtime -- never during `next dev`, so an
 * active development session's server never exits just because no browser tab happened to poll
 * it for 5 minutes.
 */
export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV !== "production") return;

  startIdleShutdownWatcher();
}
