import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getDeviceSyncRunner } from "@/lib/device-sync";
import { deviceSyncErrorResponse } from "../shared";

/** "Sync now": one scheduler tick right away, skipping only the minimum export interval. Every
 * other precondition of an automatic tick still applies (DEVICE_AUTO_SYNC_PLAN.md §3.3). */
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await getDeviceSyncRunner().tick({ force: true }));
  } catch (error) {
    return deviceSyncErrorResponse(error);
  }
}
