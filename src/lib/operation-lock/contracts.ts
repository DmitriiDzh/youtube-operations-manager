import type { SqlExecutor } from "@/lib/db-backup/contracts";

export type { SqlExecutor };

export type OperationType = "export" | "import" | "migration";

export type OperationLock = {
  id: "singleton";
  operationType: OperationType;
  holderPid: number;
  acquiredAt: string;
};

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
        `(started ${details.heldBy.acquiredAt}, pid ${details.heldBy.holderPid}).${staleNote}`
    );
    this.name = "OperationLockError";
    this.code = "operation_lock_held";
    this.details = details;
  }
}
