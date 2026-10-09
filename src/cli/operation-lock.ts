import { createLibsqlClient } from "@/lib/libsql-client";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import {
  OPERATION_LOCK_FORCE_CONFIRMATION,
  clearOperationLockIfUnchanged,
  describeOperationLock,
  getOperationLock,
  type SqlExecutor,
} from "@/lib/operation-lock";

// Operator CLI for a stuck device operation lock, for when even the web app cannot start:
//
//   npm run operation-lock -- status
//   npm run operation-lock -- clear                      (holder process is gone)
//   npm run operation-lock -- clear --force --confirm CLEAR   (holder looks alive; operator override)
//   npm run operation-lock -- wait-idle [--timeout <seconds>]  (used by the start/stop launchers)
//   npm run operation-lock -- media-idle                        (used by the stop launchers: no media session running here)
//
// Opens the database file directly -- it never imports src/lib/db.ts, whose initialization is
// exactly what fails while the lock is stuck. Only ever reads/deletes the one operation-lock row.

const HELP = [
  "Usage: npm run operation-lock -- <status | clear | wait-idle | media-idle> [--force --confirm " + OPERATION_LOCK_FORCE_CONFIRMATION + "]",
  "  status   show the device operation lock, how long it has been held, and whether its process still runs",
  "  clear    remove the lock when its holder process is no longer running",
  "  wait-idle [--timeout <seconds>]   wait (default 120s) until no running operation holds the lock; exit 1 on timeout",
  "  media-idle   exit 1 (and list them) while a media session is being created or running on this computer",
  "  clear --force --confirm " + OPERATION_LOCK_FORCE_CONFIRMATION + "   remove it even though the holder looks alive",
].join("\n");

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min ${seconds % 60}s` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * The launchers' pre-stop check (scripts/windows/stop.bat, scripts/macos/stop.sh): never kill the
 * server while an export/import/schema migration is genuinely running -- an interrupted import or
 * migration is exactly what leaves a stuck lock. Waits while a RUNNING holder has the lock; a lock
 * whose holder is gone does not block stopping (nothing is running; it is reported, never cleared).
 * Exit 0 = safe to stop, 1 = still running after the timeout.
 */
async function waitIdle(
  args: string[],
  client: SqlExecutor,
  log: (line: string) => void,
  probe: ((pid: number) => boolean) | undefined,
  timing: { sleep: (ms: number) => Promise<void>; now: () => number }
): Promise<number> {
  const timeoutIndex = args.indexOf("--timeout");
  const timeoutSeconds = timeoutIndex >= 0 ? Number(args[timeoutIndex + 1]) : 120;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
    log("--timeout must be a number of seconds.");
    return 2;
  }
  const deadline = timing.now() + timeoutSeconds * 1000;
  let announced = false;
  for (;;) {
    const lock = await getOperationLock(client);
    if (!lock) return 0;
    const status = describeOperationLock(lock, timing.now(), probe);
    if (status.stale) {
      log(
        `A ${lock.operationType} lock left by an interrupted run (process ${lock.holderPid} is gone) is present; ` +
          "it does not block stopping. Clear it with `npm run operation-lock -- clear` or on the app's /recovery page."
      );
      return 0;
    }
    if (timing.now() >= deadline) {
      log(`A ${lock.operationType} operation (process ${lock.holderPid}) is still running after ${timeoutSeconds}s; not stopping the app.`);
      return 1;
    }
    if (!announced) {
      log(`Waiting for the running ${lock.operationType} operation (process ${lock.holderPid}) to finish...`);
      announced = true;
    }
    await timing.sleep(1_000);
  }
}

/** The statuses in which this computer owns, or is creating, a pod: stopping the app terminates it (AC-P14-09). */
const ACTIVE_MEDIA_SESSION_STATUSES = ["approved", "starting", "running", "stopping"] as const;

/**
 * FO-MSG-0013 §2: the stop launchers' second check. Stopping the app terminates every pod this computer runs and fails the jobs
 * queued on it (twice on 2026-10-06, both by a restart to load a new build), so stopping is refused while a media session is being
 * created or running here. `media_sessions` is device-local, so only this computer's sessions count. Exit 0 = none (also on a
 * database from before media sessions existed), 1 = some are active (listed).
 */
async function mediaIdle(client: SqlExecutor, log: (line: string) => void): Promise<number> {
  let rows: Array<Record<string, unknown>>;
  try {
    const result = (await client.execute({
      sql: `SELECT id, status, channel_id FROM media_sessions WHERE status IN (${ACTIVE_MEDIA_SESSION_STATUSES.map(() => "?").join(", ")}) ORDER BY created_at`,
      args: [...ACTIVE_MEDIA_SESSION_STATUSES],
    })) as { rows: Array<Record<string, unknown>> };
    rows = result.rows;
  } catch (error) {
    if (/no such table/i.test(error instanceof Error ? error.message : String(error))) return 0;
    throw error;
  }
  if (rows.length === 0) return 0;
  log(`${rows.length} media session(s) are active on this computer: ${rows.map((row) => `${String(row.id)} (${String(row.status)}, channel ${String(row.channel_id)})`).join("; ")}.`);
  log("Stopping the app now would terminate their pods and fail their queued jobs. Wait until they finish, stop them in Production, or stop with --force.");
  return 1;
}

/** Returns the process exit code; prints through `log` so tests can capture it. */
export async function runOperationLockCli(
  args: string[],
  client: SqlExecutor,
  log: (line: string) => void,
  probe?: (pid: number) => boolean,
  timing: { sleep: (ms: number) => Promise<void>; now: () => number } = {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  }
): Promise<number> {
  const [command, ...rest] = args;
  if (command === "wait-idle") return waitIdle(rest, client, log, probe, timing);
  if (command === "media-idle") return mediaIdle(client, log);
  if (command !== "status" && command !== "clear") {
    log(HELP);
    return command === undefined || command === "help" || command === "--help" ? 0 : 2;
  }

  const lock = await getOperationLock(client);
  if (!lock) {
    log("No operation is holding the device lock.");
    return 0;
  }
  const status = describeOperationLock(lock, Date.now(), probe);
  log(
    `${lock.operationType} lock held since ${lock.acquiredAt} (${formatElapsed(status.elapsedMs)} ago) by process ${lock.holderPid}, ` +
      (status.holderAlive ? "which is still running." : "which is no longer running (stale).")
  );
  if (command === "status") return 0;

  const force = rest.includes("--force");
  const confirmIndex = rest.indexOf("--confirm");
  const confirmation = confirmIndex >= 0 ? rest[confirmIndex + 1] : undefined;
  if (force && confirmation !== OPERATION_LOCK_FORCE_CONFIRMATION) {
    log(`--force also requires --confirm ${OPERATION_LOCK_FORCE_CONFIRMATION}.`);
    return 2;
  }

  const result = await clearOperationLockIfUnchanged(client, lock, { force, probe });
  switch (result.outcome) {
    case "cleared":
      log("Lock cleared. Start the app again; any interrupted operation is simply re-run.");
      return 0;
    case "not_held":
      log("The lock was already released.");
      return 0;
    case "changed":
      log("The lock changed while this command ran; run status and review it.");
      return 1;
    case "holder_alive":
      log(
        "The holder process is still running, so the lock was NOT cleared. If you are sure it is stuck " +
          `(for example the process id was reused), re-run with --force --confirm ${OPERATION_LOCK_FORCE_CONFIRMATION}.`
      );
      return 1;
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  // `createClient` creates an empty file when none exists, and db.ts treats a pre-existing file as
  // "this device already has data" (it would skip the legacy-database migration) -- so never open a
  // database that is not there yet.
  if (!existsSync(getProductionAppPaths().dbPath)) {
    console.log("No database exists yet, so no operation lock is held.");
    process.exit(0);
  }
  const client = createLibsqlClient({ url: `file:${getProductionAppPaths().dbPath}` });
  runOperationLockCli(process.argv.slice(2), client, (line) => console.log(line))
    .then((code) => {
      client.close();
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      client.close();
      process.exitCode = 3; // could not check (distinct from 1 = "still busy" for wait-idle)
    });
}
