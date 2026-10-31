import { createIdleHandler, resolveIdleAction, startIdleShutdownWatcher } from "@/lib/idle-shutdown";
import { createDefaultLogger } from "@/lib/shared-logger";

const DEVICE_SYNC_BOOT_DELAY_MS = 5_000;
const DRAFT_SYNC_INTERVAL_MS = 60_000;
const DB_INIT_RETRY_POLL_MS = 5_000;

/**
 * Next.js's own `register()` hook -- called once when a new server instance starts, before it
 * accepts requests (node_modules/next/dist/docs/.../instrumentation.md).
 *
 * Live writes (ADR 0044, owner msg 3157, 2026-10-19): on by default and never reset by the server -- not at boot, not at
 * shutdown, not when idle. The web server only renews its session lease, so writes are honored while it runs; an MCP/CLI
 * process alone (the app down) cannot write. The owner's toggle in Settings is the one switch that turns writes off.
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
  const { LIVE_WRITES_SESSION_LEASE_RENEW_MS, expireLiveWritesSessionLease, migrateLiveWritesToDefaultOn, renewLiveWritesSessionLease } =
    await import("@/lib/db");
  // ADR 0044: once per database, the "off" left by the old per-session reset is forgotten (the toggle starts on).
  await migrateLiveWritesToDefaultOn().catch((error: unknown) =>
    createDefaultLogger().error({ event: "live_writes.default_on_migration_failed", context: { message: error instanceof Error ? error.message : String(error) } })
  );

  // BL-220 (RESTART_WHEN_IDLE_PLAN.md, ADR 0049): restart when idle. On every service boot a request left `restarting` (or still open) becomes
  // `done` with this build's version and schema. Only under the macOS system service (YTOM_SERVICE_MODE=1, launchd starts the next run)
  // the check runs every 15 s: the developer's request file, the 24 h expiry, and -- once nothing waits -- one SIGTERM to this process,
  // the same graceful stop as stop.sh (the handlers below still run). Its own loop; a failure never stops what follows (AGENTS.md §M).
  try {
    const { createRestartWhenIdleCore, RESTART_TICK_MS } = await import("@/lib/restart-when-idle");
    const restart = createRestartWhenIdleCore();
    if (process.env.YTOM_SERVICE_MODE === "1") {
      // Review (BL-220): only the service finalizes a request at boot -- another server on the same database (a worktree's dev
      // server) must never mark the live server's open request as done or take its request file.
      await restart.finalizeBoot().catch((error: unknown) =>
        console.warn(`[restart-when-idle] boot: ${error instanceof Error ? error.message : String(error)}`)
      );
      const { rawSqlClient: restartSqlClient } = await import("@/lib/db");
      const { assertDeviceAvailableForMutation: assertRestartMayWrite } = await import("@/lib/device-mutation-gate");
      const restartLoop = async () => {
        try {
          // It writes rows (the request, its expiry, `restarting`): never during an import / migration or in recovery mode -- the
          // gate the other loops use; paused quietly, the next check tries again.
          await assertRestartMayWrite(restartSqlClient);
          await restart.tick();
        } catch (error) {
          const paused = error instanceof Error && (error.name === "OperationLockError" || error.name === "RecoveryModeError");
          if (!paused) console.warn(`[restart-when-idle] ${error instanceof Error ? error.message : String(error)}`);
        }
        setTimeout(() => void restartLoop(), RESTART_TICK_MS).unref();
      };
      setTimeout(() => void restartLoop(), RESTART_TICK_MS).unref();
    }
  } catch (error) {
    console.warn(`[restart-when-idle] not started: ${error instanceof Error ? error.message : String(error)}`);
  }

  // BL-228 (SYSTEM_TOPIC_PLAN.md, ADR 0053 Amendment 1): the paid-call requests the factory writes for the owner's approval in the
  // HUB "System" topic. Its own loop (AGENTS.md §M): every 10 s, and only while the owner's switch is on under the Mac service, the
  // requests folder is scanned -- each new request is queued once for the hub to post, open ones past 2 h expire. The topic's
  // messages themselves reach this app through the hub's relay routes, not through this loop; nothing here calls Telegram. It
  // writes rows, so it waits while an import / migration holds the lock or in recovery mode, like the other loops.
  try {
    const { getSystemTopicCore } = await import("@/composition/system-topic-approvals");
    const { SYSTEM_TOPIC_SCAN_TICK_MS } = await import("@/lib/system-topic");
    const { rawSqlClient: systemSqlClient } = await import("@/lib/db");
    const { assertDeviceAvailableForMutation: assertSystemMayWrite } = await import("@/lib/device-mutation-gate");
    const systemTopic = getSystemTopicCore();
    let systemSwept = false;
    let lastSystemWarning: string | null = null;
    const systemScanLoop = async () => {
      try {
        await assertSystemMayWrite(systemSqlClient);
        if (!systemSwept) {
          // A request a dead process was running is failed (outcome unknown), so the factory's watcher gets its result file.
          await systemTopic.approvals.sweepInterrupted();
          systemSwept = true;
        }
        await systemTopic.approvals.scan().then(
          (result) => {
            if (result.scanned) lastSystemWarning = null;
            return result.scanned ? systemTopic.topic.recordScan(null) : undefined;
          },
          async (error: unknown) => {
            await systemTopic.topic.recordScan(error instanceof Error ? error.message : String(error));
            throw error;
          }
        );
      } catch (error) {
        const paused = error instanceof Error && (error.name === "OperationLockError" || error.name === "RecoveryModeError");
        const message = error instanceof Error ? error.message : String(error);
        // The same error every 10 s (e.g. the requests folder not created yet) is logged once; the card shows it meanwhile.
        if (!paused && message !== lastSystemWarning) console.warn(`[system-topic] ${message}`);
        if (!paused) lastSystemWarning = message;
      }
      setTimeout(() => void systemScanLoop(), SYSTEM_TOPIC_SCAN_TICK_MS).unref();
    };
    setTimeout(() => void systemScanLoop(), 20_000).unref();
  } catch (error) {
    console.warn(`[system-topic] not started: ${error instanceof Error ? error.message : String(error)}`);
  }

  // BL-237 (owner msgs 3864-3866): the disk guard. Every 15 minutes (first a few minutes after start) the free space of the
  // app-data and program volumes; below the threshold one bell notice and one System-topic message, again only after a
  // recovery or 24 h. Its own loop (AGENTS.md §M); it writes its state row, so it waits during an import / migration or in
  // recovery mode like the other loops. Every computer runs it; only one with the System topic on also posts there.
  try {
    const { getDiskGuardCore } = await import("@/composition/disk-guard");
    const { DISK_GUARD_FIRST_CHECK_MS, DISK_GUARD_TICK_MS } = await import("@/lib/disk-guard");
    const { rawSqlClient: diskSqlClient } = await import("@/lib/db");
    const { assertDeviceAvailableForMutation: assertDiskMayWrite } = await import("@/lib/device-mutation-gate");
    const diskLoop = async () => {
      try {
        await assertDiskMayWrite(diskSqlClient);
        await getDiskGuardCore().tick();
      } catch (error) {
        const paused = error instanceof Error && (error.name === "OperationLockError" || error.name === "RecoveryModeError");
        if (!paused) console.warn(`[disk-guard] ${error instanceof Error ? error.message : String(error)}`);
      }
      setTimeout(() => void diskLoop(), DISK_GUARD_TICK_MS).unref();
    };
    setTimeout(() => void diskLoop(), DISK_GUARD_FIRST_CHECK_MS).unref();
  } catch (error) {
    console.warn(`[disk-guard] not started: ${error instanceof Error ? error.message : String(error)}`);
  }

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

  // ADR 0044: SIGINT/SIGTERM no longer touch the owner's toggle; they only end this server's lease at once (review), so no CLI/MCP
  // process can write in the minutes after the server is gone. Next.js's own handler still closes the server and drains requests.
  const expireQuietly = () => void expireLiveWritesSessionLease().catch(() => undefined);
  process.once("SIGINT", expireQuietly);
  process.once("SIGTERM", expireQuietly);

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
  const { createAgentTokenSyncCoreForProduction } = await import("@/lib/agent-token-sync");
  const { recordSyncFamilyResult } = await import("@/lib/db");
  const applyAgentTokensQuietly = async () => {
    try {
      await createAgentTokenSyncCoreForProduction().tick();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      createDefaultLogger().error({ event: "agent_tokens.sync_failed", context: { message } });
      await recordSyncFamilyResult("agent_tokens", { ok: false, error: `applying or publishing tokens: ${message}` }).catch(() => undefined);
    }
  };
  const { createAgentTokensSyncRunnerForProduction } = await import("@/lib/sync-gateway");
  /** Whether the database may be written now (not in recovery mode, no export/import holding the operation lock). */
  const databaseWritable = () =>
    assertDeviceAvailableForMutation(rawSqlClient).then(
      () => true,
      () => false
    );
  /** BL-160, review round 2: while the database waits (recovery mode, an operation lock) the agent-tokens report FILE still
   * travels -- a revoke made in recovery mode (revoke is a stop switch) must reach the other devices. File work only, no database. */
  const exchangeAgentTokenFilesOnly = () => createAgentTokensSyncRunnerForProduction().runSyncCycle().catch(() => undefined);
  const syncFamiliesThenTokens = async () => {
    // NOT tied to the "Automatic device sync" toggle (cross-system audit, §M): that toggle
    // governs snapshot handoff only; draft sync already ran from every open tab regardless.
    // Same gate the "Sync now" route gets from src/proxy.ts.
    if (!(await databaseWritable())) {
      await exchangeAgentTokenFilesOnly();
      return;
    }
    try {
      await runAllSyncFamiliesOnce();
    } catch {
      // Failed -- each family records its own outcome; retry next time.
      return;
    }
    // BL-160: apply the agent tokens the other devices just reported, then publish this device's (when it changed, or daily). A
    // failure here is recorded on the family's status and logged -- the file exchange alone may have succeeded (review round 1).
    await applyAgentTokensQuietly();
  };
  // BL-160: one agent-tokens pass shortly after start (only that family, the others keep their first run at a minute), so tokens
  // issued or revoked elsewhere while this device was off apply within seconds of it starting.
  setTimeout(() => {
    void (async () => {
      const writable = await databaseWritable();
      await exchangeAgentTokenFilesOnly();
      if (writable) await applyAgentTokensQuietly();
    })();
  }, DEVICE_SYNC_BOOT_DELAY_MS).unref();
  setInterval(() => void syncFamiliesThenTokens(), DRAFT_SYNC_INTERVAL_MS).unref();

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
  // Every approved/running request at boot is an orphan (this is the single server process, so no run can be alive yet): no age cutoff,
  // and it runs now, before requests are served, so it can never catch a run started in this process.
  const { createMarketIntelligenceCore } = await import("@/lib/market-intelligence");
  await createMarketIntelligenceCore().sweepInterruptedCollectionRequests().catch(() => undefined);

  // BL-117 slice 1b: publish this device's quota-spend log to the shared Syncthing folder (its own file only), so every
  // device's history shows the whole picture of the shared Cloud quota. Never creates the folder; quiet on any failure.
  const { getQuotaLedgerSyncCore } = await import("@/lib/quota-ledger-sync");
  const publishQuotaLedgerQuietly = () => void getQuotaLedgerSyncCore().publishLocal().catch(() => undefined);
  setTimeout(publishQuotaLedgerQuietly, 45_000).unref();
  setInterval(publishQuotaLedgerQuietly, 120_000).unref();

  // BL-151 (docs/roadmap/plans/ANALYTICS_DATA_SHARING_PLAN.md): this device's analytics and reach rows out (its own day files
  // only), the other devices' in -- so a channel one computer collected today is current on the other too. Quiet on failure.
  const { getAnalyticsDataSync } = await import("@/lib/analytics-data-sync");
  const shareAnalyticsQuietly = () => {
    void (async () => {
      try {
        // Review M1: never during a snapshot import/migration or in recovery mode (the gate the draft sync uses).
        await assertDeviceAvailableForMutation(rawSqlClient);
      } catch {
        return; // paused; the next tick tries again
      }
      const sync = getAnalyticsDataSync();
      await sync
        .importPeers()
        .then(() => sync.publishLocal())
        .catch((error: unknown) => console.warn(`[analytics-data] ${error instanceof Error ? error.message : String(error)}`));
    })();
  };
  setTimeout(shareAnalyticsQuietly, 20_000).unref();
  setInterval(shareAnalyticsQuietly, 120_000).unref();

  // Phase 14 slice 2 (docs/roadmap/plans/PHASE_14_PLAN.md §2.3): generation sessions = RunPod pods that
  // must never outlive this process. Boot sweep first (a pod left by a dead process is terminated and
  // its session marked interrupted; AC-P14-08), then the watcher at the operator-set interval
  // (idle / minutes / USD caps, pod disappeared; AC-P14-06/07), and a best-effort terminate on
  // SIGINT/SIGTERM (AC-P14-09; the signal handlers stay non-blocking, Next.js owns the exit). With
  // no credentials configured every step answers "nothing to do" and makes no outbound call.
  const { createMediaGenerationCore } = await import("@/lib/media-generation");
  const media = createMediaGenerationCore();
  // NOT awaited (review round 7): a sweep that must terminate and confirm a pod can take minutes when RunPod
  // is slow, and nothing served over HTTP depends on it -- only the watch loop does, which waits for it below.
  // Jobs left mid-flight by a dead process fail as interrupted right after (their pod was just swept too).
  const mediaBootSweep = media
    .bootSweep()
    .catch(() => undefined)
    .then(() => media.sweepInterruptedJobs())
    .catch(() => undefined);
  // The exchange janitor (AC-P14-14): terminal leftovers under exchange/ on the volume, by ledger only. Daily, real deletes.
  const MEDIA_JANITOR_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const janitorQuietly = () => void media.cleanupExchange({ dryRun: false }).catch(() => undefined);
  setTimeout(janitorQuietly, 10 * 60_000).unref();
  setInterval(janitorQuietly, MEDIA_JANITOR_INTERVAL_MS).unref();
  // BL-172 (FO-REQ-0016 B): RunPod's GPU stock per datacenter, stored regularly -- BL-206 (FO-REQ-0033): every 15 minutes. The
  // core decides whether one is due (the newest stored snapshot is 14 min old; 15 min after a failed tick), skips without a RunPod call
  // while the gateway is off or nothing is configured, and never throws. The 5-minute tick keeps the gap at about 15-20 minutes.
  // Never during a snapshot import/migration or in recovery mode (the gate the draft sync uses).
  const GPU_AVAILABILITY_TICK_MS = 5 * 60_000;
  const snapshotGpuAvailabilityQuietly = () => {
    void (async () => {
      try {
        await assertDeviceAvailableForMutation(rawSqlClient);
      } catch {
        return; // paused; the next tick tries again
      }
      await media.snapshotGpuAvailabilityIfDue();
    })().catch(() => undefined);
  };
  setTimeout(snapshotGpuAvailabilityQuietly, 5 * 60_000).unref();
  setInterval(snapshotGpuAvailabilityQuietly, GPU_AVAILABILITY_TICK_MS).unref();
  // BL-132 (owner answer O1): the factory template registry is checked shortly after start and every 60 s; a sync runs
  // only when its files read differently from the last sync, so a device with no factory agent stays identical.
  const syncTemplatesQuietly = () => void media.syncTemplatesFromRegistry({ trigger: "auto", onlyIfChanged: true }).catch(() => undefined);
  setTimeout(syncTemplatesQuietly, 20_000).unref();
  setInterval(syncTemplatesQuietly, 60_000).unref();
  const MEDIA_WATCH_MIN_MS = 15_000;
  const mediaWatchLoop = async () => {
    await mediaBootSweep; // never rejects; already settled on every tick but the first
    try {
      // First: jobs nobody is polling (the operator CLI's detached core, a stuck transfer) -- their first poll
      // counts as session activity, so this runs BEFORE the idle check below.
      await media.resumeInFlightJobs();
    } catch {
      // RunPod unreachable, or nothing configured: try again next interval.
    }
    try {
      await media.watchTick();
    } catch {
      // same as above
    }
    try {
      // BL-138: this device's sessions for the other devices (sync-gateway `media-sessions`, carried by the sync scheduler).
      await media.publishSessionsShare();
    } catch (error) {
      // no device id / sync folder yet, or RunPod unreachable: the next tick tries again. A report that fails its own schema
      // would freeze what the other devices see, silently -- that one is logged (BL-148 independent review).
      if (error instanceof Error && error.name === "ZodError") console.warn(`[media-sessions] the sessions report was not published: ${error.message}`);
    }
    try {
      // BL-150: the Setup settings shared with the other devices -- applied here through Production's own validation. Never
      // during a snapshot import/migration or in recovery mode (it writes the settings), the gate the draft sync uses.
      const { rawSqlClient: sqlClient } = await import("@/lib/db");
      const { assertDeviceAvailableForMutation: assertAvailable } = await import("@/lib/device-mutation-gate");
      let available = true;
      try {
        await assertAvailable(sqlClient);
      } catch {
        available = false; // paused (lock/recovery): quietly, the next tick checks again
      }
      if (available) await media.syncSharedSettings();
    } catch (error) {
      console.warn(`[media-settings] the shared settings were not checked: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      // BL-143 phase 2: this device's generation plans for the other devices (sync-gateway `generation-plans`).
      const { publishGenerationPlansShare } = await import("@/lib/generation-plans");
      await publishGenerationPlansShare();
    } catch (error) {
      // Logged (independent review): a report that cannot be published would otherwise freeze silently. Retried next tick.
      console.warn(`[generation-plans] the plans report was not published: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      // Slice 4: a model pull's CPU pod is terminated as soon as its file is on the volume, even with no browser open.
      await media.pollPulls();
    } catch {
      // same as above
    }
    try {
      // BL-200: a runtime build's CPU pod is terminated as soon as its build.json is on the volume.
      await media.pollRuntimeBuilds();
    } catch (error) {
      console.warn(`[media] the runtime builds were not checked: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      // BL-200 stage 3: a runtime test's next step (build → GPU session → node check → test.json).
      await media.pollRuntimeTests();
    } catch (error) {
      console.warn(`[media] the runtime tests were not checked: ${error instanceof Error ? error.message : String(error)}`);
    }
    let intervalMs = 60_000;
    try {
      const settings = await media.getSettings();
      // BL-133: a session waiting for capacity is retried every capacityRetrySeconds (owner: 30 s), so the loop ticks at
      // least that often; with nothing to do a tick makes no outbound call.
      intervalMs = Math.max(MEDIA_WATCH_MIN_MS, Math.min(settings.watchIntervalSeconds, settings.capacityRetrySeconds) * 1000);
    } catch {
      // keep the default
    }
    setTimeout(() => void mediaWatchLoop(), intervalMs).unref();
  };
  setTimeout(() => void mediaWatchLoop(), 30_000).unref();
  // Best effort only: Next.js's own signal handler owns the exit and may finish before this terminate is sent, so
  // the boot sweep (above) is the authoritative cleanup for a Ctrl-C/kill with a running pod (RISK-107); the idle
  // auto-shutdown path below is the one that waits for the terminate.
  process.once("SIGINT", () => void media.stopForShutdown());
  process.once("SIGTERM", () => void media.stopForShutdown());

  // BL-174 (GEMINI_MEDIA_PLAN.md §2.4): Gemini image/video jobs, in their own loop (a slow RunPod tick never delays them,
  // AGENTS.md §M). First a job left mid-call by a dead process fails at its estimate (Google may have charged it); then every
  // 5 s due queued jobs are sent and running videos collected. With nothing queued or running a tick makes no outbound call.
  // Never during a snapshot import/migration or in recovery mode (it writes job rows and files), the gate the draft sync uses.
  // A failure to load the module must never stop what follows (the idle-shutdown watcher below), AGENTS.md §M.
  let gemini: import("@/lib/gemini-media").GeminiMediaCore | null = null;
  try {
    gemini = (await import("@/lib/gemini-media")).createGeminiMediaCore();
  } catch (error) {
    console.warn(`[gemini-media] not started: ${error instanceof Error ? error.message : String(error)}`);
  }
  const GEMINI_TICK_MS = 5_000;
  let geminiSwept = false;
  const geminiLoop = async () => {
    if (!gemini) return;
    try {
      await assertDeviceAvailableForMutation(rawSqlClient);
      if (!geminiSwept) {
        await gemini.worker.bootSweep();
        geminiSwept = true;
      }
      await gemini.worker.tick();
    } catch (error) {
      // Paused by the gate (an import / migration holds the lock, or recovery mode): quietly, the next tick checks again.
      const paused = error instanceof Error && (error.name === "OperationLockError" || error.name === "RecoveryModeError");
      if (!paused) console.warn(`[gemini-media] ${error instanceof Error ? error.message : String(error)}`);
    }
    setTimeout(() => void geminiLoop(), GEMINI_TICK_MS).unref();
  };
  setTimeout(() => void geminiLoop(), 10_000).unref();

  // BL-236 (ADR 0057): the ElevenLabs speech worker -- its own loop and module (AGENTS.md §M), the same gate and shape as Gemini's:
  // a take left mid-call by a dead process is failed at its characters first, then due queued takes are sent every 5 s. With the
  // owner's switch off (the default) or nothing queued, a tick makes no outbound call.
  let elevenlabs: import("@/lib/elevenlabs-speech").ElevenlabsSpeechCore | null = null;
  try {
    elevenlabs = (await import("@/lib/elevenlabs-speech")).createElevenlabsSpeechCore();
  } catch (error) {
    console.warn(`[elevenlabs-speech] not started: ${error instanceof Error ? error.message : String(error)}`);
  }
  let elevenlabsSwept = false;
  const elevenlabsLoop = async () => {
    if (!elevenlabs) return;
    try {
      await assertDeviceAvailableForMutation(rawSqlClient);
      if (!elevenlabsSwept) {
        await elevenlabs.worker.bootSweep();
        elevenlabsSwept = true;
      }
      await elevenlabs.worker.tick();
    } catch (error) {
      const paused = error instanceof Error && (error.name === "OperationLockError" || error.name === "RecoveryModeError");
      if (!paused) console.warn(`[elevenlabs-speech] ${error instanceof Error ? error.message : String(error)}`);
    }
    setTimeout(() => void elevenlabsLoop(), GEMINI_TICK_MS).unref();
  };
  setTimeout(() => void elevenlabsLoop(), 12_000).unref();

  // BL-193 (ADR 0039): this computer's Gemini spend for the other computers on the same key (the sync-gateway `gemini-spend`
  // report: written when it changed, at least every 5 minutes), and the shared Gemini limits applied here (the `gemini-settings`
  // document: seed, then apply what the other computers saved). In its own loop, so a slow worker tick never delays it and a
  // failure here never stops the worker (AGENTS.md §M). Applying a limit writes this computer's settings, so it waits while an
  // import / migration holds the lock or in recovery mode, like the worker; publishing the report only writes the report file.
  const GEMINI_SHARE_TICK_MS = 30_000;
  const geminiShareLoop = async () => {
    if (!gemini) return;
    try {
      await gemini.publishSpendShare();
    } catch (error) {
      console.warn(`[gemini-spend] the spend report was not published: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await assertDeviceAvailableForMutation(rawSqlClient);
      const status = await gemini.syncSharedSettings();
      if (status.error) console.warn(`[gemini-settings] ${status.error}`);
    } catch (error) {
      const paused = error instanceof Error && (error.name === "OperationLockError" || error.name === "RecoveryModeError");
      if (!paused) console.warn(`[gemini-settings] ${error instanceof Error ? error.message : String(error)}`);
    }
    setTimeout(() => void geminiShareLoop(), GEMINI_SHARE_TICK_MS).unref();
  };
  setTimeout(() => void geminiShareLoop(), 45_000).unref();

  // BL-236 (owner msg 3823, ADR 0057): the same for ElevenLabs -- this computer's characters for the other computers on the same key
  // (`elevenlabs-spend`), and the shared character limits applied here (`elevenlabs-settings`). Its own loop (AGENTS.md §M).
  const elevenlabsShareLoop = async () => {
    if (!elevenlabs) return;
    try {
      await elevenlabs.publishSpendShare();
    } catch (error) {
      console.warn(`[elevenlabs-spend] the spend report was not published: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await assertDeviceAvailableForMutation(rawSqlClient);
      const status = await elevenlabs.syncSharedSettings();
      if (status.error) console.warn(`[elevenlabs-settings] ${status.error}`);
    } catch (error) {
      const paused = error instanceof Error && (error.name === "OperationLockError" || error.name === "RecoveryModeError");
      if (!paused) console.warn(`[elevenlabs-settings] ${error instanceof Error ? error.message : String(error)}`);
    }
    setTimeout(() => void elevenlabsShareLoop(), GEMINI_SHARE_TICK_MS).unref();
  };
  setTimeout(() => void elevenlabsShareLoop(), 47_000).unref();

  // BL-188 (SHARED_MEDIA_JOBS_PLAN.md §2.1/§2.3): this computer's media jobs (RunPod and Gemini) for the other computers, and the
  // actions they sent for them (stage 2: applied here through the same services and limits as a local click), in its own
  // loop (AGENTS.md §M: a slow or broken jobs module never delays the others). The report file the sync-gateway `media-jobs`
  // family carries is written when it changed, and at least every 5 minutes. Received actions write rows (a job, a session's
  // approval), so they wait while an import / migration holds the lock or in recovery mode -- like the Gemini worker.
  const MEDIA_JOBS_SHARE_TICK_MS = 30_000;
  const mediaJobsShareLoop = async () => {
    try {
      // Stage 2: first the actions other computers sent for this computer's jobs and sessions, then the report.
      const { runMediaJobsPoolTick } = await import("@/lib/media-jobs-pool");
      await runMediaJobsPoolTick({
        mayApply: async () => {
          try {
            await assertDeviceAvailableForMutation(rawSqlClient);
            return true;
          } catch (error) {
            if (error instanceof Error && (error.name === "OperationLockError" || error.name === "RecoveryModeError")) return false;
            throw error;
          }
        },
      });
    } catch (error) {
      // Logged: a report that cannot be published would freeze what the other computers see. Retried next tick.
      console.warn(`[media-jobs] the jobs report was not published: ${error instanceof Error ? error.message : String(error)}`);
    }
    setTimeout(() => void mediaJobsShareLoop(), MEDIA_JOBS_SHARE_TICK_MS).unref();
  };
  setTimeout(() => void mediaJobsShareLoop(), 40_000).unref();

  // BL-194 (VIDEO_COST_PLAN.md §2 stages 2-3, ADR 0041): the cost of each video, in its own loop (AGENTS.md §M: a broken cost
  // report never delays the media modules or the uploads). Stage 2: every ended RunPod session's charge split across its jobs
  // (old sessions too, as estimates). It writes job rows and files, so it waits while an import / migration holds the lock or in
  // recovery mode.
  const VIDEO_COSTS_TICK_MS = 60_000;
  const videoCostsLoop = async () => {
    const paused = (error: unknown) => error instanceof Error && (error.name === "OperationLockError" || error.name === "RecoveryModeError");
    try {
      await assertDeviceAvailableForMutation(rawSqlClient);
      await media.splitEndedSessionCosts();
    } catch (error) {
      if (!paused(error)) console.warn(`[video-costs] RunPod session costs not split: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      // Stage 3: this computer's runs for the other computers (the sync-gateway `video-costs` report, written when it changed and at
      // least every 10 minutes), then every Vn_cost.json whose total a later report changed is written again.
      await assertDeviceAvailableForMutation(rawSqlClient);
      const costs = (await import("@/lib/video-costs")).createVideoCostsServiceForProduction();
      await costs.publishOwnReport();
      await costs.refreshCostFiles();
    } catch (error) {
      if (!paused(error)) console.warn(`[video-costs] the cost report was not published: ${error instanceof Error ? error.message : String(error)}`);
    }
    setTimeout(() => void videoCostsLoop(), VIDEO_COSTS_TICK_MS).unref();
  };
  setTimeout(() => void videoCostsLoop(), 50_000).unref();

  // BL-182 stage 2 (PUBLISHING_PLAN.md §2 stage 2 item 5, ADR 0037): the upload queue, in its own loop (AGENTS.md §M). With nothing
  // queued or sent a tick only reads the local table: no YouTube call. Each write checks Live writes right before it; while they are
  // off an upload pauses. Never during a snapshot import/migration or in recovery mode (it writes rows and the upload record).
  let uploads: import("@/lib/publishing").UploadRunner | null = null;
  try {
    // Review #1 (BL-225): the runner asks the weekly plan again before a slot's row starts and before its date (§M: composed here).
    const { planSlotDecisions } = await import("@/composition/publishing-plan-slots");
    // BL-233 (FO-REQ-0047): while a live stream runs here the upload keeps to its share of the uplink (§M: composed here).
    const { createUploadBandwidth } = await import("@/composition/upload-bandwidth");
    uploads = (await import("@/lib/publishing")).createUploadRunnerCore({ slotDecisions: planSlotDecisions, bandwidth: createUploadBandwidth() });
  } catch (error) {
    console.warn(`[publishing] uploads not started: ${error instanceof Error ? error.message : String(error)}`);
  }
  const UPLOADS_TICK_MS = 5_000;
  const uploadsLoop = async () => {
    if (!uploads) return;
    try {
      await assertDeviceAvailableForMutation(rawSqlClient);
      await uploads.tick();
    } catch (error) {
      const paused = error instanceof Error && (error.name === "OperationLockError" || error.name === "RecoveryModeError");
      if (!paused) console.warn(`[publishing] ${error instanceof Error ? error.message : String(error)}`);
    }
    setTimeout(() => void uploadsLoop(), UPLOADS_TICK_MS).unref();
  };
  setTimeout(() => void uploadsLoop(), 15_000).unref();

  // BL-209 (AUTO_PRIVATE_UPLOAD_PLAN.md, ADR 0046): the automatic private upload, in its own loop (AGENTS.md §M) every 5 minutes,
  // each tick started only after the previous one ended (a video hash can take a while). Off (the default) a tick reads the switch
  // only. On, ready packages whose video matches its manifest's size and SHA-256 are queued (private, no date) for the runner above;
  // nothing here writes to YouTube. Never during a snapshot import/migration or in recovery mode (it writes rows).
  let autoUploads: import("@/lib/publishing").AutoPrivateUpload | null = null;
  try {
    // BL-225 stage 3 (ADR 0051 §7): the weekly plan's slot decisions, plugged in from the composition layer (§M).
    const { planSlotDecisions } = await import("@/composition/publishing-plan-slots");
    autoUploads = (await import("@/lib/publishing")).createAutoPrivateUploadCore({ slotDecisions: planSlotDecisions });
  } catch (error) {
    console.warn(`[publishing] automatic upload not started: ${error instanceof Error ? error.message : String(error)}`);
  }
  const AUTO_UPLOADS_TICK_MS = 5 * 60_000;
  const autoUploadsLoop = async () => {
    if (!autoUploads) return;
    try {
      await assertDeviceAvailableForMutation(rawSqlClient);
      await autoUploads.tick();
    } catch (error) {
      const paused = error instanceof Error && (error.name === "OperationLockError" || error.name === "RecoveryModeError");
      if (!paused) console.warn(`[publishing] automatic upload: ${error instanceof Error ? error.message : String(error)}`);
    }
    setTimeout(() => void autoUploadsLoop(), AUTO_UPLOADS_TICK_MS).unref();
  };
  setTimeout(() => void autoUploadsLoop(), 60_000).unref();

  // BL-225 stage 3 (WEEKLY_PUBLISHING_PLAN.md, ADR 0051 §5/§10; owner msg 3537): the weekly plan's word on videos this computer
  // already uploaded for a slot -- a veto removes the date, an approval or a re-approval with a new time sets it -- in its own loop
  // every minute (§M). A row whose date already matches the plan costs no YouTube call; each change goes through video-details'
  // write path (identity, backup, Live writes right before the write, read-back). Never during an import/migration or recovery.
  let planSchedule: import("@/lib/publishing").PlanSchedule | null = null;
  try {
    const { planSlotDecisions } = await import("@/composition/publishing-plan-slots");
    planSchedule = (await import("@/lib/publishing")).createPlanScheduleCore({ slotDecisions: planSlotDecisions });
  } catch (error) {
    console.warn(`[publishing] plan schedule not started: ${error instanceof Error ? error.message : String(error)}`);
  }
  const PLAN_SCHEDULE_TICK_MS = 60_000;
  const planScheduleLoop = async () => {
    if (!planSchedule) return;
    try {
      await assertDeviceAvailableForMutation(rawSqlClient);
      await planSchedule.tick();
    } catch (error) {
      const paused = error instanceof Error && (error.name === "OperationLockError" || error.name === "RecoveryModeError");
      if (!paused) console.warn(`[publishing] plan schedule: ${error instanceof Error ? error.message : String(error)}`);
    }
    setTimeout(() => void planScheduleLoop(), PLAN_SCHEDULE_TICK_MS).unref();
  };
  setTimeout(() => void planScheduleLoop(), 90_000).unref();

  // BL-176 (LIVE_STREAMS_PLAN.md §3.1/§3.6/§3.8, ADR 0036): live streams, in their own loop (AGENTS.md §M). Switched off
  // (the default) or on a computer that is not the Mac's system service, a tick only reads the settings: no process, no
  // YouTube call. Otherwise a stream whose intent is on gets its encoder adopted or started again (the key is read from
  // YouTube -- a read; nothing here writes to YouTube), and every running stream is tended every 15 s. A running stream is
  // deliberately NOT "busy" for the idle watcher below (plan §3.1): Live writes still reset after 10 idle minutes.
  let liveStreams: import("@/lib/live-streams").LiveStreamsRunner | null = null;
  try {
    // BL-205: the segment switcher applies the video settings and adds recordings through modules plugged in here (§M).
    const { createLiveStreamVideoFields } = await import("@/composition/live-stream-video-fields");
    // BL-207: the stream's translations go to every segment too.
    const { createLiveStreamLocalizations } = await import("@/composition/live-stream-localizations");
    liveStreams = (await import("@/lib/live-streams")).createLiveStreamsRunnerCore({ videoFields: createLiveStreamVideoFields(), localizations: createLiveStreamLocalizations() });
  } catch (error) {
    console.warn(`[live-streams] not started: ${error instanceof Error ? error.message : String(error)}`);
  }
  const LIVE_STREAMS_TICK_MS = 15_000;
  const liveStreamsLoop = async () => {
    if (!liveStreams) return;
    try {
      await assertDeviceAvailableForMutation(rawSqlClient);
      await liveStreams.tick();
    } catch (error) {
      const paused = error instanceof Error && (error.name === "OperationLockError" || error.name === "RecoveryModeError");
      if (!paused) console.warn(`[live-streams] ${error instanceof Error ? error.message : String(error)}`);
    }
    setTimeout(() => void liveStreamsLoop(), LIVE_STREAMS_TICK_MS).unref();
  };
  setTimeout(() => void liveStreamsLoop(), 20_000).unref();

  // BL-212 (LIVE_ANALYTICS_PLAN.md stage 2): YouTube Analytics of our own ended broadcasts, once an hour, in its own loop
  // (AGENTS.md §M). Only broadcasts this computer sampled (BL-211) are asked about, so a computer that runs no stream makes no
  // call. Read-only; off with the Settings "Analytics reads" toggle like every Analytics read.
  const liveAnalyticsLoop = async () => {
    try {
      await assertDeviceAvailableForMutation(rawSqlClient);
      await (await import("@/lib/live-analytics")).createBroadcastAnalyticsCollectorCore().tick();
    } catch (error) {
      const paused = error instanceof Error && (error.name === "OperationLockError" || error.name === "RecoveryModeError");
      if (!paused) console.warn(`[live-analytics] ${error instanceof Error ? error.message : String(error)}`);
    }
    setTimeout(() => void liveAnalyticsLoop(), (await import("@/lib/live-analytics/contracts")).PULL_TICK_MS).unref();
  };
  setTimeout(() => void liveAnalyticsLoop(), 5 * 60_000).unref();

  // BL-222 (LIVE_ANALYTICS_PLAN.md §6): this computer's «Эфиры» summaries for the other computers, every 5 minutes (the sampling
  // cadence), in its own loop. Local reads and one local file; never a YouTube call. The sync cycle carries the file.
  const LIVE_ANALYTICS_PUBLISH_MS = 5 * 60_000;
  const liveAnalyticsPublishLoop = async () => {
    try {
      await assertDeviceAvailableForMutation(rawSqlClient);
      await (await import("@/lib/live-analytics")).publishLiveAnalyticsReport();
    } catch (error) {
      const paused = error instanceof Error && (error.name === "OperationLockError" || error.name === "RecoveryModeError");
      if (!paused) console.warn(`[live-analytics] report: ${error instanceof Error ? error.message : String(error)}`);
    }
    setTimeout(() => void liveAnalyticsPublishLoop(), LIVE_ANALYTICS_PUBLISH_MS).unref();
  };
  setTimeout(() => void liveAnalyticsPublishLoop(), 60_000).unref();

  if (process.env.NODE_ENV !== "production") return;
  // Idle auto-shutdown: no request is in flight by definition, so reset, publish any unexported
  // local changes, then exit. Deliberately NOT raced against a timeout: exiting while the export
  // holds the operation lock would leave that lock stale (never auto-released) -- a few-MB export
  // finishes in about a second anyway.
  // BL-116: an expired idle window never cuts running work short -- a registered operation (Fix all, syncs, ...),
  // a held export/import/migration lock, or a RUNNING Batch defers the exit (idle-shutdown.ts caps the deferral).
  const { getOperationRegistry } = await import("@/lib/operation-progress");
  const { getOperationLock } = await import("@/lib/operation-lock");
  // BL-158: the macOS system service (YTOM_SERVICE_MODE=1) is never stopped by idleness -- the same window ends the
  // browser session instead: Live writes are reset (RISK-09: they live only as long as a session), the process stays.
  // Pods keep running under the media watcher's own caps; the sync loop keeps publishing, so no final export is needed.
  const idleAction = resolveIdleAction();
  const idleLogger = createDefaultLogger();
  const onIdle = createIdleHandler(idleAction, {
    // A running generation pod is terminated BEFORE the process goes away (AC-P14-09; bounded inside).
    stopPods: () => media.stopForShutdown(),
    flush: async () => {
      await (ticking ?? undefined);
      await tickQuietly({ force: true, exportOnly: true });
    },
    exit: () => process.exit(0),
    onSessionEnded: () => idleLogger.info({ event: "idle_shutdown.session_ended", context: {} }),
    onSessionEndFailed: (error) =>
      idleLogger.error({
        event: "idle_shutdown.session_end_failed",
        context: { reason: error instanceof Error ? error.message : String(error), retry: "next idle check" },
      }),
  });
  startIdleShutdownWatcher({
    action: idleAction,
    isBusy: async () => {
      if (getOperationRegistry().hasActive()) return true;
      if ((await getOperationLock(rawSqlClient)) !== null) return true;
      // Phase 14: a pod in flight or a generating job is work, even though an MCP-driven agent sends this
      // server no HTTP traffic (an idle exit would terminate the pod mid-generation; capped by MAX_IDLE_DEFERRAL_MS).
      if (await media.hasOpenPod().catch(() => false)) return true;
      if (await media.hasInFlightJobs().catch(() => false)) return true;
      // BL-174: a Gemini job queued, being sent, or a video Google is still making.
      if (gemini && (await gemini.worker.hasActiveJobs().catch(() => false))) return true;
      // BL-182 stage 2 (ADR 0037 §6): an upload being sent or finished keeps the session (and so Live writes) going.
      if (uploads && (await uploads.isBusy().catch(() => false))) return true;
      const running = await rawSqlClient.execute("SELECT 1 FROM batches WHERE status = 'RUNNING' LIMIT 1");
      return running.rows.length > 0;
    },
    onIdle,
  });
}
