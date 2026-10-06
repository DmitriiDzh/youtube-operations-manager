import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, type MediaRouteDeps } from "../../shared";

// BL-138 (ADR 0028): the other devices' RunPod sessions, as they last reported them through the sync folder, checked against
// RunPod's live pod list (one read), plus live session pods no device reports. Read-only.

export function createSessionDevicesGetHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => NextResponse.json(await core.listOtherDevices()));
}

export const GET = createSessionDevicesGetHandler();
