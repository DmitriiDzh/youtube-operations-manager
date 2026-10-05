import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, type MediaRouteDeps } from "../shared";

export function createOverviewGetHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => NextResponse.json(await core.getOverview()));
}

export const GET = createOverviewGetHandler();
