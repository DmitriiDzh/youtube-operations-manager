import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getDeviceAutoSyncEnabled } from "@/lib/db";
import { getDeviceSyncRunner } from "@/lib/device-sync";
import { deviceSyncErrorResponse } from "../shared";

/** Automatic device sync status for the header bell (DEVICE_AUTO_SYNC_PLAN.md §3.7). Read-only. */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const [status, enabled] = await Promise.all([getDeviceSyncRunner().getStatus(), getDeviceAutoSyncEnabled()]);
    return NextResponse.json({ enabled, ...status });
  } catch (error) {
    return deviceSyncErrorResponse(error);
  }
}
