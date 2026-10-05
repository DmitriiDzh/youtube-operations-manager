import type { SqlExecutor } from "@/lib/db-backup/contracts";
import type { SnapshotManifest } from "@/lib/snapshot";
import type { UnresolvedExecutionRow } from "@/lib/device-mutation-gate";
// Moved to `src/lib/device-mutation-gate` (architecture audit M5); re-exported unchanged.
export { RecoveryModeError } from "@/lib/device-mutation-gate";

export type { SqlExecutor, UnresolvedExecutionRow };

export type ExportHandoffResult = {
  manifest: SnapshotManifest;
  unresolvedAtExportTime: UnresolvedExecutionRow[];
};

export type ImportHandoffResult =
  | { status: "duplicate_noop"; manifest: SnapshotManifest }
  | { status: "activated_normal"; manifest: SnapshotManifest }
  | { status: "activated_recovery_mode"; manifest: SnapshotManifest; unresolved: UnresolvedExecutionRow[] };
