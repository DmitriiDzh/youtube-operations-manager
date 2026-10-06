import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, type MediaRouteDeps } from "../shared";

// BL-133 (docs/roadmap/plans/FACTORY_GPU_SESSIONS_PLAN.md §2.5): the capacity log -- every pod start attempt, newest first.
// Read-only, local.

export function createCapacityGetHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => NextResponse.json({ attempts: await core.listCapacityAttempts({ limit: 200 }) }));
}

export const GET = createCapacityGetHandler();
