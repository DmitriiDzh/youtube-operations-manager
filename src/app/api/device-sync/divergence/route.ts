import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getDeviceSyncRunner } from "@/lib/device-sync";
import { isValidSnapshotId } from "../../device-handoff/shared";
import { deviceSyncErrorResponse } from "../shared";

/**
 * What a divergence is between, for the Merge tab (owner, Telegram 2026-10-06, msg 1758):
 * `?snapshotId=` names the other computer's conflicting snapshot from the bell's notice. Read-only --
 * the runner compares a private copy of it with this computer's data and changes nothing.
 */
export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const snapshotId = request.nextUrl.searchParams.get("snapshotId");
  if (!isValidSnapshotId(snapshotId)) {
    return NextResponse.json({ error: "invalid_request", message: "snapshotId must be a UUID" }, { status: 400 });
  }
  try {
    return NextResponse.json(await getDeviceSyncRunner().divergencePreview(snapshotId));
  } catch (error) {
    return deviceSyncErrorResponse(error);
  }
}
