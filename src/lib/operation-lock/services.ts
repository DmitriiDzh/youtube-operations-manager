import { OperationLockError, type OperationLock, type OperationType, type SqlExecutor } from "./contracts";

const LOCK_ID = "singleton";

type ExecuteResult = { rows: Array<Record<string, unknown>> };

async function execute(client: SqlExecutor, query: string | { sql: string; args?: unknown[] }) {
  return (await client.execute(query)) as ExecuteResult;
}

function rowToLock(row: Record<string, unknown>): OperationLock {
  return {
    id: "singleton",
    operationType: row.operation_type as OperationType,
    holderPid: Number(row.holder_pid),
    acquiredAt: String(row.acquired_at),
  };
}

/**
 * A PID that no longer exists on this machine is unambiguous evidence the lock is stale --
 * this is a *diagnostic* only (per decision 2b, a stale lock is never auto-released). Uses
 * Node's documented `process.kill(pid, 0)` liveness probe, which works cross-platform (it
 * does not actually send a signal on either POSIX or Windows when the second argument is 0).
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // exists, but not ours to signal
  }
}

/** True only for "the app_operation_locks table doesn't exist yet" -- the one specific,
 * expected condition (a database that hasn't run that migration yet) this module treats as
 * "not locked" rather than propagating. Any other failure (contention, I/O, corruption) must
 * fail closed by propagating, not silently report "no lock held" -- found by independent
 * review that the original bare `catch { return null }` here failed *open* for every possible
 * error, defeating the whole point of a safety gate during exactly the transient-contention
 * window (e.g. SQLITE_BUSY) it exists to protect. */
function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table/i.test(message);
}

export async function getOperationLock(client: SqlExecutor): Promise<OperationLock | null> {
  try {
    const result = await execute(client, {
      sql: "SELECT operation_type, holder_pid, acquired_at FROM app_operation_locks WHERE id = ?",
      args: [LOCK_ID],
    });
    if (result.rows.length === 0) return null;
    return rowToLock(result.rows[0]);
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }
}

/**
 * Atomic acquire: the INSERT itself is what provides exclusivity (a second concurrent INSERT
 * against the same fixed `id` fails on the PRIMARY KEY, regardless of which process/connection
 * issues it -- this is a real SQLite-level guarantee, not merely "the first reader wins").
 */
export async function acquireOperationLock(
  client: SqlExecutor,
  operationType: OperationType
): Promise<OperationLock> {
  const lock: OperationLock = {
    id: "singleton",
    operationType,
    holderPid: process.pid,
    acquiredAt: new Date().toISOString(),
  };

  try {
    await execute(client, {
      sql: "INSERT INTO app_operation_locks (id, operation_type, holder_pid, acquired_at) VALUES (?, ?, ?, ?)",
      args: [lock.id, lock.operationType, lock.holderPid, lock.acquiredAt],
    });
    return lock;
  } catch {
    const existing = await getOperationLock(client);
    if (!existing) {
      // Row disappeared between the failed INSERT and this read (released concurrently) --
      // safe to report as a transient contention error; caller may retry.
      throw new OperationLockError({
        heldBy: lock,
        stale: false,
      });
    }
    const stale = !isProcessAlive(existing.holderPid);
    throw new OperationLockError({ heldBy: existing, stale });
  }
}

/** Releases the lock only if this process is the one holding it -- never releases another
 * process's active lock as a side effect of an unrelated call. */
export async function releaseOperationLock(client: SqlExecutor): Promise<void> {
  await execute(client, {
    sql: "DELETE FROM app_operation_locks WHERE id = ? AND holder_pid = ?",
    args: [LOCK_ID, process.pid],
  });
}

/**
 * Explicit operator override for a confirmed-stale lock. Never called automatically by any
 * export/import/migration code path -- only from an operator-triggered UI/CLI action, per
 * decision 2b's "never release a lock only by timeout" philosophy (mirrors the existing
 * `video_execution_locks` policy).
 */
export async function forceClearOperationLock(client: SqlExecutor): Promise<void> {
  await execute(client, { sql: "DELETE FROM app_operation_locks WHERE id = ?", args: [LOCK_ID] });
}

export async function withOperationLock<T>(
  client: SqlExecutor,
  operationType: OperationType,
  fn: () => Promise<T>
): Promise<T> {
  await acquireOperationLock(client, operationType);
  try {
    return await fn();
  } finally {
    await releaseOperationLock(client);
  }
}
