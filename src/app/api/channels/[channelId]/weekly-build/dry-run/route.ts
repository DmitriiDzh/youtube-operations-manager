import { NextResponse } from "next/server";
import { defaultWeeklyBuildRouteDeps, readBuildBody, weeklyBuildHandler, type WeeklyBuildRouteDeps } from "../shared";

// BL-231: what a start would do (`13 auto --dry-run --json`) -- shown in the confirmation; nothing is built or written.
export function createWeeklyBuildDryRunHandler(deps: WeeklyBuildRouteDeps = defaultWeeklyBuildRouteDeps()) {
  return weeklyBuildHandler(deps, async ({ core, channelId, request }) => NextResponse.json(await core.dryRun(channelId, await readBuildBody(request))));
}

export const POST = createWeeklyBuildDryRunHandler();
