import { NextResponse } from "next/server";
import { parseRangeDays } from "@/lib/live-analytics/contracts";
import { defaultLiveStreamRouteDeps, liveStreamHandler, type LiveStreamRouteDeps } from "../shared";

// BL-213 (LIVE_ANALYTICS_PLAN.md stage 3): the «Эфиры» summary over the last `days` (1..90, default 7). A read of what this
// computer stored; never a YouTube call.
export function createLiveStreamAnalyticsGetHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId, request }) => {
    const days = parseRangeDays(new URL(request.url).searchParams.get("days"));
    if (days === null) return NextResponse.json({ error: "validation_failed", message: "days must be a whole number from 1 to 90" }, { status: 400 });
    return NextResponse.json(await core.liveAnalytics(channelId, days));
  });
}

export const GET = createLiveStreamAnalyticsGetHandler();
