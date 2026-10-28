import { NextResponse } from "next/server";
import { defaultWeeklyBuildRouteDeps, weeklyBuildHandler, type WeeklyBuildRouteDeps } from "./shared";

// BL-231: readiness + the factory's status of the weekly build (runs `check` when needed and `13 status --json`).
export function createWeeklyBuildGetHandler(deps: WeeklyBuildRouteDeps = defaultWeeklyBuildRouteDeps()) {
  return weeklyBuildHandler(deps, async ({ core, channelId }) => NextResponse.json(await core.view(channelId)));
}

export const GET = createWeeklyBuildGetHandler();
