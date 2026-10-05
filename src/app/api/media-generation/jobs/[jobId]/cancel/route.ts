import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaParamsHandler, type MediaRouteDeps } from "../../../shared";

export function createJobCancelHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaParamsHandler<{ jobId: string }>(deps, async ({ core, params }) => NextResponse.json({ job: await core.cancelJob({ jobId: params.jobId }) }));
}

export const POST = createJobCancelHandler();
