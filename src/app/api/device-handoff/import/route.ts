import path from "node:path";
import { mkdir } from "node:fs/promises";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { importHandoff } from "@/lib/device-handoff";
import {
  appDataPaths,
  rawSqlClient,
  resolveSnapshotsDir,
  resolveWorkingDir,
  deviceHandoffErrorResponse,
  isValidSnapshotId,
} from "../shared";

/**
 * "Continue work on this device / Import handoff" (task §3E). Body: { snapshotId }.
 * See src/lib/device-handoff/services.ts's importHandoff for the full procedure. A snapshot
 * with unresolved execution-state rows still activates -- the response's `status` tells the
 * UI whether the device is now in restricted recovery mode.
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "Body must be JSON" }, { status: 400 });
  }
  const snapshotId = (body as { snapshotId?: unknown } | null)?.snapshotId;
  if (typeof snapshotId !== "string" || snapshotId.length === 0) {
    return NextResponse.json(
      { error: "invalid_request", message: "snapshotId is required" },
      { status: 400 }
    );
  }
  if (!isValidSnapshotId(snapshotId)) {
    return NextResponse.json(
      { error: "invalid_request", message: "snapshotId must be a UUID" },
      { status: 400 }
    );
  }

  try {
    const snapshotsDir = await resolveSnapshotsDir();
    const workingDir = resolveWorkingDir();
    await mkdir(workingDir, { recursive: true });
    await mkdir(appDataPaths.migrationBackupsDir, { recursive: true });

    const result = await importHandoff({
      liveClient: rawSqlClient,
      snapshotDir: path.join(snapshotsDir, snapshotId),
      migrationBackupsDir: appDataPaths.migrationBackupsDir,
      workingDir,
    });

    return NextResponse.json(result);
  } catch (error) {
    return deviceHandoffErrorResponse(error);
  }
}
