import { NextResponse } from "next/server";
import { defaultElevenlabsRouteDeps, elevenlabsHandler, type ElevenlabsRouteDeps } from "./shared";

// BL-236: the Settings card's read -- switch, key presence (last 4 only), limits, usage, models; `?subscription=1` also reads the
// account's own character count from ElevenLabs (a free read, only when a key is stored and the media gateway is on). Recent jobs too.
export function createElevenlabsGetHandler(deps: ElevenlabsRouteDeps = defaultElevenlabsRouteDeps()) {
  return elevenlabsHandler(deps, async ({ core, request }) => {
    const subscription = new URL(request.url).searchParams.get("subscription") === "1";
    const [status, jobs] = await Promise.all([core.getStatus({ subscription }), core.getJobs({ limit: 10 })]);
    return NextResponse.json({ ...status, jobs: (jobs as { jobs?: unknown[] }).jobs ?? [] });
  });
}

export const GET = createElevenlabsGetHandler();
