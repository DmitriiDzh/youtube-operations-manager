import { NextResponse } from "next/server";
import { defaultWeeklyBuildRouteDeps, weeklyBuildHandler, type WeeklyBuildRouteDeps } from "../shared";

// BL-231: STOP (`13 stop`) -- the current video is finished, then the run ends.
export function createWeeklyBuildStopHandler(deps: WeeklyBuildRouteDeps = defaultWeeklyBuildRouteDeps()) {
  return weeklyBuildHandler(deps, async ({ core, channelId }) => NextResponse.json(await core.stop(channelId)));
}

export const POST = createWeeklyBuildStopHandler();
