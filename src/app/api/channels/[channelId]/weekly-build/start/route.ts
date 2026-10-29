import { NextResponse } from "next/server";
import { defaultWeeklyBuildRouteDeps, readBuildBody, weeklyBuildHandler, type WeeklyBuildRouteDeps } from "../shared";

// BL-231: starts the background build (`start 13 auto --days N [--wake] --json`); `wake` = «Разбудить агента».
export function createWeeklyBuildStartHandler(deps: WeeklyBuildRouteDeps = defaultWeeklyBuildRouteDeps()) {
  return weeklyBuildHandler(deps, async ({ core, channelId, request }) => NextResponse.json(await core.start(channelId, await readBuildBody(request))));
}

export const POST = createWeeklyBuildStartHandler();
