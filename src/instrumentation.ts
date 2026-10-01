import { startIdleShutdownWatcher } from "@/lib/idle-shutdown";

const DEVICE_SYNC_BOOT_DELAY_MS = 5_000;
const DRAFT_SYNC_INTERVAL_MS = 60_000;
const DB_INIT_RETRY_POLL_MS = 5_000;

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

  // Stuck-lock recovery: a failed database initialization (typically a stale operation lock left by
  // a killed migration) must NOT stop the server from starting -- otherwise the operator has no
  // interface to fix it with. Serve anyway (the /recovery page works without the database being
  // initialized) and start the session work once a later attempt succeeds.
  const { ensureDatabaseInitialized } = await import("@/lib/db");
  try {
    await ensureDatabaseInitialized();
  } catch (error) {
    console.error(
      `[startup] Database initialization failed: ${error instanceof Error ? error.message : String(error)}
` +
        "[startup] The server is still running -- open /recovery in the browser to inspect or clear a stuck lock."
    );
    const retry = setInterval(() => {
      ensureDatabaseInitialized().then(
        () => {
          clearInterval(retry);
          void startServerSession();
        },
        () => undefined
      );
    }, DB_INIT_RETRY_POLL_MS);
    retry.unref();
    return;
  }
  await startServerSession();
}

async function startServerSession() {
  // Dynamic import keeps db.ts out of the edge/instrumentation bundle graph.
  const { LIVE_WRITES_SESSION_LEASE_RENEW_MS, renewLiveWritesSessionLease, resetLiveWritesForNewServerSession } =
    await import("@/lib/db");
  await resetLiveWritesForNewServerSession();

  // Session lease (architecture-audit review, round 3): Live writes are honored only while this web
  // server keeps renewing it, so ANY end of the session -- including a crash or Windows
  // `taskkill /F` / a closed console window, where no signal handler runs -- makes them lapse within
  // LIVE_WRITES_SESSION_LEASE_TTL_MS. A failed renewal never crashes the server; it only fails closed.
  const renewQuietly = async () => {
    try {
      await renewLiveWritesSessionLease();
    } catch {
      // Fail closed: the lease simply expires.
    }
  };
  await renewQuietly();
  setInterval(() => void renewQuietly(), LIVE_WRITES_SESSION_LEASE_RENEW_MS).unref();

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

  // Automatic device sync (docs/roadmap/plans/DEVICE_AUTO_SYNC_PLAN.md §3.5): the snapshot tick
  // (export when changed / import a fast-forward / otherwise notify) and the draft sync-gateway
  // cycle both run here, server-side, so neither needs an open browser tab. Every step is gated
  // inside the runner (toggle, configured folder, operation lock, recovery mode, running Batch);
  // nothing here ever throws into the server. There is deliberately NO export in the SIGINT/SIGTERM
  // handlers: a process killed mid-export would leave an operation lock that is never auto-released.
  const { getDeviceSyncRunner, DEVICE_SYNC_TICK_MS } = await import("@/lib/device-sync");
  const deviceSync = getDeviceSyncRunner();
  let ticking: Promise<unknown> | null = null;
  const tickQuietly = (options: { force?: boolean; exportOnly?: boolean } = {}) => {
    if (!ticking) {
      ticking = deviceSync
        .tick(options)
        .catch(() => undefined)
        .finally(() => {
          ticking = null;
        });
    }
    return ticking;
  };
  // First tick shortly after boot: this is the "load the latest data at startup" moment.
  setTimeout(() => void tickQuietly(), DEVICE_SYNC_BOOT_DELAY_MS).unref();
  setInterval(() => void tickQuietly(), DEVICE_SYNC_TICK_MS).unref();

  const { rawSqlClient } = await import("@/lib/db");
  const { runAllSyncFamiliesOnce } = await import("@/lib/sync-gateway");
  const { assertDeviceAvailableForMutation } = await import("@/lib/device-mutation-gate");
  setInterval(() => {
    void (async () => {
      try {
        // NOT tied to the "Automatic device sync" toggle (cross-system audit, §M): that toggle
        // governs snapshot handoff only; draft sync already ran from every open tab regardless.
        // Same gate the "Sync now" route gets from src/proxy.ts.
        await assertDeviceAvailableForMutation(rawSqlClient);
        await runAllSyncFamiliesOnce();
      } catch {
        // Paused (lock/recovery) or failed -- each family records its own outcome; retry next time.
      }
    })();
  }, DRAFT_SYNC_INTERVAL_MS).unref();

  if (process.env.NODE_ENV !== "production") return;
  // Idle auto-shutdown: no request is in flight by definition, so reset, publish any unexported
  // local changes, then exit. Deliberately NOT raced against a timeout: exiting while the export
  // holds the operation lock would leave that lock stale (never auto-released) -- a few-MB export
  // finishes in about a second anyway.
  startIdleShutdownWatcher({
    onIdle: () =>
      void resetQuietly()
        .then(() => ticking ?? undefined)
        .then(() => tickQuietly({ force: true, exportOnly: true }))
        .finally(() => process.exit(0)),
  });
}
