import type { SqlExecutor } from "@/lib/db-backup/contracts";
import type { SnapshotManifest, UnresolvedExecutionRow } from "@/lib/snapshot";

export type { SqlExecutor, UnresolvedExecutionRow };

export type ExportHandoffResult = {
  manifest: SnapshotManifest;
  unresolvedAtExportTime: UnresolvedExecutionRow[];
};

export type ImportHandoffResult =
  | { status: "duplicate_noop"; manifest: SnapshotManifest }
  | { status: "activated_normal"; manifest: SnapshotManifest }
  | { status: "activated_recovery_mode"; manifest: SnapshotManifest; unresolved: UnresolvedExecutionRow[] };

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
