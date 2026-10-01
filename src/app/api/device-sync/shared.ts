import { NextResponse } from "next/server";
import { DeviceSyncError } from "@/lib/device-sync";
import { deviceHandoffErrorResponse } from "../device-handoff/shared";

const DEVICE_SYNC_ERROR_STATUS: Record<DeviceSyncError["code"], number> = {
  device_sync_not_configured: 409,
  device_sync_folder_unreachable: 409,
  device_sync_busy: 409,
  device_sync_snapshot_not_found: 404,
  device_sync_invalid_request: 400,
};

/** This feature's own errors, then the device-handoff/snapshot ones its actions can raise. */
export function deviceSyncErrorResponse(error: unknown) {
  if (error instanceof DeviceSyncError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: DEVICE_SYNC_ERROR_STATUS[error.code] });
  }
  return deviceHandoffErrorResponse(error);
}
