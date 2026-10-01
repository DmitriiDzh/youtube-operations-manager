import { createClient } from "@libsql/client";
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
//
// Opens the database file directly -- it never imports src/lib/db.ts, whose initialization is
// exactly what fails while the lock is stuck. Only ever reads/deletes the one operation-lock row.

const HELP = [
  "Usage: npm run operation-lock -- <status | clear> [--force --confirm " + OPERATION_LOCK_FORCE_CONFIRMATION + "]",
  "  status   show the device operation lock, how long it has been held, and whether its process still runs",
  "  clear    remove the lock when its holder process is no longer running",
  "  clear --force --confirm " + OPERATION_LOCK_FORCE_CONFIRMATION + "   remove it even though the holder looks alive",
].join("\n");

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min ${seconds % 60}s` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Returns the process exit code; prints through `log` so tests can capture it. */
export async function runOperationLockCli(
  args: string[],
  client: SqlExecutor,
  log: (line: string) => void,
  probe?: (pid: number) => boolean
): Promise<number> {
  const [command, ...rest] = args;
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
  const client = createClient({ url: `file:${getProductionAppPaths().dbPath}` });
  runOperationLockCli(process.argv.slice(2), client, (line) => console.log(line))
    .then((code) => {
      client.close();
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      client.close();
      process.exitCode = 1;
    });
}
