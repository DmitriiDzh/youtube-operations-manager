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

  // Phase 13 slice 13.2 (docs/roadmap/plans/PHASE_13_PLAN.md, owner decision D1 = a): other people's
  // channel data fetched from the YouTube API is kept at most 30 days (Developer Policies III.E.4.d).
  // First run a minute after boot, then every few hours; a full backup precedes the very first purge.
  const { API_DATA_RETENTION_INTERVAL_MS, runApiDataRetention } = await import("@/lib/youtube-data-policy");
  const retainQuietly = () => void runApiDataRetention().catch(() => undefined);
  setTimeout(retainQuietly, 60_000).unref();
  setInterval(retainQuietly, API_DATA_RETENTION_INTERVAL_MS).unref();

  // Research export (ADR 0019): the competitor data inside an export file follows the same 30-day rule, so the files the Manager wrote are
  // deleted by the Manager itself when their recorded expiry passes (ledger only -- never a scan of the operator's folder).
  const { sweepExpiredResearchExports } = await import("@/lib/research-export");
  const sweepExportsQuietly = () => void sweepExpiredResearchExports().catch(() => undefined);
  setTimeout(sweepExportsQuietly, 75_000).unref();
  setInterval(sweepExportsQuietly, API_DATA_RETENTION_INTERVAL_MS).unref();

  // BL-125: settled drafts (rejected, or approved and verified on YouTube) and fully successful write logs are deleted after the periods set
  // in Settings (default 7 / 30 days). Once a few minutes after boot, then hourly; in-review work and anything failed is never touched.
  const { sweepSettledWork } = await import("@/lib/retention");
  const sweepRetentionQuietly = () => void sweepSettledWork().catch(() => undefined);
  setTimeout(sweepRetentionQuietly, 120_000).unref();
  setInterval(sweepRetentionQuietly, 60 * 60 * 1000).unref();

  // Phase 13 slice 13.8: Wikipedia page views for topic-linked articles (free, no quota). Each run
  // fetches only days not stored yet; off when Settings → Wikipedia reads is off (the gateway refuses).
  const { WIKIPEDIA_COLLECTION_INTERVAL_MS, createWikipediaSignalsCore } = await import("@/lib/wikipedia-signals");
  const wikipedia = createWikipediaSignalsCore();
  const collectWikipediaQuietly = () => void wikipedia.collectAll().catch(() => undefined);
  setTimeout(collectWikipediaQuietly, 90_000).unref();
  setInterval(collectWikipediaQuietly, WIKIPEDIA_COLLECTION_INTERVAL_MS).unref();

  // Agent-created collection requests (docs/decisions/0021): a request left approved/running by a process that died mid-run becomes
  // failed ("interrupted") so its channels stop counting as having an open request. Quiet like the other boot sweeps.
  const { createMarketIntelligenceCore } = await import("@/lib/market-intelligence");
  const sweepCollectionRequestsQuietly = () =>
    void createMarketIntelligenceCore().sweepInterruptedCollectionRequests().catch(() => undefined);
  setTimeout(sweepCollectionRequestsQuietly, 30_000).unref();

  // BL-117 slice 1b: publish this device's quota-spend log to the shared Syncthing folder (its own file only), so every
  // device's history shows the whole picture of the shared Cloud quota. Never creates the folder; quiet on any failure.
  const { getQuotaLedgerSyncCore } = await import("@/lib/quota-ledger-sync");
  const publishQuotaLedgerQuietly = () => void getQuotaLedgerSyncCore().publishLocal().catch(() => undefined);
  setTimeout(publishQuotaLedgerQuietly, 45_000).unref();
  setInterval(publishQuotaLedgerQuietly, 120_000).unref();

  if (process.env.NODE_ENV !== "production") return;
  // Idle auto-shutdown: no request is in flight by definition, so reset, publish any unexported
  // local changes, then exit. Deliberately NOT raced against a timeout: exiting while the export
  // holds the operation lock would leave that lock stale (never auto-released) -- a few-MB export
  // finishes in about a second anyway.
  // BL-116: an expired idle window never cuts running work short -- a registered operation (Fix all, syncs, ...),
  // a held export/import/migration lock, or a RUNNING Batch defers the exit (idle-shutdown.ts caps the deferral).
  const { getOperationRegistry } = await import("@/lib/operation-progress");
  const { getOperationLock } = await import("@/lib/operation-lock");
  startIdleShutdownWatcher({
    isBusy: async () => {
      if (getOperationRegistry().hasActive()) return true;
      if ((await getOperationLock(rawSqlClient)) !== null) return true;
      const running = await rawSqlClient.execute("SELECT 1 FROM batches WHERE status = 'RUNNING' LIMIT 1");
      return running.rows.length > 0;
    },
    onIdle: () =>
      void resetQuietly()
        .then(() => ticking ?? undefined)
        .then(() => tickQuietly({ force: true, exportOnly: true }))
        .finally(() => process.exit(0)),
  });
}
