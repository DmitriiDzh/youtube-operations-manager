import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getDeviceSyncRunner } from "@/lib/device-sync";
import { isValidSnapshotId } from "../../device-handoff/shared";
import { deviceSyncErrorResponse } from "../shared";

/**
 * Resolves a divergence by an explicit human choice (DEVICE_AUTO_SYNC_PLAN.md §3.6). Body:
 * `{ choice: "keep_mine" | "take_theirs", snapshotId }` -- `snapshotId` is the other computer's
 * snapshot the divergence notice named; the runner re-reads it from the sync folder and refuses
 * anything that is not another device's published snapshot.
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: { choice?: unknown; snapshotId?: unknown } | null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "Body must be JSON" }, { status: 400 });
  }
  const choice = body?.choice;
  const snapshotId = body?.snapshotId;
  if (choice !== "keep_mine" && choice !== "take_theirs") {
    return NextResponse.json({ error: "invalid_request", message: 'choice must be "keep_mine" or "take_theirs"' }, { status: 400 });
  }
  if (!isValidSnapshotId(snapshotId)) {
    return NextResponse.json({ error: "invalid_request", message: "snapshotId must be a UUID" }, { status: 400 });
  }
  try {
    const runner = getDeviceSyncRunner();
    const status = choice === "keep_mine" ? await runner.keepMine(snapshotId) : await runner.takeTheirs(snapshotId);
    return NextResponse.json(status);
  } catch (error) {
    return deviceSyncErrorResponse(error);
  }
}
