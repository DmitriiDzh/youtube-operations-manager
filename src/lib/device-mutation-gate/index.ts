import type { SqlExecutor } from "@/lib/db-backup/contracts";
import { OperationLockError, describeOperationLock, getOperationLock, isProcessAlive } from "@/lib/operation-lock";

/**
 * The app-wide pre-mutation gate (architecture audit 2026-10-01, M5): previously owned by the
 * `device-handoff` feature, so src/proxy.ts (every mutating Web route), MCP, the CLI, decision-engine
 * and ai-localization all depended on that feature (and, through it, on `snapshot`) just to ask "may
 * this device mutate right now?". Extracted here, with the one read it needs, so the gate stands on
 * its own (`AGENTS.md` §M). `device-handoff` and `snapshot` re-export these names unchanged.
 */

export type { SqlExecutor };

/** Ledger statuses whose execution outcome is genuinely uncertain. */
export const UNRESOLVED_EXECUTION_STATUSES = ["APPLYING", "UNKNOWN"] as const;

export type UnresolvedExecutionRow = {
  batchId: string;
  ledgerRowId: string;
  videoId: string;
  status: string;
};

/** Read-only: batch_ledger_rows whose execution status is genuinely uncertain. Takes an already-open
 * connection (the live database, or a client opened against a staged copy). */
export async function scanForUnresolvedExecutionState(client: SqlExecutor): Promise<UnresolvedExecutionRow[]> {
  const placeholders = UNRESOLVED_EXECUTION_STATUSES.map(() => "?").join(", ");
  const result = (await client.execute({
    sql: `SELECT id, batch_id, video_id, status FROM batch_ledger_rows WHERE status IN (${placeholders})`,
    args: [...UNRESOLVED_EXECUTION_STATUSES],
  })) as { rows: Array<Record<string, unknown>> };
  return result.rows.map((row) => ({
    batchId: String(row.batch_id),
    ledgerRowId: String(row.id),
    videoId: String(row.video_id),
    status: String(row.status),
  }));
}

/**
 * Thrown by the choke points (src/proxy.ts, CLI `runCliCommand`, MCP `createMcpToolHandlers`)
 * when a mutating operation is attempted while this device has unresolved execution-state rows
 * from an imported snapshot. Deliberately NOT lifted by operator acknowledgement alone (see
 * docs/acceptance/PRE_RELEASE_CROSS_PLATFORM_ACCEPTANCE.md AC-HANDOFF-05) -- only recomputed,
 * fresh, from `batch_ledger_rows` every time; there is no cached "recovery mode" flag anywhere
 * that any action (including acknowledgement) could flip.
 */
export class RecoveryModeError extends Error {
  code: "device_in_recovery_mode";
  details: { unresolved: UnresolvedExecutionRow[] };

  constructor(unresolved: UnresolvedExecutionRow[]) {
    super(
      `This device has ${unresolved.length} unresolved batch execution row(s) (APPLYING/UNKNOWN) ` +
        "from an imported snapshot and is in restricted read-only recovery mode. Mutating " +
        "operations are refused until Phase 5's existing recovery/reconciliation mechanism " +
        "resolves them to a terminal state -- see docs/TECHNICAL_DEBT.md RISK-09."
    );
    this.name = "RecoveryModeError";
    this.code = "device_in_recovery_mode";
    this.details = { unresolved };
  }
}

/** Fresh, uncached: true iff `batch_ledger_rows` currently has any row whose execution outcome
 * is genuinely uncertain. Never a stored flag (see RecoveryModeError's own doc comment). */
export async function isDeviceInRecoveryMode(client: SqlExecutor): Promise<boolean> {
  return (await scanForUnresolvedExecutionState(client)).length > 0;
}

export async function assertNotInRecoveryMode(client: SqlExecutor): Promise<void> {
  const unresolved = await scanForUnresolvedExecutionState(client);
  if (unresolved.length > 0) throw new RecoveryModeError(unresolved);
}

/**
 * The single combined pre-mutation gate every interface choke point calls: an in-progress
 * export/import/migration blocks first, then recovery mode. Used by src/proxy.ts, the CLI's
 * `runCliCommand` and MCP's mutation wrapper -- one implementation, not three (AGENTS.md §D).
 */
export async function assertDeviceAvailableForMutation(client: SqlExecutor): Promise<void> {
  await assertNoOperationLock(client);
  await assertNotInRecoveryMode(client);
}

/**
 * Only the operation-lock half of the gate. Used for the operator's stop switches, which must work
 * in recovery mode but must NOT run while an export/import/migration holds the lock: an in-process
 * import runs its transaction on the same shared connection, so a write made meanwhile would join
 * that transaction and be silently rolled back if the import failed (architecture-audit review,
 * H4 refinement).
 */
export async function assertNoOperationLock(client: SqlExecutor): Promise<void> {
  const lock = await getOperationLock(client);
  if (lock) {
    throw new OperationLockError({ heldBy: lock, stale: describeOperationLock(lock).stale });
  }
}

/**
 * Owner msg 4556 (2026-11-16): an owner's save from the Web UI failed with "A export operation is already in progress" because
 * the automatic device-sync export held the lock for a few seconds. Before the gate refuses, wait for a live process's EXPORT to
 * finish (an export writes only the sync folder, so nothing it does is undone by waiting). An import or a migration is never waited
 * for, and a stale lock (dead holder) is not either -- both are refused at once, exactly as before. Gives up after `timeoutMs`; the
 * gate then refuses as usual.
 */
export async function waitForExportLockRelease(
  client: SqlExecutor,
  options: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; alive?: (pid: number) => boolean; now?: () => number } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollMs = options.pollMs ?? 250;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const alive = options.alive ?? isProcessAlive;
  const now = options.now ?? Date.now;
  const start = now();
  for (;;) {
    const lock = await getOperationLock(client);
    if (!lock || lock.operationType !== "export" || !alive(lock.holderPid)) return;
    if (now() - start >= timeoutMs) return;
    await sleep(pollMs);
  }
}
