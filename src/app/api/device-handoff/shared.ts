import path from "node:path";
import { NextResponse } from "next/server";
import { rawSqlClient, appDataPaths, SCHEMA_CURRENT_VERSION } from "@/lib/db";
import { createBootstrapConfigStore } from "@/lib/bootstrap-config";

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

export function deviceHandoffErrorResponse(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    const typed = error as { code: string; message?: string; details?: unknown };
    const status = ERROR_STATUS[typed.code] ?? 500;
    return NextResponse.json(
      { error: typed.code, message: typed.message ?? "Error", details: typed.details },
      { status }
    );
  }
  return NextResponse.json(
    { error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" },
    { status: 500 }
  );
}
