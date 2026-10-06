import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, type MediaRouteDeps } from "../../shared";

// BL-136 (owner, Telegram 2026-10-06, msg 1709): what occupies the network volume (models / exchange / other), summed from one
// S3 listing of the whole volume, for the Models tab's space bar -- RunPod's volume API does not report used space. Read-only.

export function createStorageUsageGetHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => NextResponse.json({ usage: await core.volumeUsage() }));
}

export const GET = createStorageUsageGetHandler();
