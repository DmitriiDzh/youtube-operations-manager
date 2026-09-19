import path from "node:path";
import { NextResponse } from "next/server";
import { rawSqlClient, appDataPaths, SCHEMA_CURRENT_VERSION } from "@/lib/db";
import { createBootstrapConfigStore, BootstrapConfigError } from "@/lib/bootstrap-config";
import { SnapshotError } from "@/lib/snapshot";
import { SchemaVersionError } from "@/lib/schema-versioning";
import { OperationLockError } from "@/lib/operation-lock";
import { RecoveryModeError } from "@/lib/device-handoff";
import { DatabaseBackupError } from "@/lib/db-backup";

const bootstrapConfigStore = createBootstrapConfigStore(appDataPaths.bootstrapConfigPath);

/**
 * Where published snapshots actually live: the operator-configured Syncthing-shared folder
 * when one is set (this is what makes a snapshot visible to the other device at all), falling
 * back to the local app-data snapshots directory for a "local-only, no Syncthing configured
 * yet" mode (export/import still work for testing, they just never leave this device).
 */
export async function resolveSnapshotsDir(): Promise<string> {
  const config = await bootstrapConfigStore.ensureExists();
  return config.syncthingRootPath ?? appDataPaths.snapshotsDir;
}

export function resolveWorkingDir(): string {
  return path.join(appDataPaths.appDataDir, "import-work");
}

// RISK-18 (docs/TECHNICAL_DEBT.md): every real snapshot id is a `randomUUID()`
// (src/lib/snapshot/services.ts). A caller must reject anything else *before* joining it into a
// filesystem path -- otherwise a value like "../../../../some/other/dir" resolves outside the
// intended snapshots directory.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidSnapshotId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export { bootstrapConfigStore, rawSqlClient, appDataPaths, SCHEMA_CURRENT_VERSION };

const ERROR_STATUS: Record<string, number> = {
  operation_lock_held: 409,
  device_in_recovery_mode: 423,
  snapshot_incomplete: 422,
  snapshot_checksum_mismatch: 422,
  snapshot_file_missing: 422,
  snapshot_divergent_lineage: 409,
  snapshot_manifest_invalid: 422,
  snapshot_already_exists: 409,
  schema_version_unsupported: 409,
  bootstrap_config_invalid: 500,
  backup_destination_exists: 409,
};

// Explicit instanceof checks against exactly these known error classes -- NOT "any object
// with a string .code property", which would also match a raw libsql driver error (e.g.
// SQLITE_BUSY) or a Node fs error (e.g. ENOENT/EACCES, which embeds a real local file path in
// its message) and echo its internal detail into the HTTP response as if it were one of this
// module's own stable, documented error codes (the exact anti-pattern comments in
// mcp/server.ts and cli/video-metadata.ts already call out and avoid -- independent review,
// second cycle).
function isKnownDeviceHandoffError(
  error: unknown
): error is { code: string; message: string; details?: unknown } {
  return (
    error instanceof SnapshotError ||
    error instanceof SchemaVersionError ||
    error instanceof RecoveryModeError ||
    error instanceof OperationLockError ||
    error instanceof DatabaseBackupError ||
    error instanceof BootstrapConfigError
  );
}

export function deviceHandoffErrorResponse(error: unknown) {
  if (isKnownDeviceHandoffError(error)) {
    const status = ERROR_STATUS[error.code] ?? 500;
    return NextResponse.json(
      { error: error.code, message: error.message ?? "Error", details: error.details },
      { status }
    );
  }
  return NextResponse.json(
    { error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" },
    { status: 500 }
  );
}
