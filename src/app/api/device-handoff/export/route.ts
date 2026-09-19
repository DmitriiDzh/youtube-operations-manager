import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { exportHandoff } from "@/lib/device-handoff";
import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import {
  appDataPaths,
  rawSqlClient,
  SCHEMA_CURRENT_VERSION,
  resolveSnapshotsDir,
  deviceHandoffErrorResponse,
} from "../shared";

/**
 * "Finish work on this device / Export handoff" (task §3E). Never claims to prove this or the
 * other device's process has stopped -- see docs/RELEASE_LAYOUT.md's setup procedure for the
 * exact wording shown to the operator.
 */
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const bootstrapConfigStore = createBootstrapConfigStore(appDataPaths.bootstrapConfigPath);
    const config = await bootstrapConfigStore.ensureExists();
    const snapshotsDir = await resolveSnapshotsDir();

    const result = await exportHandoff({
      client: rawSqlClient,
      snapshotsDir,
      deviceId: config.deviceId,
      schemaVersion: SCHEMA_CURRENT_VERSION,
    });

    return NextResponse.json({
      snapshotId: result.manifest.snapshotId,
      generation: result.manifest.generation,
      createdAt: result.manifest.createdAt,
      unresolvedAtExportTime: result.unresolvedAtExportTime,
      snapshotsDir,
    });
  } catch (error) {
    return deviceHandoffErrorResponse(error);
  }
}
