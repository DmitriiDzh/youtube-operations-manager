import type { SqlExecutor } from "@/lib/db-backup/contracts";

export type { SqlExecutor };

export type OperationType = "export" | "import" | "migration";

export type OperationLock = {
  id: "singleton";
  operationType: OperationType;
  holderPid: number;
  acquiredAt: string;
};

/** What an operator needs to judge a held lock: how long it has been held and whether the holder
 * process still exists on this machine. `stale` is a diagnostic only -- it never releases anything. */
export type OperationLockStatus = {
  lock: OperationLock;
  elapsedMs: number;
  holderAlive: boolean;
  stale: boolean;
};

/** The exact lock the operator was shown -- clearing is compare-and-delete against all three, so a
 * lock someone else took between "display" and "click" is never removed by mistake. */
export type OperationLockIdentity = Pick<OperationLock, "operationType" | "holderPid" | "acquiredAt">;

export type ClearOperationLockOutcome =
  | { outcome: "cleared" }
  | { outcome: "not_held" }
  | { outcome: "changed"; current: OperationLock }
  | { outcome: "holder_alive"; current: OperationLock };

/** The word an operator must type to clear a lock whose holder process still appears to be running. */
export const OPERATION_LOCK_FORCE_CONFIRMATION = "CLEAR";

/** Where the operator can clear a stuck lock when the app itself cannot finish starting. */
export const OPERATION_LOCK_RECOVERY_HINT =
  "To clear it, open the /recovery page of the web app, or run `npm run operation-lock -- status` " +
  "(then `npm run operation-lock -- clear`) from the project folder.";

export class OperationLockError extends Error {
  code: "operation_lock_held";
  details: { heldBy: OperationLock; stale: boolean };

  constructor(details: { heldBy: OperationLock; stale: boolean }) {
    const staleNote = details.stale
      ? " The holder process no longer appears to be running on this machine (stale lock) -- " +
        "this is never auto-released; an operator must explicitly clear it."
      : "";
    super(
      `A ${details.heldBy.operationType} operation is already in progress ` +
        `(started ${details.heldBy.acquiredAt}, pid ${details.heldBy.holderPid}).${staleNote} ${OPERATION_LOCK_RECOVERY_HINT}`
    );
    this.name = "OperationLockError";
    this.code = "operation_lock_held";
    this.details = details;
  }
}
