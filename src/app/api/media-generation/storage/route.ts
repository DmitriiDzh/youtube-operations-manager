import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, type MediaRouteDeps } from "../shared";

// BL-132 (docs/roadmap/plans/FACTORY_MEDIA_CONTROL_PLAN.md §2.2): the network volume's rented size, use, free space and
// monthly cost, as RunPod reports it. Read-only (one RunPod API call on an explicit refresh).

export function createStorageGetHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => NextResponse.json({ storage: await core.storageStatus() }));
}

export const GET = createStorageGetHandler();
